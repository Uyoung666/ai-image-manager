import { describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;

  class FakeChildProcess {
    private readonly listeners = new Map<string, Listener[]>();
    readonly kill = vi.fn(() => {
      this.emit("exit", 0, null);
      return true;
    });
    readonly send = vi.fn();
    readonly stderr = {
      on: vi.fn(),
    };

    on(event: string, listener: Listener) {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }

    emit(event: string, ...args: any[]) {
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

  return { children, fork };
});

vi.mock("node:child_process", () => ({
  default: {
    fork: childProcessMock.fork,
  },
  fork: childProcessMock.fork,
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

describe("embed worker pool config", () => {
  it("keeps CPU-only defaults conservative", async () => {
    const { resolveEmbedPoolConfig } = await import(
      "@/services/embed-worker-pool"
    );

    expect(resolveEmbedPoolConfig(4, false, {})).toEqual({
      batchSize: 20,
      intraOpNumThreads: 3,
      workers: 1,
    });
    expect(resolveEmbedPoolConfig(12, false, {})).toEqual({
      batchSize: 20,
      intraOpNumThreads: 4,
      workers: 2,
    });
  });

  it("clamps env overrides to safe bounds", async () => {
    const { resolveEmbedPoolConfig } = await import(
      "@/services/embed-worker-pool"
    );

    expect(
      resolveEmbedPoolConfig(8, false, {
        AI_EMBED_BATCH_SIZE: "500",
        AI_EMBED_THREADS: "99",
        AI_EMBED_WORKERS: "99",
      })
    ).toEqual({
      batchSize: 100,
      intraOpNumThreads: 2,
      workers: 3,
    });
  });
});

describe("embed worker pool lifecycle", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("AI_EMBED_WORKERS", "2");
    childProcessMock.children.length = 0;
    childProcessMock.fork.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("shares one initialization across concurrent callers", async () => {
    const { initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );

    const first = initWorkerPool("model-path");
    const second = initWorkerPool("model-path");

    expect(first).toBe(second);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);

    for (const child of childProcessMock.children) {
      child.emit("message", { type: "ready" });
    }
    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);

    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    expect(childProcessMock.fork.mock.calls[0]?.[2]).not.toHaveProperty(
      "timeout"
    );
    shutdownPool();
  });

  it("does not let an old pool respawn into a replacement generation", async () => {
    const { initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );

    const firstInit = initWorkerPool("model-path");
    const oldChildren = [...childProcessMock.children];
    for (const child of oldChildren) {
      child.emit("message", { type: "ready" });
    }
    await vi.advanceTimersByTimeAsync(50);
    await firstInit;

    shutdownPool();
    const secondInit = initWorkerPool("model-path");
    const newChildren = childProcessMock.children.slice(2);
    for (const child of newChildren) {
      child.emit("message", { type: "ready" });
    }
    await vi.advanceTimersByTimeAsync(50);
    await secondInit;

    oldChildren[0]?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1500);

    expect(childProcessMock.fork).toHaveBeenCalledTimes(4);
    shutdownPool();
  });
});
