/** @vitest-environment node */
import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  roots: [] as { path: string }[],
  enqueue: vi.fn(),
  logInfo: vi.fn(),
  start: vi.fn(),
  startHashBackfill: vi.fn(),
  busy: false,
  foregroundBusy: false,
  waitForeground: vi.fn(),
  ready: undefined as undefined | ((path: string) => void),
}));
vi.mock("@/services/library-foreground", () => ({
  isLibraryForegroundBusy: () => fixture.foregroundBusy,
  waitForLibraryForegroundIdle: fixture.waitForeground,
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
vi.mock("@/services/library-content-refresh", () => ({
  observeLibraryPhoto: vi.fn(),
  startLibraryContentRefresh: vi.fn(),
  stopLibraryContentRefresh: vi.fn(),
}));
vi.mock("@/services/library-moves", () => ({
  startLibraryHashBackfill: fixture.startHashBackfill,
  stopLibraryHashBackfill: vi.fn(),
}));
vi.mock("@/services/library-source", () => ({
  reconcileLibrarySources: vi.fn().mockResolvedValue({ changed: 0 }),
}));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: fixture.logInfo, warn: vi.fn() }),
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
  fixture.foregroundBusy = false;
  fixture.waitForeground.mockImplementation((isCurrent: () => boolean) =>
    Promise.resolve(isCurrent())
  );
  fixture.enqueue.mockImplementation(() => undefined);
  service = await import("@/services/library-reconciliation");
});
afterEach(async () => {
  await service.stopLibraryReconciliation();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

it("merges early watcher readiness into one bounded startup check of outer roots", async () => {
  service.startLibraryReconciliation();
  expect(fixture.start).toHaveBeenCalledTimes(1);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(400);
  fixture.ready?.(path.resolve("library"));
  await vi.advanceTimersByTimeAsync(2599);
  fixture.ready?.(path.resolve("library-other"));
  expect(fixture.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue.mock.calls.map((call) => call[0])).toEqual([
    path.resolve("library"),
    path.resolve("library-other"),
  ]);
  expect(fixture.start).toHaveBeenCalledTimes(2);
  expect(fixture.logInfo).toHaveBeenCalledWith(
    { roots: 2, startupToEnqueueMs: expect.any(Number) },
    "Library reconciliation queued"
  );
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
});

it("runs the startup fallback without readiness and checks again for a late watcher", async () => {
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(2999);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  fixture.ready?.(path.resolve("library"));
  await vi.advanceTimersByTimeAsync(999);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue).toHaveBeenCalledTimes(4);
});

it("cancels the pending startup check when the profile stops", async () => {
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(2999);
  await service.stopLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fixture.enqueue).not.toHaveBeenCalled();
});

it("holds fingerprint backfill through the bounded startup grace and keeps wake checks prompt", async () => {
  service.startLibraryReconciliation();
  const isBusy = fixture.startHashBackfill.mock.lastCall?.[0] as () => boolean;
  expect(isBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(2999);
  expect(isBusy()).toBe(true);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  expect(isBusy()).toBe(false);
  fixture.busy = true;
  expect(isBusy()).toBe(true);
  fixture.busy = false;

  power.emit("resume");
  await vi.advanceTimersByTimeAsync(999);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue).toHaveBeenCalledTimes(4);
});

it("gives a restarted profile a fresh startup grace without an old timer", async () => {
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(2000);
  await service.stopLibraryReconciliation();
  service.startLibraryReconciliation();
  const isBusy = fixture.startHashBackfill.mock.lastCall?.[0] as () => boolean;
  await vi.advanceTimersByTimeAsync(2999);
  expect(fixture.enqueue).not.toHaveBeenCalled();
  expect(isBusy()).toBe(true);
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  expect(isBusy()).toBe(false);
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
  await vi.advanceTimersByTimeAsync(3000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  await service.stopLibraryReconciliation();
  fixture.roots = [{ path: path.resolve("another-profile") }];
  fixture.enqueue.mockClear();
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(3000);
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

it("makes automatic AI and fingerprint work yield during a foreground lease", async () => {
  const { startAutoIndexScheduler } = await import(
    "@/services/ai-index-scheduler"
  );
  service.startLibraryReconciliation();
  const aiBusy = vi.mocked(startAutoIndexScheduler).mock
    .lastCall?.[0] as () => boolean;
  const hashBusy = fixture.startHashBackfill.mock
    .lastCall?.[0] as () => boolean;
  await vi.advanceTimersByTimeAsync(3000);
  expect(aiBusy()).toBe(false);
  expect(hashBusy()).toBe(false);
  fixture.foregroundBusy = true;
  expect(aiBusy()).toBe(true);
  expect(hashBusy()).toBe(true);
  fixture.foregroundBusy = false;
  expect(aiBusy()).toBe(false);
  expect(hashBusy()).toBe(false);
});

it("waits before automatic explicit-only checks while retaining queued root checks", async () => {
  const { reconcileLibrarySources } = await import("@/services/library-source");
  const idle = Promise.withResolvers<boolean>();
  fixture.waitForeground.mockReturnValueOnce(idle.promise);
  fixture.foregroundBusy = true;
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(3000);
  expect(fixture.enqueue).toHaveBeenCalledTimes(2);
  expect(reconcileLibrarySources).not.toHaveBeenCalled();
  fixture.foregroundBusy = false;
  idle.resolve(true);
  await vi.advanceTimersByTimeAsync(0);
  expect(reconcileLibrarySources).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({
      explicitOnly: true,
      signal: expect.any(AbortSignal),
    })
  );
});

it("cancels an explicit-only foreground wait before stopping the old profile", async () => {
  const { reconcileLibrarySources } = await import("@/services/library-source");
  fixture.waitForeground.mockImplementationOnce(
    (_isCurrent: () => boolean, signal: AbortSignal) =>
      new Promise<boolean>((resolve) => {
        signal.addEventListener("abort", () => resolve(false), { once: true });
      })
  );
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(3000);
  const signal = fixture.waitForeground.mock.lastCall?.[1] as AbortSignal;
  await service.stopLibraryReconciliation();
  expect(signal.aborted).toBe(true);
  expect(reconcileLibrarySources).not.toHaveBeenCalled();
  service.startLibraryReconciliation();
  await vi.advanceTimersByTimeAsync(3000);
  expect(reconcileLibrarySources).toHaveBeenCalledTimes(1);
});
