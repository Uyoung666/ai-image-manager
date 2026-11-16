// @vitest-environment node

import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IndexProgress } from "@/services/indexer";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  scan: vi.fn(),
  stop: vi.fn(),
  send: vi.fn(),
  legacyRoots: [] as Array<{ path: string }>,
  indexResetting: false,
  foregroundBusy: false,
}));
vi.mock("@/services/library-foreground", () => ({
  isLibraryForegroundBusy: () => state.foregroundBusy,
}));
vi.mock("@/services/ai-index-scheduler", () => ({ requestAutoIndex: vi.fn() }));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: state.send } }],
  },
}));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ all: () => state.legacyRoots }) }),
    }),
  }),
}));
vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => state.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => state.settings.set(key, value),
}));
vi.mock("@/utils/import-path", () => ({
  normalizeImportFolderPath: (value: string) => value,
  importPathKey: (value: string) => value.toLowerCase(),
}));
vi.mock("@/services/indexer", () => ({
  scanFolder: state.scan,
  stopScanning: state.stop,
  watchFolder: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateIndexStatsCache: vi.fn(),
}));
vi.mock("@/services/ai/state", () => ({
  getAiControlState: () => "idle",
  get isAiIndexResetting() {
    return state.indexResetting;
  },
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: vi.fn(),
  deleteColorVectors: vi.fn(),
  embedAllPhotos: vi.fn().mockResolvedValue(0),
}));
vi.mock("@/services/advanced-exif", () => ({
  scheduleAdvancedExifEnrichment: vi.fn(),
}));
vi.mock("@/services/folder-matcher", () => ({ reloadFolderMatcher: vi.fn() }));
vi.mock("@/services/thumbnailer", () => ({ deletePhotoThumbnails: vi.fn() }));

function result(cancelled = false) {
  return {
    folderId: 1,
    folderExisted: true,
    createdFolderIds: [],
    photoIds: [1, 2],
    newPhotoIds: [],
    skipped: 0,
    cancelled,
  };
}

function progress(
  phase: IndexProgress["phase"],
  scanned: number,
  currentFile = `photos/photo-${scanned}.jpg`
): IndexProgress {
  return { phase, scanned, total: 500, currentFile };
}

function scanProgress(): IndexProgress[] {
  return state.send.mock.calls
    .filter(([channel]) => channel === "scan-progress")
    .map(([, payload]) => payload);
}

