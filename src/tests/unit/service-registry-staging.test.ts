/** @vitest-environment node */
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@/db", () => ({
  closeDatabase: vi.fn(),
  getDatabase: vi.fn(),
  initDatabase: vi.fn(),
}));
vi.mock("@/services/ai/text-worker-client", () => ({
  shutdownTextWorker: vi.fn(),
}));
vi.mock("@/services/ai/translation-worker-client", () => ({
  shutdownTranslationWorker: vi.fn(),
}));
vi.mock("@/services/ai-embedder", () => ({
  closeVectorDB: vi.fn(),
  initVectorDB: vi.fn(),
  isAiModelLoaded: vi.fn(),
  isVectorDBInitialized: vi.fn(),
  loadModel: vi.fn(),
  setEmbeddingModel: vi.fn(),
  setIsModelLoaded: vi.fn(),
  setLocalModelPath: vi.fn(),
  stopEmbedding: vi.fn(),
  warmupAiSearch: vi.fn(),
  wasAutoRepaired: false,
}));
vi.mock("@/services/embed-worker-pool", () => ({ shutdownPool: vi.fn() }));
vi.mock("@/services/explicit-library-folders", () => ({
  repairUnassignedLibraryPhotos: vi.fn(),
}));
vi.mock("@/services/import-queue", () => ({
  resumeInterruptedImports: vi.fn(),
}));
vi.mock("@/services/thumbnailer", () => ({
  initThumbnailer: vi.fn(),
  scheduleThumbnailMaintenance: vi.fn(),
  stopThumbnailer: vi.fn(),
}));
vi.mock("@/services/ai-index-scheduler", () => ({
  notifyAutoIndexReady: vi.fn(),
  requestAutoIndex: vi.fn(),
}));
vi.mock("@/services/library-change", () => ({ notifyLibraryChange: vi.fn() }));
vi.mock("@/services/library-reconciliation", () => ({
  startLibraryReconciliation: vi.fn(),
  stopLibraryReconciliation: vi.fn(),
}));
vi.mock("@/services/library-source", () => ({
  reconcileLibrarySources: vi.fn(),
}));

import {
  type ServiceDescriptor,
  ServiceLevel,
  ServiceRegistry,
} from "@/services/registry";

afterEach(() => vi.restoreAllMocks());

function createService(
  events: string[],
  name: string,
  level: ServiceDescriptor["level"],
  dependencies: string[] = []
): ServiceDescriptor {
  let started = false;
  return {
    name,
    level,
    dependencies,
    start: vi.fn(() => {
      started = true;
      events.push(`start:${name}`);
    }),
    stop: vi.fn(() => {
      started = false;
      events.push(`stop:${name}`);
    }),
    health: vi.fn(() => ({
      status: started ? ("ok" as const) : ("stopped" as const),
    })),
  };
}

it("starts Critical, Essential, then Optional without restarting earlier stages", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  const sources = createService(events, "sources", ServiceLevel.Essential, [
    "catalog",
  ]);
  const model = createService(events, "model", ServiceLevel.Optional, [
    "sources",
  ]);
  // Registration order deliberately differs from dependency order.
  registry.register(model);
  registry.register(sources);
  registry.register(catalog);

  const critical = await registry.startLevel(ServiceLevel.Critical);
  expect(events).toEqual(["start:catalog"]);
  expect(critical.allHealthy).toBe(true);
  expect(critical.services.map((entry) => entry.name)).toEqual(["catalog"]);
  const essential = await registry.startRemaining(ServiceLevel.Essential);
  expect(events).toEqual(["start:catalog", "start:sources"]);
  expect(essential.allHealthy).toBe(true);
  expect(essential.services.map((entry) => entry.name)).toEqual([
    "sources",
    "catalog",
  ]);
  expect(model.health).not.toHaveBeenCalled();

  await registry.startRemaining();
  await registry.startRemaining(ServiceLevel.Optional);
  expect(events).toEqual(["start:catalog", "start:sources", "start:model"]);
  expect(catalog.start).toHaveBeenCalledTimes(1);
  expect(sources.start).toHaveBeenCalledTimes(1);
  expect(model.start).toHaveBeenCalledTimes(1);
  await registry.stop();
});

