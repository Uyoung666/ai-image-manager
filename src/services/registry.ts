import { closeDatabase, getDatabase, initDatabase } from "@/db";
import {
  closeVectorDB,
  embedAllPhotos,
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
import { shutdownTextWorker } from "@/services/ai/text-worker-client";
import {
  cleanupOrphanedRecordsAsync,
  startWatching,
  stopScanning,
  stopWatching,
} from "@/services/indexer";
import {
  checkAndCleanDiskCache,
  initThumbnailer,
} from "@/services/thumbnailer";

// ── Service lifecycle types ───────────────────────────────────────────

export enum ServiceLevel {
  /** App cannot function without this */
  Critical = 1,
  /** App can start but features are degraded */
  Essential = 2,
  /** Optional enhancement, failure is non-blocking */
  Optional = 3,
}

export interface ServiceHealth {
  detail?: string;
  level: ServiceLevel;
  name: string;
  status: "ok" | "degraded" | "error" | "stopped";
}

export interface ServiceDescriptor {
  /** Names of services that must be healthy before this one starts */
  dependencies?: string[];
  health: () => Promise<Omit<ServiceHealth, "name" | "level">>;
  level: ServiceLevel;
  name: string;
  start: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface HealthReport {
  allHealthy: boolean;
  services: ServiceHealth[];
  summary: string;
}

// ── Registry ──────────────────────────────────────────────────────────

class ServiceRegistry {
  private services = new Map<string, ServiceDescriptor>();
  private startOrder: string[] = [];

  register(desc: ServiceDescriptor): void {
    if (this.services.has(desc.name)) {
      throw new Error(`Service "${desc.name}" is already registered`);
    }
    this.services.set(desc.name, desc);
  }

  /** Start all registered services in dependency order. */
  async start(): Promise<HealthReport> {
    await this.startServices({});
    return this.health();
  }

  /**
   * Start services filtered by max level.
   * level=Critical starts only critical services; level=Essential starts
   * critical + essential; level=Optional starts all.
   */
  async startLevel(maxLevel: ServiceLevel): Promise<HealthReport> {
    await this.startServices({ maxLevel });
    return this.health();
  }

  /**
   * Start remaining registered-but-not-yet-started services.
   * Useful after staged startup inserts maintenance between levels.
   */
  async startRemaining(): Promise<HealthReport> {
    await this.startServices({ skipStarted: true });
    return this.health();
  }

  private async startServices(opts: {
    maxLevel?: ServiceLevel;
    skipStarted?: boolean;
  }): Promise<void> {
    const order = this.resolveOrder();
    const started = new Set(this.startOrder);

    for (const name of order) {
      if (opts.skipStarted && started.has(name)) {
        continue;
      }

      const svc = this.services.get(name)!;

      if (opts.maxLevel !== undefined && svc.level > opts.maxLevel) {
        continue;
      }

      const levelLabel = ServiceLevel[svc.level];

      try {
        console.log(`[ServiceRegistry] Starting ${name} (${levelLabel})…`);
        await svc.start();
        this.startOrder.push(name);
        console.log(`[ServiceRegistry] ${name} started`);
      } catch (err: unknown) {
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
  async stop(): Promise<void> {
    const toStop = [...this.startOrder].reverse();
    for (const name of toStop) {
      const svc = this.services.get(name);
      if (!svc) {
        continue;
      }
      try {
        console.log(`[ServiceRegistry] Stopping ${name}…`);
        await svc.stop();
      } catch (err: unknown) {
        console.warn(
          `[ServiceRegistry] Error stopping ${name}:`,
          (err as Error)?.message
        );
      }
    }
    this.startOrder = [];
  }

  /** Run health checks on all registered services. */
  async health(): Promise<HealthReport> {
    const results: ServiceHealth[] = [];
    let allHealthy = true;

    for (const [name, svc] of this.services) {
      try {
        const h = await svc.health();
        results.push({ name, level: svc.level, ...h });
        if (h.status !== "ok") {
          allHealthy = false;
        }
      } catch (err: unknown) {
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
    const names = [...this.services.keys()];
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
      const svc = registry.services.get(name);
      if (svc?.dependencies) {
        for (const dep of svc.dependencies) {
          if (!registry.services.has(dep)) {
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

// ── Service definitions ───────────────────────────────────────────────

registry.register({
  name: "database",
  level: ServiceLevel.Critical,
  start: async () => {
    initDatabase();
  },
  stop: async () => {
    closeDatabase();
  },
  health: async () => {
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
  start: async () => {
    initThumbnailer();
  },
  stop: async () => {
    // Thumbnails are file-based; no explicit cleanup needed
  },
  health: async () => {
    // The thumbnailer is a thin wrapper around sharp — it cannot "fail"
    return { status: "ok" as const };
  },
});

registry.register({
  name: "fileWatcher",
  level: ServiceLevel.Essential,
  dependencies: ["database", "thumbnailer"],
  start: async () => {
    const { BrowserWindow } = await import("electron");

    // 启动时清理孤立记录（fire-and-forget，不阻塞启动）
    cleanupOrphanedRecordsAsync().then(({ removed }) => {
      if (removed > 0) {
        console.log(
          `[Registry] Cleaned up ${removed} orphaned records on startup`
        );
      }
    });

    startWatching((photoId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("file-change", { type: event, photoId });
      }
    });
  },
  stop: async () => {
    stopScanning();
    await stopWatching();
  },
  health: async () => {
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
      embedAllPhotos((aiProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("ai-progress", aiProgress);
        }
      })
        .then((count) => {
          if (count > 0) {
            console.log(`[Registry] Auto re-index complete: ${count} photos`);
          }
        })
        .catch((err) => {
          console.warn("[Registry] Auto re-index failed:", err?.message);
        });
    }
  },
  stop: async () => {
    await closeVectorDB();
  },
  health: async () => {
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
    warmupAiSearch().catch((err) => {
      console.warn("[Registry] AI search warmup failed:", err?.message);
    });
  },
  stop: async () => {
    stopEmbedding();
    // Reset model state so the next start() reloads from the
    // current getDataPath() — essential after data-path migration
    // (onboarding / settings) which moves models to a new directory.
    setIsModelLoaded(false);
    setEmbeddingModel(null);
    setLocalModelPath(null);
    shutdownTextWorker();
    try {
      shutdownPool();
    } catch {
      /* pool may not have been started */
    }
  },
  health: async () => {
    if (isAiModelLoaded()) {
      return { status: "ok" as const };
    }
    return {
      status: "degraded" as const,
      detail: "CLIP model not loaded",
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
  start: async () => {
    // 启动时清理一次
    const result = await checkAndCleanDiskCache();
    if (result.cleaned) {
      console.log(
        `[Registry] Thumbnail cache cleaned on startup: ${result.filesRemoved} files, ${result.freedMB.toFixed(1)}MB freed`
      );
    }

    // 每天清理一次
    const cleanupInterval = setInterval(
      () => {
        checkAndCleanDiskCache()
          .then((result) => {
            if (result.cleaned) {
              console.log(
                `[Registry] Thumbnail cache cleaned: ${result.filesRemoved} files, ${result.freedMB.toFixed(1)}MB freed`
              );
            }
          })
          .catch(() => {});
      },
      24 * 60 * 60 * 1000
    );

    // Store interval for cleanup
    (global as any).__thumbnailCleanupInterval = cleanupInterval;
  },
  stop: async () => {
    const interval = (global as any).__thumbnailCleanupInterval;
    if (interval) {
      clearInterval(interval);
      delete (global as any).__thumbnailCleanupInterval;
    }
  },
  health: async () => {
    return { status: "ok" as const };
  },
});