describe("durable import recovery", () => {
  afterEach(async () => {
    // Retire scheduled immediates and continuations before the next test resets
    // modules and installs a new fake clock.
    const queue = await import("@/services/import-queue");
    queue.suspendImportsForShutdown();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("broadcasts scan accounting without losing rejected-file counts", async () => {
    state.scan.mockResolvedValue({
      ...result(),
      photoIds: [1, 2],
      newPhotoIds: [1, 2],
      skipped: 3,
      failed: 1,
    });
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("mixed-fixture");
    await tick();
    expect(queue.getImportQueueStatus().history[0]).toMatchObject({
      status: "done",
      photoCount: 2,
      newPhotoCount: 2,
      skipped: 3,
      failed: 1,
    });
    expect(state.send).toHaveBeenCalledWith(
      "import-queue-status",
      expect.objectContaining({
        history: expect.arrayContaining([
          expect.objectContaining({ skipped: 3, failed: 1 }),
        ]),
      })
    );
  });

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.settings.clear();
    state.legacyRoots = [];
    state.indexResetting = false;
    state.foregroundBusy = false;
    state.scan.mockResolvedValue(result());
  });

  it("broadcasts only the latest indexing progress when the 100ms window expires", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const scan = Promise.withResolvers<ReturnType<typeof result>>();
    let report!: (value: IndexProgress) => void;
    state.scan.mockImplementationOnce((_root, onProgress) => {
      report = onProgress;
      return scan.promise;
    });
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("photos");
    await tick();
    report(progress("indexing", 1));
    expect(scanProgress()).toEqual([progress("indexing", 1)]);
    for (let scanned = 2; scanned <= 500; scanned++) {
      report(progress("indexing", scanned));
    }
    expect(scanProgress()).toEqual([progress("indexing", 1)]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(scanProgress()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(scanProgress()).toEqual([
      progress("indexing", 1),
      progress("indexing", 500),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    scan.resolve(result());
    await tick();
    expect(queue.getImportQueueStatus()).toMatchObject({
      current: null,
      history: [{ status: "done", photoCount: 2, newPhotoCount: 0 }],
    });
  });

  it("broadcasts phase changes and complete counts immediately while clearing pending updates", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const scan = Promise.withResolvers<ReturnType<typeof result>>();
    let report!: (value: IndexProgress) => void;
    state.scan.mockImplementationOnce((_root, onProgress) => {
      report = onProgress;
      return scan.promise;
    });
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("photos");
    await tick();
    report(progress("scanning", 0));
    report(progress("scanning", 100));
    expect(vi.getTimerCount()).toBe(1);
    report(progress("indexing", 1));
    expect(scanProgress()).toEqual([
      progress("scanning", 0),
      progress("indexing", 1),
    ]);
    expect(vi.getTimerCount()).toBe(0);
    report(progress("indexing", 499));
    expect(vi.getTimerCount()).toBe(1);
    const complete = progress("complete", 500, "photos/最后一张.jpg");
    report(complete);
    expect(scanProgress()).toEqual([
      progress("scanning", 0),
      progress("indexing", 1),
      complete,
    ]);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanProgress()).toHaveLength(3);
    scan.resolve({ ...result(), skipped: 3 });
    await tick();
    expect(queue.getImportQueueStatus().history[0]).toMatchObject({
      status: "done",
      photoCount: 2,
      skipped: 3,
      failed: 0,
    });
    expect(scanProgress().at(-1)).toEqual(complete);
  });

  it.each([
    "done",
    "failed",
    "cancelled",
  ] as const)("flushes the latest progress and cancels its timer before the next import after %s", async (status) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const first = Promise.withResolvers<ReturnType<typeof result>>();
    const next = Promise.withResolvers<ReturnType<typeof result>>();
    let reportNext!: (value: IndexProgress) => void;
    const initial = progress("indexing", 1, "first/first.jpg");
    const latest = progress("indexing", 499, "first/最后一张.jpg");
    const nextInitial = progress("indexing", 1, "next/first.jpg");
    const nextLatest = progress("indexing", 2, "next/last.jpg");
    state.scan
      .mockImplementationOnce((_root, report) => {
        report(initial);
        report(latest);
        return first.promise;
      })
      .mockImplementationOnce((_root, report) => {
        reportNext = report;
        report(nextInitial);
        return next.promise;
      });
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("first");
    queue.enqueueImport("next");
    await tick();
    expect(scanProgress()).toEqual([initial]);
    expect(vi.getTimerCount()).toBe(1);
    if (status === "failed") {
      first.reject(new Error("controlled scan failure"));
    } else {
      if (status === "cancelled") {
        expect(queue.cancelCurrentImport()).toBe(true);
        expect(state.stop).toHaveBeenCalledOnce();
      }
      first.resolve(result(status === "cancelled"));
    }
    await tick();
    expect(scanProgress()).toEqual([initial, latest, nextInitial]);
    expect(vi.getTimerCount()).toBe(0);
    expect(queue.getImportQueueStatus()).toMatchObject({
      current: { folderPath: "next", status: "scanning" },
      history: [{ folderPath: "first", status }],
    });
    if (status === "failed") {
      expect(queue.getImportQueueStatus().history[0].error).toBe(
        "controlled scan failure"
      );
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanProgress()).toEqual([initial, latest, nextInitial]);
    reportNext(nextLatest);
    expect(vi.getTimerCount()).toBe(0);
    const finalPending = progress("indexing", 3, "next/末尾.jpg");
    reportNext(finalPending);
    expect(vi.getTimerCount()).toBe(1);
    next.resolve(result());
    await tick();
    const expected = [initial, latest, nextInitial, nextLatest, finalPending];
    expect(scanProgress()).toEqual(expected);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(1000);
    expect(scanProgress()).toEqual(expected);
    expect(queue.getImportQueueStatus()).toMatchObject({
      current: null,
      pending: [],
      history: [
        { folderPath: "first", status },
        { folderPath: "next", status: "done", photoCount: 2 },
      ],
    });
  });

  it("resumes interrupted and queued roots after restart, but not completed roots", async () => {
    let release!: (value: ReturnType<typeof result>) => void;
    state.scan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const first = await import("@/services/import-queue");
    first.enqueueImport("photos-a");
    first.enqueueImport("photos-b");
    await tick();
    first.suspendImportsForShutdown();
    release(result(true));
    await tick();
    expect(first.getImportQueueStatus().history).toEqual([]);

    vi.resetModules();
    const second = await import("@/services/import-queue");
    second.resumeInterruptedImports();
    await tick();
    await tick();
    expect(state.scan.mock.calls.map(([root]) => root)).toEqual([
      "photos-a",
      "photos-a",
      "photos-b",
    ]);
    expect(
      second.getImportQueueStatus().history.map((task) => task.status)
    ).toEqual(["done", "done"]);

    vi.resetModules();
    const third = await import("@/services/import-queue");
    third.resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(3);
  });

  it("does not recover explicitly cancelled queued imports", async () => {
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("cancelled-root");
    queue.cancelQueuedImports();
    await tick();
    vi.resetModules();
    (await import("@/services/import-queue")).resumeInterruptedImports();
    await tick();
    expect(state.scan).not.toHaveBeenCalled();
  });

  it("can restore the queue after an in-process registry restart", async () => {
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("queued-root");
    await queue.stopImports();
    await tick();
    queue.resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(queue.getImportQueueStatus().history[0].status).toBe("done");
  });

  it("reconciles legacy unfinished roots once when upgrading without a journal", async () => {
    state.legacyRoots = [{ path: "legacy-partial-root" }];
    const queue = await import("@/services/import-queue");
    queue.resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledWith(
      "legacy-partial-root",
      expect.any(Function),
      { background: false }
    );
    vi.resetModules();
    (await import("@/services/import-queue")).resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed recovery available for the next launch without retrying in a loop", async () => {
    state.scan.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const first = await import("@/services/import-queue");
    first.enqueueImport("offline-root");
    await tick();
    expect(first.getImportQueueStatus().history[0].status).toBe("failed");
    expect(state.scan).toHaveBeenCalledTimes(1);
    vi.resetModules();
    (await import("@/services/import-queue")).resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(2);
  });

  it("does not resurrect a failed import after the user removes its folder", async () => {
    state.scan.mockRejectedValueOnce(new Error("temporarily unavailable"));
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("removed-root");
    await tick();
    queue.forgetInterruptedImports(["removed-root"]);
    vi.resetModules();
    (await import("@/services/import-queue")).resumeInterruptedImports();
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(1);
  });

  it("keeps background checks queued with one short retry while the library is active", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.foregroundBusy = true;
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("background-a", "background");
    queue.enqueueImport("background-b", "background");
    await tick();
    expect(queue.getImportQueueStatus()).toMatchObject({
      current: null,
      pending: [{ status: "queued" }, { status: "queued" }],
      history: [],
    });
    expect(state.scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.scan).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);
    state.foregroundBusy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.scan.mock.calls.map(([root]) => root)).toEqual([
      path.resolve("background-a"),
      path.resolve("background-b"),
    ]);
    expect(queue.getImportQueueStatus().pending).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("lets an explicit import bypass the background wait without duplicate scanning", async () => {
    const queue = await import("@/services/import-queue");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    // Unrelated timers must not affect assertions about the queue's 100ms retry.
    const timers = vi.spyOn(globalThis, "setTimeout");
    const clear = vi.spyOn(globalThis, "clearTimeout");
    const unrelated = setTimeout(() => undefined, 1000);
    const backgroundTimers = () =>
      timers.mock.calls.flatMap(([, delay], index) =>
        delay === 100 ? [timers.mock.results[index].value] : []
      );
    state.foregroundBusy = true;
    queue.enqueueImport("background", "background");
    await tick();
    expect(backgroundTimers()).toHaveLength(1);
    const [backgroundWait] = backgroundTimers();

    const scan = Promise.withResolvers<ReturnType<typeof result>>();
    state.scan.mockReturnValueOnce(scan.promise);
    queue.enqueueImport("explicit");
    queue.enqueueImport("explicit");
    await tick();
    expect(state.scan).toHaveBeenCalledExactlyOnceWith(
      "explicit",
      expect.any(Function),
      { background: false }
    );
    expect(queue.getImportQueueStatus().current).toMatchObject({
      folderPath: "explicit",
      status: "scanning",
    });
    expect(clear).toHaveBeenCalledWith(backgroundWait);
    await vi.advanceTimersByTimeAsync(100);
    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(backgroundTimers()).toHaveLength(1);

    scan.resolve(result());
    await tick();
    expect(state.scan).toHaveBeenCalledTimes(1);
    expect(queue.getImportQueueStatus().pending).toMatchObject([
      { source: "background", status: "queued" },
    ]);
    expect(backgroundTimers()).toHaveLength(2);
    const nextBackgroundWait = backgroundTimers()[1];
    await queue.stopImports();
    expect(clear).toHaveBeenCalledWith(nextBackgroundWait);
    expect(clear).not.toHaveBeenCalledWith(unrelated);
    clearTimeout(unrelated);
  });

  it("wakes a queued background root immediately when the user explicitly imports it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    state.foregroundBusy = true;
    const queue = await import("@/services/import-queue");
    const root = path.resolve("promoted-root");
    const original = queue.enqueueImport(root, "background");
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    const promoted = queue.enqueueImport(root);
    expect(promoted.id).toBe(original.id);
    await tick();
    expect(state.scan).toHaveBeenCalledExactlyOnceWith(
      root,
      expect.any(Function),
      { background: false }
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("retires a background retry across a profile stop without disturbing the new timer", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const timers = vi.spyOn(globalThis, "setTimeout");
    state.foregroundBusy = true;
    const queue = await import("@/services/import-queue");
    queue.enqueueImport("old-profile", "background");
    await tick();
    const oldRetry = timers.mock.calls.find(([, delay]) => delay === 100)?.[0];
    expect(typeof oldRetry).toBe("function");
    await queue.stopImports();
    expect(vi.getTimerCount()).toBe(0);
    state.settings.set("imports.unfinishedRoots", "[]");
    queue.resumeInterruptedImports();
    queue.enqueueImport("new-profile", "background");
    await tick();
    expect(vi.getTimerCount()).toBe(1);
    (oldRetry as () => void)();
    expect(vi.getTimerCount()).toBe(1);
    expect(state.scan).not.toHaveBeenCalled();
    state.foregroundBusy = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(state.scan).toHaveBeenCalledExactlyOnceWith(
      path.resolve("new-profile"),
      expect.any(Function),
      { background: true }
    );
  });
});
