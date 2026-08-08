import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SentMessage {
  adapter?: { adapterId: string; fingerprint: string };
  photos?: Array<{ id: number; path: string }>;
  type?: string;
}

const childProcessMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;

  function normalizedVector(): number[] {
    return [1, ...Array.from({ length: 767 }, () => 0)];
  }

  class FakeChildProcess {
    adapter: { adapterId: string; fingerprint: string } | null = null;
    killed = false;
    private readonly listeners = new Map<string, Listener[]>();
    readonly stderr = { on: vi.fn() };
    readonly send = vi.fn((message: SentMessage) => {
      if (message.type === "init" && message.adapter) {
        this.adapter = message.adapter;
        setTimeout(() => {
          this.emit("message", { type: "ready", ...this.adapter });
        }, 0);
      } else if (message.type === "embed") {
        if (controls.crashNextEmbed) {
          controls.crashNextEmbed = false;
          setTimeout(() => this.emit("exit", 1, null), 1);
        } else if (controls.respondToEmbeds) {
          setTimeout(() => {
            this.emit("message", {
              type: "result",
              ...this.adapter,
              results: (message.photos ?? []).map((photo) => ({
                id: photo.id,
                vector: normalizedVector(),
              })),
            });
          }, 1);
        }
      } else if (message.type === "abort") {
        controls.abortMessages += 1;
      }
      return true;
    });
    readonly kill = vi.fn(() => {
      if (!this.killed) {
        this.killed = true;
        this.emit("exit", 0, null);
      }
      return true;
    });

    on(event: string, listener: Listener): this {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
      return this;
    }

    emit(event: string, ...args: unknown[]): void {
      for (const listener of this.listeners.get(event) ?? []) {
        listener(...args);
      }
    }
  }

  const children: FakeChildProcess[] = [];
  const controls = {
    abortMessages: 0,
    crashNextEmbed: false,
    respondToEmbeds: true,
  };
  const fork = vi.fn(() => {
    const child = new FakeChildProcess();
    children.push(child);
    return child;
  });

  return { children, controls, fork };
});

vi.mock("node:child_process", () => ({
  default: { fork: childProcessMock.fork },
  fork: childProcessMock.fork,
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

async function initializePool(workerCount: number, batchSize = 2) {
  vi.stubEnv("AI_EMBED_WORKERS", String(workerCount));
  vi.stubEnv("AI_EMBED_THREADS", "1");
  vi.stubEnv("AI_EMBED_BATCH_SIZE", String(batchSize));
  const pool = await import("@/services/embed-worker-pool");
  const initialization = pool.initWorkerPool("model-path");
  await vi.advanceTimersByTimeAsync(50);
  await initialization;
  return pool;
}

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  childProcessMock.children.length = 0;
  childProcessMock.fork.mockClear();
  childProcessMock.controls.abortMessages = 0;
  childProcessMock.controls.crashNextEmbed = false;
  childProcessMock.controls.respondToEmbeds = true;
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await vi.runOnlyPendingTimersAsync();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("production image worker pool recovery and control", () => {
  it("respawns one crashed worker without replacing the healthy generation", async () => {
    const pool = await initializePool(2);
    expect(pool.getPoolHealth()).toMatchObject({ alive: 2, dead: 0 });

    childProcessMock.children[0]?.emit("exit", 1, null);
    expect(pool.getPoolHealth()).toMatchObject({ alive: 1, dead: 1 });

    await vi.advanceTimersByTimeAsync(1050);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(3);
    expect(pool.getPoolHealth()).toMatchObject({ alive: 2, dead: 0 });

    pool.shutdownPool();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("reinitializes after the only worker crashes and accepts the next request", async () => {
    const pool = await initializePool(1);
    childProcessMock.controls.crashNextEmbed = true;

    const failed = pool.embedSingleImage("first.png", "model-path");
    const failedExpectation = expect(failed).rejects.toThrow(
      "died during processing"
    );
    await vi.advanceTimersByTimeAsync(10);
    await failedExpectation;

    const recovered = pool.embedSingleImage("second.png", "model-path");
    await vi.advanceTimersByTimeAsync(100);
    await expect(recovered).resolves.toHaveLength(768);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);

    pool.shutdownPool();
    await vi.advanceTimersByTimeAsync(500);
  });

  it("pauses between batches, resumes remaining work, and cancels without dispatching more", async () => {
    const pool = await initializePool(1, 2);
    const photos = Array.from({ length: 6 }, (_, index) => ({
      id: index + 1,
      path: `synthetic-${index + 1}.png`,
    }));
    const persistedIds: number[] = [];
    let paused = false;

    const pausedRun = pool.embedWithPool(
      photos,
      undefined,
      () => paused,
      (results) => {
        persistedIds.push(...results.map((result) => result.id));
        paused = true;
      }
    );
    await vi.advanceTimersByTimeAsync(20);
    const pausedResults = await pausedRun;
    expect(pausedResults.map((result) => result.id)).toEqual([1, 2]);

    paused = false;
    const remaining = photos.filter(
      (photo) => !persistedIds.includes(photo.id)
    );
    const resumedRun = pool.embedWithPool(
      remaining,
      undefined,
      () => paused,
      (results) => {
        persistedIds.push(...results.map((result) => result.id));
      }
    );
    await vi.advanceTimersByTimeAsync(50);
    await resumedRun;
    expect(persistedIds).toEqual([1, 2, 3, 4, 5, 6]);

    let cancelled = false;
    const cancelledRun = pool.embedWithPool(
      photos,
      undefined,
      () => cancelled,
      () => {
        cancelled = true;
        pool.abortAllWorkers();
      }
    );
    await vi.advanceTimersByTimeAsync(20);
    const cancelledResults = await cancelledRun;
    expect(cancelledResults.map((result) => result.id)).toEqual([1, 2]);
    expect(childProcessMock.controls.abortMessages).toBeGreaterThan(0);

    pool.shutdownPool();
    await vi.advanceTimersByTimeAsync(500);
  });
});
