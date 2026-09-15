// @vitest-environment node
import { setImmediate as tick } from "node:timers/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  settings: new Map<string, string>(),
  scan: vi.fn(),
  stop: vi.fn(),
  send: vi.fn(),
  legacyRoots: [] as Array<{ path: string }>,
}));
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
vi.mock("@/services/ai/state", () => ({ getAiControlState: () => "idle" }));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: vi.fn(),
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

describe("durable import recovery", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    state.settings.clear();
    state.legacyRoots = [];
    state.scan.mockResolvedValue(result());
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
      expect.any(Function)
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
});
