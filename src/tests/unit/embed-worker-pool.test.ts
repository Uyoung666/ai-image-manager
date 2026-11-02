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
      if (
        event === "message" &&
        ["result", "provider-error"].includes(args[0]?.type) &&
        args[0].requestId === undefined
      ) {
        const dispatched = this.send.mock.calls
          .filter(([message]) => message.type === "embed")
          .at(-1)?.[0];
        args[0] = { requestId: dispatched?.requestId, ...args[0] };
      }
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

const gpuDetectorMock = vi.hoisted(() => ({
  probeEmbeddingGpuCapability: vi.fn(),
}));

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

vi.mock("@/services/gpu-detector", () => gpuDetectorMock);
vi.mock("@/utils/data-path", () => ({ getDataPath: () => process.cwd() }));
vi.mock("../../../scripts/heif-decoder.mjs", () => ({
  isHeifInput: vi.fn().mockResolvedValue(false),
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
    gpuDetectorMock.probeEmbeddingGpuCapability.mockReset();
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

  it.runIf(process.platform === "win32" && process.arch === "x64")(
    "sends DirectML to the worker after a successful image probe",
    async () => {
      vi.stubEnv("AI_EMBED_WORKERS", "1");
      gpuDetectorMock.probeEmbeddingGpuCapability.mockResolvedValue({
        dmlAvailable: true,
        probeTimeMs: 1,
      });
      const { initWorkerPool, shutdownPool } = await import(
        "@/services/embed-worker-pool"
      );
      const initialization = initWorkerPool("model-path", true);
      await Promise.resolve();
      await Promise.resolve();

      const child = childProcessMock.children[0];
      expect(child).toBeDefined();
      expect(child?.send).toHaveBeenCalledWith(
        expect.objectContaining({
          execution: expect.objectContaining({ provider: "directml" }),
          type: "init",
        })
      );
      emitReady(child);
      await vi.advanceTimersByTimeAsync(50);
      await initialization;
      expect(
        gpuDetectorMock.probeEmbeddingGpuCapability
      ).toHaveBeenCalledOnce();
      shutdownPool();
    }
  );

  it.runIf(process.platform === "win32" && process.arch === "x64")(
    "restarts on CPU instead of respawning a failed DirectML worker",
    async () => {
      vi.stubEnv("AI_EMBED_WORKERS", "1");
      gpuDetectorMock.probeEmbeddingGpuCapability.mockResolvedValue({
        dmlAvailable: true,
        probeTimeMs: 1,
      });
      const { initWorkerPool, shutdownPool } = await import(
        "@/services/embed-worker-pool"
      );
      const initialization = initWorkerPool("model-path", true);
      await Promise.resolve();
      await Promise.resolve();

      const gpuChild = childProcessMock.children[0];
      expect(gpuChild).toBeDefined();
      gpuChild?.emit("exit", 1, null);
      await vi.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      await Promise.resolve();

      const cpuChild = childProcessMock.children[1];
      expect(cpuChild).toBeDefined();
      expect(cpuChild?.send).toHaveBeenCalledWith(
        expect.objectContaining({
          execution: expect.objectContaining({ provider: "cpu" }),
          type: "init",
        })
      );
      emitReady(cpuChild);
      await vi.advanceTimersByTimeAsync(50);
      await initialization;
      expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
      shutdownPool();
    }
  );

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

    const settled = vi.fn();
    result.then(settled);
    await Promise.resolve();
    expect(settled).not.toHaveBeenCalled();
    child.emit("message", {
      type: "result",
      ...getWorkerIdentity(child),
      results: [{ id: 0, vector: normalizedVector() }],
    });
    await expect(result).resolves.toHaveLength(768);
    shutdownPool();
  });

  it("balances HEIF work and ignores duplicate or stale per-photo progress", async () => {
    const { isHeifInput } = await import("../../../scripts/heif-decoder.mjs");
    vi.mocked(isHeifInput).mockResolvedValue(true);
    const { embedWithPool, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const init = initWorkerPool("model-path");
    for (const child of childProcessMock.children) {
      emitReady(child);
    }
    await vi.advanceTimersByTimeAsync(50);
    await init;
    const progress = vi.fn();
    const pending = embedWithPool(
      Array.from({ length: 20 }, (_, id) => ({ id, path: `${id}.heic` })),
      progress
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let round = 0; round < 2; round++) {
      for (const child of childProcessMock.children) {
        const message = child.send.mock.calls
          .filter(([msg]) => msg.type === "embed")
          .at(-1)?.[0];
        expect(message.photos).toHaveLength(5);
        const event = {
          type: "photo-progress",
          ...getWorkerIdentity(child),
          requestId: message.requestId,
          id: message.photos[0].id,
        };
        child.emit("message", { ...event, requestId: -1 });
        const before = progress.mock.calls.length;
        child.emit("message", event);
        child.emit("message", event);
        expect(progress.mock.calls.length).toBe(before + 1);
        child.emit("message", {
          type: "result",
          ...getWorkerIdentity(child),
          requestId: message.requestId,
          results: message.photos.map((photo: { id: number }) => ({
            id: photo.id,
            vector: normalizedVector(),
          })),
        });
      }
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(await pending).toHaveLength(20);
    expect(progress).toHaveBeenLastCalledWith(20, 20);
    shutdownPool();
    vi.mocked(isHeifInput).mockResolvedValue(false);
  });

  it("keeps the dispatch watchdog after receiving per-photo progress", async () => {
    vi.stubEnv("AI_EMBED_WORKERS", "1");
    const { embedSingleImage, initWorkerPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    const init = initWorkerPool("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await vi.advanceTimersByTimeAsync(50);
    await init;
    const pending = embedSingleImage("sample.png", "model-path");
    const rejected = expect(pending).rejects.toThrow("timed out");
    const request = child.send.mock.calls
      .filter(([message]) => message.type === "embed")
      .at(-1)?.[0];
    child.emit("message", {
      type: "photo-progress",
      ...getWorkerIdentity(child),
      requestId: request.requestId,
      id: 0,
    });
    await vi.advanceTimersByTimeAsync(300_000);
    await rejected;
    expect(child.kill).toHaveBeenCalled();
    shutdownPool();
  });
});
