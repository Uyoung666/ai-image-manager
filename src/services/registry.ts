import { closeDatabase, getDatabase, initDatabase } from "@/db";
import { shutdownTextWorker } from "@/services/ai/text-worker-client";
import { shutdownTranslationWorker } from "@/services/ai/translation-worker-client";
import {
  closeVectorDB,
  initVectorDB,
  isAiModelLoaded,
  isVectorDBInitialized,
  loadModel,
  setEmbeddingModel,
  setIsModelLoaded,
  setLocalModelPath,
  stopEmbedding,
  warmupAiSearch,
  wasAutoRepaired,
} from "@/services/ai-embedder";
import { shutdownPool } from "@/services/embed-worker-pool";
import { repairUnassignedLibraryPhotos } from "@/services/explicit-library-folders";
import { resumeInterruptedImports } from "@/services/import-queue";
import {
  initThumbnailer,
  scheduleThumbnailMaintenance,
  stopThumbnailer,
} from "@/services/thumbnailer";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { notifyAutoIndexReady, requestAutoIndex } from "./ai-index-scheduler";
import { notifyLibraryChange } from "./library-change";
import {
  startLibraryReconciliation,
  stopLibraryReconciliation,
} from "./library-reconciliation";
import { reconcileLibrarySources } from "./library-source";

// ── Service lifecycle types ───────────────────────────────────────────

export const ServiceLevel = {
  /** App cannot function without this */
  Critical: 1,
  /** App can start but features are degraded */
  Essential: 2,
  /** Optional enhancement, failure is non-blocking */
  Optional: 3,
} as const;

export type ServiceLevel = (typeof ServiceLevel)[keyof typeof ServiceLevel];

const serviceLevelNames: Record<ServiceLevel, string> = {
  [ServiceLevel.Critical]: "Critical",
  [ServiceLevel.Essential]: "Essential",
  [ServiceLevel.Optional]: "Optional",
};

export interface ServiceHealth {
  detail?: string;
  level: ServiceLevel;
  name: string;
  status: "ok" | "degraded" | "error" | "stopped";
}

export interface ServiceDescriptor {
  /** Names of services that must be healthy before this one starts */
  dependencies?: string[];
  health: () =>
    | Omit<ServiceHealth, "name" | "level">
    | Promise<Omit<ServiceHealth, "name" | "level">>;
  level: ServiceLevel;
  name: string;
  start: () => void | Promise<void>;
  stop: () => void | Promise<void>;
}

export interface HealthReport {
  allHealthy: boolean;
  services: ServiceHealth[];
  summary: string;
}

// ── Registry ──────────────────────────────────────────────────────────

export class ServiceRegistry {
  private lifecycleGeneration = 0;
  private stopping: Promise<void> | undefined;
  private startQueue: Promise<void> = Promise.resolve();
  private readonly startupWork = new Set<Promise<unknown>>();

  get generation(): number {
    return this.lifecycleGeneration;
  }

  private isCurrentGeneration(generation: number): boolean {
    return generation === this.lifecycleGeneration && !this.stopping;
  }
  private readonly services = new Map<string, ServiceDescriptor>();
  private startOrder: string[] = [];

  register(desc: ServiceDescriptor): void {
    if (this.services.has(desc.name)) {
      throw new Error(`Service "${desc.name}" is already registered`);
    }
    this.services.set(desc.name, desc);
  }

  /** Start all registered services in dependency order. */
  start(): Promise<HealthReport> {
    return this.startStage();
  }

  /**
   * Start services filtered by max level.
   * level=Critical starts only critical services; level=Essential starts
   * critical + essential; level=Optional starts all.
   */
  startLevel(maxLevel: ServiceLevel): Promise<HealthReport> {
    return this.startStage(maxLevel);
  }

  /**
   * Start remaining registered-but-not-yet-started services.
   * Useful after staged startup inserts maintenance between levels.
   */
  startRemaining(maxLevel?: ServiceLevel): Promise<HealthReport> {
    return this.startStage(maxLevel);
  }

  private async startStage(maxLevel?: ServiceLevel): Promise<HealthReport> {
    const generation = this.lifecycleGeneration;
    if (this.stopping) {
      return this.stoppedHealth(maxLevel);
    }
    await this.startServices(generation, maxLevel);
    if (!this.isCurrentGeneration(generation)) {
      return this.stoppedHealth(maxLevel);
    }
    return this.health(maxLevel);
  }

