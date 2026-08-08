import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  const fork = vi.fn((..._args: unknown[]) => {
    const child = new FakeChildProcess();
    children.push(child);
    return child;
  });

  return { children, fork };
});

function getWorkerIdentity(child: (typeof childProcessMock.children)[number]): {
  adapterId: string;
  fingerprint: string;
} {
  const initMessage = child.send.mock.calls.find(
    ([message]) => message.type === "init"
  )?.[0];
  return {
    adapterId: initMessage.adapter.adapterId,
    fingerprint: initMessage.adapter.fingerprint,
  };
}

function emitReady(child: (typeof childProcessMock.children)[number]): void {
  child.emit("message", { type: "ready", ...getWorkerIdentity(child) });
}

function normalizedVector(): number[] {
  return [1, ...Array.from({ length: 767 }, () => 0)];
}

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
      emitReady(child);
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
      emitReady(child);
    }
    await vi.advanceTimersByTimeAsync(50);
    await firstInit;

    shutdownPool();
    const secondInit = initWorkerPool("model-path");
    const newChildren = childProcessMock.children.slice(2);
    for (const child of newChildren) {
      emitReady(child);
    }
    await vi.advanceTimersByTimeAsync(50);
    await secondInit;

    oldChildren[0]?.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(1500);

    expect(childProcessMock.fork).toHaveBeenCalledTimes(4);
    shutdownPool();
  });

  it("respawns a crashed worker with the same adapter identity", async () => {
    const { getPoolHealth, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const initialization = initWorkerPool("model-path");
    for (const child of childProcessMock.children) {
      emitReady(child);
    }
    await vi.advanceTimersByTimeAsync(50);
    await initialization;

    const crashed = childProcessMock.children[0];
    const expectedIdentity = getWorkerIdentity(crashed);
    crashed.emit("exit", 1, null);
    expect(getPoolHealth()).toMatchObject({ alive: 1, dead: 1 });

    await vi.advanceTimersByTimeAsync(1000);
    expect(childProcessMock.fork).toHaveBeenCalledTimes(3);
    const replacement = childProcessMock.children[2];
    expect(getWorkerIdentity(replacement)).toEqual(expectedIdentity);
    expect(replacement.send).toHaveBeenCalledWith(
      expect.objectContaining({
        execution: expect.objectContaining({ provider: "cpu" }),
        type: "init",
      })
    );
    emitReady(replacement);
    expect(getPoolHealth()).toMatchObject({ alive: 2, dead: 0, idle: 2 });
    shutdownPool();
  });

  it("rejects a worker whose ready identity does not match", async () => {
    vi.stubEnv("AI_EMBED_WORKERS", "1");
    const { initWorkerPool } = await import("@/services/embed-worker-pool");

    const initialization = initWorkerPool("model-path");
    const rejection =
      expect(initialization).rejects.toThrow("died during init");
    const child = childProcessMock.children[0];
    child.emit("message", {
      type: "ready",
      adapterId: "old-adapter",
      fingerprint: "0".repeat(64),
    });
    await vi.advanceTimersByTimeAsync(50);

    await rejection;
    expect(child.kill).toHaveBeenCalled();
  });

  it("accepts a finite 768-dimensional L2 image vector", async () => {
    vi.stubEnv("AI_EMBED_WORKERS", "1");
    const { embedSingleImage, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const initialization = initWorkerPool("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await vi.advanceTimersByTimeAsync(50);
    await initialization;

    const result = embedSingleImage("sample.png", "model-path");
    child.emit("message", {
      type: "result",
      ...getWorkerIdentity(child),
      results: [{ id: 0, vector: normalizedVector() }],
    });

    await expect(result).resolves.toHaveLength(768);
    shutdownPool();
  });

  it.each([
    ["empty", []],
    ["wrong-dimensional", [1]],
    ["non-finite", [Number.NaN, ...Array.from({ length: 767 }, () => 0)]],
    ["non-L2", Array.from({ length: 768 }, () => 0)],
  ])("rejects a %s image vector", async (_label, vector) => {
    vi.stubEnv("AI_EMBED_WORKERS", "1");
    const { embedSingleImage, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const initialization = initWorkerPool("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await vi.advanceTimersByTimeAsync(50);
    await initialization;

    const result = embedSingleImage("sample.png", "model-path");
    child.emit("message", {
      type: "result",
      ...getWorkerIdentity(child),
      results: [{ id: 0, vector }],
    });

    await expect(result).rejects.toThrow("Invalid image embedding result");
    shutdownPool();
  });

  it("discards an image result from an old adapter run", async () => {
    vi.stubEnv("AI_EMBED_WORKERS", "1");
    const { embedSingleImage, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const initialization = initWorkerPool("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await vi.advanceTimersByTimeAsync(50);
    await initialization;

    const result = embedSingleImage("sample.png", "model-path");
    child.emit("message", {
      type: "result",
      adapterId: "old-adapter",
      fingerprint: "0".repeat(64),
      results: [{ id: 0, vector: normalizedVector() }],
    });

    await expect(result).rejects.toThrow("Stale embedding worker result");
    shutdownPool();
  });
});