it("resolves dependencies within the Essential stage before starting dependents", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  registry.register(
    createService(events, "source-checks", ServiceLevel.Essential, ["watch"])
  );
  registry.register(
    createService(events, "watch", ServiceLevel.Essential, ["catalog"])
  );
  registry.register(createService(events, "catalog", ServiceLevel.Critical));
  await registry.startLevel(ServiceLevel.Critical);
  await registry.startRemaining(ServiceLevel.Essential);
  expect(events).toEqual([
    "start:catalog",
    "start:watch",
    "start:source-checks",
  ]);
  await registry.stop();
});

it("stops only started stages in reverse order and can restart after an early stop", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  const sources = createService(events, "sources", ServiceLevel.Essential, [
    "catalog",
  ]);
  const model = createService(events, "model", ServiceLevel.Optional, [
    "sources",
  ]);
  for (const descriptor of [model, sources, catalog]) {
    registry.register(descriptor);
  }
  await registry.startLevel(ServiceLevel.Critical);
  await registry.startRemaining(ServiceLevel.Essential);
  await registry.stop();
  expect(events).toEqual([
    "start:catalog",
    "start:sources",
    "stop:sources",
    "stop:catalog",
  ]);
  expect(model.stop).not.toHaveBeenCalled();
  events.length = 0;
  await registry.startRemaining(ServiceLevel.Essential);
  await registry.startRemaining();
  await registry.stop();
  await registry.stop();
  expect(events).toEqual([
    "start:catalog",
    "start:sources",
    "start:model",
    "stop:model",
    "stop:sources",
    "stop:catalog",
  ]);
});

it("degrades an Optional startup failure and keeps Essential services running", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  const sources = createService(events, "sources", ServiceLevel.Essential, [
    "catalog",
  ]);
  const model = createService(events, "model", ServiceLevel.Optional);
  model.start = vi.fn(() => {
    throw new Error("model unavailable");
  });
  model.health = vi.fn(() => ({
    status: "degraded" as const,
    detail: "model unavailable",
  }));
  const maintenance = createService(
    events,
    "maintenance",
    ServiceLevel.Optional
  );
  for (const descriptor of [catalog, sources, model, maintenance]) {
    registry.register(descriptor);
  }
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await registry.startLevel(ServiceLevel.Critical);
  await registry.startRemaining(ServiceLevel.Essential);
  const report = await registry.startRemaining();
  expect(report.allHealthy).toBe(false);
  expect(report.services).toContainEqual({
    name: "model",
    level: ServiceLevel.Optional,
    status: "degraded",
    detail: "model unavailable",
  });
  expect(report.services).toContainEqual({
    name: "sources",
    level: ServiceLevel.Essential,
    status: "ok",
  });
  expect(maintenance.start).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    expect.stringContaining("model unavailable")
  );
  await registry.stop();
  expect(model.stop).not.toHaveBeenCalled();
  expect(events.slice(-3)).toEqual([
    "stop:maintenance",
    "stop:sources",
    "stop:catalog",
  ]);
});

it("serializes concurrent starts without starting the same service twice", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  catalog.start = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    events.push("start:catalog");
  });
  const model = createService(events, "model", ServiceLevel.Optional, [
    "catalog",
  ]);
  registry.register(catalog);
  registry.register(model);
  const first = registry.startLevel(ServiceLevel.Critical);
  const remaining = registry.startRemaining();
  const all = registry.start();
  await entered.promise;
  expect(catalog.start).toHaveBeenCalledTimes(1);
  expect(model.start).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([first, remaining, all]);
  expect(catalog.start).toHaveBeenCalledTimes(1);
  expect(model.start).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["start:catalog", "start:model"]);
  await registry.stop();
});