  /** Register model checks/copies before invoking them so shutdown can drain them. */
  runStartupWork(work: () => Promise<void>): Promise<void> {
    if (this.stopping) {
      return Promise.resolve();
    }
    const generation = this.lifecycleGeneration;
    const task = Promise.resolve().then(async () => {
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      await work();
    });
    return this.trackStartupWork(task);
  }

  private trackStartupWork<T>(task: Promise<T>): Promise<T> {
    this.startupWork.add(task);
    // Handle both outcomes without creating an unhandled rejecting finally chain.
    task.then(
      () => this.startupWork.delete(task),
      () => this.startupWork.delete(task)
    );
    return task;
  }

  private startServices(
    generation: number,
    maxLevel?: ServiceLevel
  ): Promise<void> {
    const task = this.startQueue
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrentGeneration(generation)) {
          return;
        }
        await this.startServicesInOrder(generation, maxLevel);
      });
    this.startQueue = task;
    return this.trackStartupWork(task);
  }

  private async startServicesInOrder(
    generation: number,
    maxLevel?: ServiceLevel
  ): Promise<void> {
    const order = this.resolveOrder();
    const started = new Set(this.startOrder);

    for (const name of order) {
      if (!this.isCurrentGeneration(generation)) {
        return;
      }
      const svc = this.services.get(name);
      if (!svc || started.has(name)) {
        continue;
      }

      if (svc.level > (maxLevel ?? ServiceLevel.Optional)) {
        continue;
      }

      const levelLabel = serviceLevelNames[svc.level];

      try {
        console.log(`[ServiceRegistry] Starting ${name} (${levelLabel})…`);
        await svc.start();
        this.startOrder.push(name);
        started.add(name);
        if (!this.isCurrentGeneration(generation)) {
          return;
        }
        console.log(`[ServiceRegistry] ${name} started`);
      } catch (err: unknown) {
        if (!this.isCurrentGeneration(generation)) {
          // A failed native initializer may still own handles in the old directory.
          await this.stopService(svc);
          return;
        }
        const msg = (err as Error)?.message ?? String(err);
        if (svc.level === ServiceLevel.Critical) {
          console.error(
            `[ServiceRegistry] CRITICAL service "${name}" failed: ${msg}`
          );
          throw new Error(`Critical service "${name}" failed to start: ${msg}`);
        }
        // Non-critical services degrade gracefully
        console.warn(
          `[ServiceRegistry] ${name} (${levelLabel}) failed to start — degrading: ${msg}`
        );
      }
    }
  }

  /** Stop all started services in reverse order. */
  stop(): Promise<void> {
    if (this.stopping) {
      return this.stopping;
    }
    this.lifecycleGeneration++;
    const task = Promise.resolve().then(async () => {
      await Promise.allSettled([...this.startupWork]);
      await this.stopStartedServices();
    });
    this.stopping = task.finally(() => {
      this.stopping = undefined;
    });
    return this.stopping;
  }

  private async stopService(svc: ServiceDescriptor): Promise<void> {
    try {
      console.log(`[ServiceRegistry] Stopping ${svc.name}…`);
      await svc.stop();
    } catch (err: unknown) {
      console.warn(
        `[ServiceRegistry] Error stopping ${svc.name}:`,
        (err as Error)?.message
      );
    }
  }

  private async stopStartedServices(): Promise<void> {
    if (this.startOrder.includes("fileWatcher")) {
      try {
        await stopLibraryReconciliation();
      } catch (error) {
        console.warn("[ServiceRegistry] Reconciliation stop failed:", error);
      }
    }
    const toStop = [...this.startOrder].reverse();
    for (const name of toStop) {
      const svc = this.services.get(name);
      if (!svc) {
        continue;
      }
      await this.stopService(svc);
    }
    this.startOrder = [];
  }

  private stoppedHealth(
    maxLevel: ServiceLevel = ServiceLevel.Optional
  ): HealthReport {
    return {
      allHealthy: false,
      services: [...this.services.values()]
        .filter((svc) => svc.level <= maxLevel)
        .map((svc) => ({
          name: svc.name,
          level: svc.level,
          status: "stopped" as const,
        })),
      summary: "Services stopped",
    };
  }

  /** Run health checks on all registered services. */
  health(
    maxLevel: ServiceLevel = ServiceLevel.Optional
  ): Promise<HealthReport> {
    if (this.stopping) {
      return Promise.resolve(this.stoppedHealth(maxLevel));
    }
    const generation = this.lifecycleGeneration;
    const task = Promise.resolve().then(() =>
      this.isCurrentGeneration(generation)
        ? this.checkHealth(maxLevel)
        : this.stoppedHealth(maxLevel)
    );
    return this.trackStartupWork(task);
  }

  private async checkHealth(maxLevel: ServiceLevel): Promise<HealthReport> {
    const generation = this.lifecycleGeneration;
    const results: ServiceHealth[] = [];
    let allHealthy = true;

    for (const [name, svc] of this.services) {
      if (!this.isCurrentGeneration(generation)) {
        return this.stoppedHealth(maxLevel);
      }
      if (svc.level > maxLevel) {
        continue;
      }
      try {
        const h = await svc.health();
        if (!this.isCurrentGeneration(generation)) {
          return this.stoppedHealth(maxLevel);
        }
        results.push({ name, level: svc.level, ...h });
        if (h.status !== "ok") {
          allHealthy = false;
        }
      } catch (err: unknown) {
        if (!this.isCurrentGeneration(generation)) {
          return this.stoppedHealth(maxLevel);
        }
        results.push({
          name,
          level: svc.level,
          status: "error",
          detail: (err as Error)?.message ?? "health check failed",
        });
        allHealthy = false;
      }
    }

    const summary = allHealthy
      ? "All services healthy"
      : `${results.filter((r) => r.status === "error").length} service(s) in error state`;

    return { allHealthy, services: results, summary };
  }

  /** Topological sort by dependency graph. */
  private resolveOrder(): string[] {
    const services = this.services;
    const names = [...services.keys()];
    const visited = new Set<string>();
    const result: string[] = [];
    const visiting = new Set<string>();

    function visit(name: string) {
      if (visited.has(name)) {
        return;
      }
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected involving "${name}"`);
      }
      visiting.add(name);
      const svc = services.get(name);
      if (svc?.dependencies) {
        for (const dep of svc.dependencies) {
          if (!services.has(dep)) {
            throw new Error(
              `Service "${name}" depends on unknown service "${dep}"`
            );
          }
          visit(dep);
        }
      }
      visiting.delete(name);
      visited.add(name);
      result.push(name);
    }

    for (const name of names) {
      visit(name);
    }
    return result;
  }
}

// ── Singleton ─────────────────────────────────────────────────────────

export const registry = new ServiceRegistry();
let thumbnailCleanupInterval: ReturnType<typeof setInterval> | undefined;

// ── Service definitions ───────────────────────────────────────────────

registry.register({
  name: "database",
  level: ServiceLevel.Critical,
  start: () => {
    initDatabase();
    repairUnassignedLibraryPhotos();
  },
  stop: () => {
    closeDatabase();
  },
  health: () => {
    try {
      const db = getDatabase();
      // Run a cheap query to verify the connection is alive
      db.run("SELECT 1");
      return { status: "ok" as const };
    } catch {
      return { status: "error" as const, detail: "Database connection lost" };
    }
  },
});

registry.register({
  name: "thumbnailer",
  level: ServiceLevel.Critical,
  dependencies: ["database"],
  start: () => {
    initThumbnailer();
  },
  stop: stopThumbnailer,
  health: () => {
    // The thumbnailer is a thin wrapper around sharp — it cannot "fail"
    return { status: "ok" as const };
  },
});

let startupSourceController: AbortController | null = null;
let startupSourceTask: Promise<void> | null = null;

registry.register({
  name: "shootingProjects",
  level: ServiceLevel.Critical,
  dependencies: ["database"],
  start: async () => {
    const core = await import("./shooting-projects");
    const output = await import("./shooting-project-output");
    const library = await import("./shooting-project-library");
    await core.startShootingProjectServices();
    await output.startShootingProjectOutputServices();
    library.startShootingProjectLibraryServices();
  },
  stop: async () => {
    const library = await import("./shooting-project-library");
    const output = await import("./shooting-project-output");
    const core = await import("./shooting-projects");
    await library.stopShootingProjectLibraryTasks();
    await output.stopShootingProjectOutputTasks();
    await core.stopShootingProjectServices();
  },
  health: () => ({ status: "ok" as const }),
});

registry.register({
  name: "fileWatcher",
  level: ServiceLevel.Essential,
  dependencies: ["database", "thumbnailer"],
  start: () => {
    // Quickly propagate unavailable roots; online photos are checked by the
    // normal reconciliation below, so startup does not probe each file twice.
    const controller = new AbortController();
    startupSourceController = controller;
    startupSourceTask = reconcileLibrarySources({
      signal: controller.signal,
      unavailableRootsOnly: true,
    })
      .then(({ changed }) => {
        if (!controller.signal.aborted && changed > 0) {
          notifyLibraryChange(null, "status");
        }
      })
      .catch((error) => {
        console.warn("[Registry] Startup library source check failed", error);
      });

    resumeInterruptedImports();
    startLibraryReconciliation();
  },
  stop: async () => {
    startupSourceController?.abort();
    await startupSourceTask;
    startupSourceController = null;
    startupSourceTask = null;
    await stopLibraryReconciliation();
  },
  health: () => {
    return { status: "ok" as const };
  },
});

registry.register({
  name: "aiVectorDB",
  level: ServiceLevel.Optional,
  start: async () => {
    await initVectorDB();
    // If the vector DB was auto-repaired during init (corruption detected and
    // rebuilt), auto-trigger re-embedding so the user doesn't need to click
    // "AI Smart Index" manually. The embedAllPhotos progress is broadcast via
    // IPC so the sidebar AiProgressBar stays up-to-date.
    if (wasAutoRepaired) {
      console.log("[Registry] Auto-repair detected — starting auto re-index");
      const { BrowserWindow } = await import("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("ai-auto-repair-started");
      }
      requestAutoIndex("auto-repair");
    }
  },
  stop: async () => {
    await closeVectorDB();
  },
  health: () => {
    if (isVectorDBInitialized()) {
      return { status: "ok" as const };
    }
    return {
      status: "degraded" as const,
      detail: "Vector database not initialized",
    };
  },
});

registry.register({
  name: "aiModel",
  level: ServiceLevel.Optional,
  start: async () => {
    await loadModel();
    notifyAutoIndexReady();
    warmupAiSearch().catch((err) => {
      console.warn("[Registry] AI search warmup failed:", err?.message);
    });
  },
  stop: () => {
    stopEmbedding();
    // Reset model state so the next start() reloads from the
    // current getDataPath() — essential after data-path migration
    // (onboarding / settings) which moves models to a new directory.
    setIsModelLoaded(false);
    setEmbeddingModel(null);
    setLocalModelPath(null);
    shutdownTextWorker();
    shutdownTranslationWorker();
    try {
      shutdownPool();
    } catch {
      /* pool may not have been started */
    }
  },
  health: () => {
    if (isAiModelLoaded()) {
      return { status: "ok" as const };
    }
    return {
      status: "degraded" as const,
      detail: "AI embedding model not loaded",
    };
  },
});

registry.register({
  name: "httpServer",
  level: ServiceLevel.Critical,
  dependencies: ["database"],
  start: async () => {
    const { startHttpServerEarly, isHttpServerRunning } = await import(
      "@/services/http-server"
    );
    // 如果已经在 createWindow() 之前通过 startHttpServerEarly() 启动，则跳过。
    if (!isHttpServerRunning()) {
      await startHttpServerEarly();
    }
  },
  stop: async () => {
    const { stopHttpServer } = await import("@/services/http-server");
    await stopHttpServer();
  },
  health: async () => {
    const { isHttpServerRunning } = await import("@/services/http-server");
    if (isHttpServerRunning()) {
      return { status: "ok" as const };
    }
    return {
      status: "error" as const,
      detail: "HTTP server is not running",
    };
  },
});

registry.register({
  name: "thumbnailCleaner",
  level: ServiceLevel.Optional,
  start: () => {
    scheduleThumbnailMaintenance(GALLERY_CONFIG.initialDiskAuditDelayMs);

    // 每天清理一次
    const cleanupInterval = setInterval(
      () => {
        scheduleThumbnailMaintenance();
      },
      24 * 60 * 60 * 1000
    );

    // Store interval for cleanup
    thumbnailCleanupInterval = cleanupInterval;
  },
  stop: () => {
    if (thumbnailCleanupInterval) {
      clearInterval(thumbnailCleanupInterval);
      thumbnailCleanupInterval = undefined;
    }
  },
  health: () => {
    return { status: "ok" as const };
  },
});
