/** @vitest-environment node */
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  rows: [] as { id: number }[],
  settings: new Map<string, string>(),
  embed: vi.fn(),
  send: vi.fn(),
}));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ all: () => fixture.rows }) }),
    }),
  }),
}));
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [{ webContents: { send: fixture.send } }],
  },
}));
vi.mock("@/services/settings-manager", () => ({
  getSetting: (key: string) => fixture.settings.get(key) ?? null,
  setSetting: (key: string, value: string) => fixture.settings.set(key, value),
}));
vi.mock("@/services/ai/embedder", () => ({ embedAllPhotos: fixture.embed }));
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
  fixture.rows = [{ id: 1 }];
  fixture.embed.mockReset().mockImplementation(() => {
    fixture.rows = [];
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
    () =>
      new Promise<number>((resolve) => {
        finish = () => {
          fixture.rows = [{ id: 2 }];
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

it("excludes failed photos from later automatic runs without blocking new photos", async () => {
  fixture.embed.mockResolvedValueOnce(0);
  scheduler.startAutoIndexScheduler(() => false);
  await vi.advanceTimersByTimeAsync(1000);
  expect(scheduler.getAutoIndexStatus().failedPhotos).toBe(1);
  fixture.rows.push({ id: 2 });
  scheduler.requestAutoIndex("watcher");
  await vi.advanceTimersByTimeAsync(1000);
  expect(fixture.embed.mock.calls[1][1].excludePhotoIds).toEqual(new Set([1]));
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
  scheduler.setAutoIndexStopped(false);
  await scheduler.stopAutoIndexScheduler();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(fixture.embed).toHaveBeenCalledOnce();
});
