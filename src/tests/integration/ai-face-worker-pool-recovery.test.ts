import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

interface SentMessage {
  photos?: Array<{ id: number; path: string }>;
  requestId?: string;
  type?: string;
}

const childProcessMock = vi.hoisted(() => {
  type Listener = (...args: unknown[]) => void;
  const controls = { respondToDetect: true };

  class FakeChildProcess {
    killed = false;
    private readonly listeners = new Map<string, Listener[]>();
    readonly stderr = { on: vi.fn() };
    readonly send = vi.fn((message: SentMessage) => {
      if (message.type === "init") {
        setTimeout(() => this.emit("message", { type: "ready" }), 0);
      } else if (message.type === "detect" && controls.respondToDetect) {
        setTimeout(
          () =>
            this.emit("message", {
              requestId: message.requestId,
              results: (message.photos ?? []).map((photo) => ({
                faces: [],
                id: photo.id,
              })),
              type: "result",
            }),
          0
        );
      }
      return true;
    });
    readonly kill = vi.fn(() => {
      if (!this.killed) {
        this.killed = true;
        this.emit("exit", 1, null);
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
    isPackaged: false,
  },
}));

vi.mock("@/services/diagnostics/worker-output", () => ({
  captureWorkerOutput: vi.fn(),
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  }),
}));

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  childProcessMock.children.length = 0;
  childProcessMock.fork.mockClear();
  childProcessMock.controls.respondToDetect = true;
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

async function initializePool() {
  const pool = await import("@/services/face-worker-pool");
  const initialization = pool.initFaceWorkerPool("models", false);
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(50);
  await initialization;
  return pool;
}

describe("face worker pool lifecycle recovery", () => {
  it("respawns a worker after the dispatch timeout instead of losing the slot", async () => {
    const pool = await initializePool();
    const initialForkCount = childProcessMock.fork.mock.calls.length;
    childProcessMock.controls.respondToDetect = false;
    let cancelled = false;

    const run = pool.detectFacesWithPool(
      [{ id: 1, path: "slow.png" }],
      1,
      undefined,
      () => cancelled
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.advanceTimersByTimeAsync(1000);

    expect(childProcessMock.fork.mock.calls.length).toBeGreaterThan(
      initialForkCount
    );
    childProcessMock.controls.respondToDetect = true;
    cancelled = true;
    pool.shutdownFacePool();
    await expect(run).resolves.toEqual([
      expect.objectContaining({ id: 1, error: expect.any(String) }),
    ]);
  });

  it("settles queued requests when shutdown interrupts the pool", async () => {
    const pool = await initializePool();
    childProcessMock.controls.respondToDetect = false;
    let cancelled = false;
    const run = pool.detectFacesWithPool(
      Array.from({ length: 4 }, (_, index) => ({
        id: index + 1,
        path: `${index + 1}.png`,
      })),
      1,
      undefined,
      () => cancelled
    );

    cancelled = true;
    pool.shutdownFacePool();
    await expect(run).resolves.toEqual(expect.any(Array));
    expect(pool.getFacePoolHealth().queueLength).toBe(0);
  });
});