it("invalidates immediately, drains a pending start and merges concurrent stops", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  const model = createService(events, "model", ServiceLevel.Optional, [
    "catalog",
  ]);
  catalog.start = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    events.push("start:catalog");
  });
  registry.register(catalog);
  registry.register(model);
  const starting = registry.startRemaining();
  await entered.promise;
  const generation = registry.generation;
  const stopping = registry.stop();
  expect(registry.generation).toBe(generation + 1);
  expect(registry.stop()).toBe(stopping);
  let stopped = false;
  stopping.then(() => {
    stopped = true;
  });
  const blockedWork = vi.fn(async () => undefined);
  const blockedStart = await registry.startRemaining();
  await registry.runStartupWork(blockedWork);
  expect(blockedStart.services.every((svc) => svc.status === "stopped")).toBe(
    true
  );
  expect(blockedWork).not.toHaveBeenCalled();
  expect(catalog.start).toHaveBeenCalledTimes(1);
  expect(catalog.health).not.toHaveBeenCalled();
  expect(catalog.stop).not.toHaveBeenCalled();
  expect(stopped).toBe(false);
  release.resolve();
  await Promise.all([starting, stopping]);
  expect(events).toEqual(["start:catalog", "stop:catalog"]);
  expect(model.start).not.toHaveBeenCalled();
  expect(catalog.stop).toHaveBeenCalledTimes(1);
  expect(catalog.health).not.toHaveBeenCalled();
});

it("cleans up an old initializer that fails after stop without starting successors", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  catalog.start = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    throw new Error("partial native initialization");
  });
  const model = createService(events, "model", ServiceLevel.Optional);
  registry.register(catalog);
  registry.register(model);
  const starting = registry.startRemaining();
  await entered.promise;
  const stopping = registry.stop();
  release.resolve();
  await Promise.all([starting, stopping]);
  expect(catalog.stop).toHaveBeenCalledTimes(1);
  expect(model.start).not.toHaveBeenCalled();
  expect(catalog.health).not.toHaveBeenCalled();
  await registry.stop();
  expect(catalog.stop).toHaveBeenCalledTimes(1);
});

it("waits for registered model copying before closing services or accepting new work", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  registry.register(catalog);
  await registry.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const copying = registry.runStartupWork(async () => {
    events.push("copy:start");
    entered.resolve();
    await release.promise;
    events.push("copy:done");
  });
  await entered.promise;
  const stopping = registry.stop();
  const blockedCopy = vi.fn(async () => undefined);
  await registry.runStartupWork(blockedCopy);
  await registry.startLevel(ServiceLevel.Critical);
  expect(catalog.stop).not.toHaveBeenCalled();
  expect(catalog.start).toHaveBeenCalledTimes(1);
  expect(blockedCopy).not.toHaveBeenCalled();
  release.resolve();
  await Promise.all([copying, stopping]);
  expect(events).toEqual([
    "start:catalog",
    "copy:start",
    "copy:done",
    "stop:catalog",
  ]);
  await registry.start();
  expect(catalog.start).toHaveBeenCalledTimes(2);
  await registry.stop();
});

it("registers startup work before execution and cancels it when stopped in the same tick", async () => {
  const registry = new ServiceRegistry();
  const work = vi.fn(async () => undefined);
  const copying = registry.runStartupWork(work);
  const stopping = registry.stop();
  await Promise.all([copying, stopping]);
  expect(work).not.toHaveBeenCalled();
  const failure = registry.runStartupWork(() => {
    throw new Error("copy failed");
  });
  await expect(failure).rejects.toThrow("copy failed");
  await registry.stop();
});

it("drains an active health probe before stopping and skips later probes", async () => {
  const events: string[] = [];
  const registry = new ServiceRegistry();
  const catalog = createService(events, "catalog", ServiceLevel.Critical);
  const model = createService(events, "model", ServiceLevel.Optional);
  registry.register(catalog);
  registry.register(model);
  await registry.start();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  catalog.health = vi.fn(async () => {
    entered.resolve();
    await release.promise;
    return { status: "ok" as const };
  });
  vi.mocked(model.health).mockClear();
  const probing = registry.health();
  await entered.promise;
  const stopping = registry.stop();
  await registry.health();
  expect(catalog.stop).not.toHaveBeenCalled();
  release.resolve();
  const [report] = await Promise.all([probing, stopping]);
  expect(report.services.every((svc) => svc.status === "stopped")).toBe(true);
  expect(model.health).not.toHaveBeenCalled();
  expect(events.slice(-2)).toEqual(["stop:model", "stop:catalog"]);
});
