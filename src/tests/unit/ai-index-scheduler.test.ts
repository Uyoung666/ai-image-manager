/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshChangedPhotoFaces } from "@/services/library-face-refresh";

const fixture = vi.hoisted(() => ({
  rows: [] as {
    attempts?: number;
    fileRevision?: number;
    id: number;
    retryAt?: number;
    retryFileRevision?: number;
  }[],
  database: 0,
  settings: new Map<string, string>(),
  embed: vi.fn(),
  ignore: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/db", () => {
  const createDatabase = () => ({
    select: () => ({
      from: () => ({ where: () => ({ all: () => fixture.rows }) }),
    }),
  });
  const databases = [createDatabase(), createDatabase()];
  return { getDatabase: () => databases[fixture.database] };
});
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: fixture.send } }],
  },
}));
vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => fixture.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => fixture.settings.set(key, value),
}));
vi.mock("@/services/ai/embedder", () => ({
  embedAllPhotos: fixture.embed,
  ignoreActiveEmbeddingFailure: fixture.ignore,
}));
vi.mock("@/services/library-face-refresh", () => ({
  refreshChangedPhotoFaces: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/ai/model-loader", () => ({ pauseEmbedding: vi.fn() }));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}));

let scheduler: typeof import("@/services/ai-index-scheduler");
let state: typeof import("@/services/ai/state");
beforeEach(async () => {
  vi.resetModules();
  vi.useFakeTimers();
  fixture.settings.clear();
  fixture.database = 0;
  fixture.ignore.mockClear();
  vi.mocked(refreshChangedPhotoFaces).mockReset().mockResolvedValue(undefined);
  fixture.rows = [{ id: 1 }];
  fixture.embed.mockReset().mockImplementation((_, options) => {
    fixture.rows = fixture.rows.filter(({ id }) =>
      options.excludePhotoIds.has(id)
    );
    options.onCompleted();
    return Promise.resolve(1);
  });
  state = await import("@/services/ai/state");
  state.setIsModelLoaded(true);
  state.setIsVectorDBReady(true);
  scheduler = await import("@/services/ai-index-scheduler");
});
afterEach(async () => {
  await scheduler.stopAutoIndexScheduler();
  vi.useRealTimers();
});

it("recovers pending database rows and coalesces watcher bursts", async () => {
  scheduler.startAutoIndexScheduler(() => false);
  scheduler.requestAutoIndex("watcher");
  await vi.advanceTimersByTimeAsync(900);
  scheduler.requestAutoIndex("watcher");
  await vi.advanceTimersByTimeAsync(999);
  expect(fixture.embed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.embed).toHaveBeenCalledOnce();
  expect(scheduler.getAutoIndexStatus().state).toBe("idle");
});
it("resumes durable face work when image embeddings are already complete", async () => {
  fixture.rows = [];
  vi.mocked(refreshChangedPhotoFaces).mockClear();
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed).not.toHaveBeenCalled();
  expect(refreshChangedPhotoFaces).toHaveBeenCalledOnce();
});
it("resumes face-only work at its durable deadline and obeys pause", async () => {
  fixture.rows = [];
  vi.mocked(refreshChangedPhotoFaces).mockResolvedValueOnce(Date.now() + 6000);
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(refreshChangedPhotoFaces).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(4999);
  expect(refreshChangedPhotoFaces).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(refreshChangedPhotoFaces).toHaveBeenCalledTimes(2);
  scheduler.setAutoIndexStopped(true);
  scheduler.requestAutoIndex("changed-photo");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(refreshChangedPhotoFaces).toHaveBeenCalledTimes(2);
});

it("starts within five seconds even while additions continue", async () => {
  scheduler.startAutoIndexScheduler(() => false);
  for (let n = 0; n < 6; n++) {
    scheduler.requestAutoIndex("watcher");
    await vi.advanceTimersByTimeAsync(800);
  }
  expect(fixture.embed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(fixture.embed).toHaveBeenCalledOnce();
});

it("retains work through scans, reset ownership and model preparation", async () => {
  let scanning = true;
  scheduler.startAutoIndexScheduler(() => scanning);
  state.setIsAiIndexResetting(true);
  state.setIsModelLoaded(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().reason).toBe("scan");
  scanning = false;
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().reason).toBe("busy");
  state.setIsAiIndexResetting(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().reason).toBe("model");
  state.setIsModelLoaded(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed).toHaveBeenCalledOnce();
});

it("keeps arrivals during an active run for the next run", async () => {
  let finish!: () => void;
  fixture.embed.mockImplementationOnce(
    (_, options) =>
      new Promise<number>((resolve) => {
        finish = () => {
          fixture.rows = [{ id: 2 }];
          options.onCompleted();
          resolve(1);
        };
      })
  );
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  scheduler.requestAutoIndex("watcher");
  finish();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
});

it("excludes exhausted photos after restart without blocking new photos", async () => {
  fixture.rows = [
    { id: 1, fileRevision: 0, retryFileRevision: 0, attempts: 4 },
    { id: 2 },
  ];
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().failedPhotos).toBe(1);
  expect(fixture.embed.mock.calls[0][1].excludePhotoIds).toEqual(new Set([1]));
  expect(fixture.rows.map(({ id }) => id)).toEqual([1]);
});

it("retries after the durable deadline alongside unrelated eligible photos", async () => {
  const retryAt = Date.now() + 6000;
  fixture.rows = [
    { id: 1, fileRevision: 0, retryFileRevision: 0, attempts: 1, retryAt },
    { id: 2 },
  ];
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed.mock.calls[0][1].excludePhotoIds).toEqual(new Set([1]));
  await vi.advanceTimersByTimeAsync(4999);
  expect(fixture.embed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
  expect(fixture.embed.mock.calls[1][1].excludePhotoIds).toEqual(new Set());
});

it("schedules a newly recorded failure deadline without another source event", async () => {
  fixture.embed.mockImplementationOnce((_, options) => {
    const retryAt = Date.now() + 2000;
    fixture.rows = [
      { id: 1, fileRevision: 0, retryFileRevision: 0, attempts: 1, retryAt },
    ];
    options.onCompleted(retryAt);
    return Promise.resolve(0);
  });
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(2999);
  expect(fixture.embed).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
});

it("retries a previously failed photo after moving without a content change", async () => {
  fixture.rows = [
    { id: 1, fileRevision: 0, retryFileRevision: 0, attempts: 4 },
  ];
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().failedPhotos).toBe(1);
  fixture.rows[0].fileRevision = 1;
  scheduler.requestAutoIndex("moved-photo");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed).toHaveBeenCalledOnce();
  expect(fixture.embed.mock.calls[0][1].excludePhotoIds).toEqual(new Set());
});
it("queues an explicit retry during an active failing run", async () => {
  let rejectRun: (error: Error) => void = () => undefined;
  fixture.embed.mockImplementationOnce(
    () =>
      new Promise<number>((_, reject) => {
        rejectRun = reject;
      })
  );
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  scheduler.requestAutoIndexPhotoRetry(1);
  expect(fixture.ignore).toHaveBeenCalledWith(1);
  rejectRun(new Error("worker interrupted"));
  await vi.advanceTimersByTimeAsync(1);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
  expect(scheduler.getAutoIndexStatus().state).toBe("idle");
});

