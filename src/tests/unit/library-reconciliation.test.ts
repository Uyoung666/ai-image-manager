/** @vitest-environment node */
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  roots: [] as { path: string }[],
  enqueue: vi.fn(),
  start: vi.fn(),
  busy: false,
  ready: undefined as undefined | ((path: string) => void),
}));
const power = new EventEmitter();
vi.mock("electron", () => ({ powerMonitor: power }));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ all: () => fixture.roots }) }),
    }),
  }),
}));
vi.mock("@/services/import-queue", () => ({
  enqueueImport: fixture.enqueue,
  isImportQueueBusy: () => fixture.busy,
  stopImports: vi.fn(),
}));
vi.mock("@/services/indexer", () => ({
  isIndexing: () => false,
  setWatcherReconciliationCallback: (callback?: (path: string) => void) => {
    fixture.ready = callback;
  },
  startWatching: fixture.start,
  stopWatching: vi.fn(),
}));
vi.mock("@/services/ai-index-scheduler", () => ({
  startAutoIndexScheduler: vi.fn(),
  stopAutoIndexScheduler: vi.fn(),
}));
vi.mock("@/services/ai/embedder", () => ({ waitForEmbeddingTasks: vi.fn() }));
vi.mock("@/services/ai/model-loader", () => ({ pauseEmbedding: vi.fn() }));
vi.mock("@/services/library-change", () => ({ notifyLibraryChange: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
let service: typeof import("@/services/library-reconciliation");
beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  fixture.roots = ["library", "library/sub", "library-other"].map((p) => ({
    path: path.resolve(p),
  }));
  fixture.busy = false;
  fixture.enqueue.mockImplementation(() => undefined);
  service = await import("@/services/library-reconciliation");
});
afterEach(async () => {
  await service.stopLibraryReconciliation();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("checks only outer roots at startup and checks again after watcher readiness", async () => {
  service.startLibraryReconciliation();
  expect(fixture.enqueue.mock.calls.map((call) => call[0])).toEqual([
    path.resolve("library"),
    path.resolve("library-other"),
  ]);
  fixture.ready?.(path.resolve("library"));
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(4);
});

it("waits for a scan round, schedules hourly fallback and merges resume notifications", async () => {
  fixture.busy = true;
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(5000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  fixture.busy = false;
  await vi.advanceTimersByTimeAsync(1000 + 60 * 60_000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(4);
  power.emit("resume");
  power.emit("resume");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(6);
  await service.stopLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(80 * 60_000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(6);
  expect(power.listenerCount("resume")).toBe(0);
});

it("isolates unavailable roots and restarts on a changed profile", async () => {
  fixture.enqueue.mockImplementationOnce(() => {
    throw new Error("offline");
  });
  service.startLibraryReconciliation();
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  await service.stopLibraryReconciliation();
  fixture.roots = [{ path: path.resolve("another-profile") }];
  fixture.enqueue.mockClear();
  service.startLibraryReconciliation();
  expect(fixture.enqueue).toHaveBeenCalledExactlyOnceWith(
    path.resolve("another-profile"),
    "background"
  );
});

it("discards the old profile's run ownership and pending tags only after tasks settle", async () => {
  const state = await import("@/services/ai/state");
  const { waitForEmbeddingTasks } = await import("@/services/ai/embedder");
  let release!: () => void;
  vi.mocked(waitForEmbeddingTasks).mockReturnValueOnce(
    new Promise<void>((resolve) => {
      release = resolve;
    })
  );
  const runId = state.beginEmbeddingRun();
  state.addWrittenPhotoIdsForRun(runId, [1]);
  state.addPendingAutoTagPhotoIds([1]);
  const stopping = service.stopLibraryReconciliation();
  await Promise.resolve();
  expect(state.activeEmbeddingRunId).toBe(runId);
  release();
  await stopping;
  expect(state.activeEmbeddingRunId).toBe(0);
  expect(state.getWrittenPhotoIdsForRun(runId).size).toBe(0);
  expect(state.getPendingAutoTagPhotoIds().size).toBe(0);
});