it("keeps the persistent stop setting on an explicit photo retry", async () => {
  fixture.settings.set("ai.autoIndexStopped", "true");
  scheduler.startAutoIndexScheduler(() => false);
  scheduler.requestAutoIndexPhotoRetry(1);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).not.toHaveBeenCalled();
  expect(fixture.settings.get("ai.autoIndexStopped")).toBe("true");
  expect(scheduler.getAutoIndexStatus().state).toBe("paused");
});

it("does not schedule against a replacement database when an old run finishes", async () => {
  let finish: () => void = () => undefined;
  fixture.embed.mockImplementationOnce(
    (_, options) =>
      new Promise<number>((resolve) => {
        finish = () => {
          options.onCompleted(Date.now() + 2000);
          resolve(0);
        };
      })
  );
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  fixture.database = 1;
  finish();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).toHaveBeenCalledOnce();
  expect(refreshChangedPhotoFaces).not.toHaveBeenCalled();
});

it("persists manual stopping through scheduler restart until explicitly resumed", async () => {
  scheduler.startAutoIndexScheduler(() => false);
  scheduler.setAutoIndexStopped(true);
  await scheduler.stopAutoIndexScheduler();
  scheduler.startAutoIndexScheduler(() => false);
  scheduler.requestAutoIndex("watcher");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).not.toHaveBeenCalled();
  expect(scheduler.getAutoIndexStatus().state).toBe("paused");
  scheduler.setAutoIndexStopped(false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed).toHaveBeenCalledOnce();
});

it("blocks fatal errors until manual retry and cancels shutdown timers", async () => {
  fixture.embed.mockRejectedValueOnce(new Error("worker unavailable"));
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  scheduler.requestAutoIndex("watcher");
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).toHaveBeenCalledOnce();
  expect(scheduler.getAutoIndexStatus().state).toBe("error");
  scheduler.requestAutoIndexPhotoRetry(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
  expect(scheduler.getAutoIndexStatus().state).toBe("idle");
  await scheduler.stopAutoIndexScheduler();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).toHaveBeenCalledTimes(2);
});
