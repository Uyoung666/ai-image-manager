import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const childProcessMock = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;

  class FakeChildProcess {
    connected = true;
    killed = false;
    private readonly listeners = new Map<string, Listener[]>();
    readonly kill = vi.fn(() => {
      this.connected = false;
      this.killed = true;
      this.emit("exit", 0, null);
      return true;
    });
    readonly send = vi.fn();

    on(event: string, listener: Listener) {
      const listeners = this.listeners.get(event) ?? [];
      listeners.push(listener);
      this.listeners.set(event, listeners);
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

vi.mock("node:child_process", () => ({
  default: {
    fork: childProcessMock.fork,
  },
  fork: childProcessMock.fork,
}));

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
  },
}));

function vectors(count: number): number[][] {
  return Array.from({ length: count }, () =>
    Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0))
  );
}

describe("text embedding worker client", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.stubEnv("AI_EMBEDDING_MODEL", "siglip");
    childProcessMock.children.length = 0;
    childProcessMock.fork.mockClear();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("shares initialization and maps batch responses by request id", async () => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const first = initTextWorker("model-path");
    const second = initTextWorker("model-path");
    expect(first).toBe(second);
    expect(childProcessMock.fork).toHaveBeenCalledOnce();

    const child = childProcessMock.children[0];
    emitReady(child);
    await Promise.all([first, second]);

    const resultPromise = embedTextsInWorker(["one", "two"], "model-path");
    await vi.waitFor(() => {
      expect(child.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "embed", texts: ["one", "two"] })
      );
    });
    const request = child.send.mock.calls.find(
      ([message]) => message.type === "embed"
    )?.[0];
    child.emit("message", {
      type: "result",
      requestId: request.requestId,
      ...getWorkerIdentity(child),
      vectors: vectors(2),
    });

    await expect(resultPromise).resolves.toHaveLength(2);
    shutdownTextWorker();
  });

  it("rejects pending work on exit and starts a fresh worker next time", async () => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const init = initTextWorker("model-path");
    const firstChild = childProcessMock.children[0];
    emitReady(firstChild);
    await init;

    const pending = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    firstChild.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("exited");

    const replacement = initTextWorker("model-path");
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    emitReady(childProcessMock.children[1]);
    await replacement;
    shutdownTextWorker();
  });

  it("rejects invalid vectors and clears pending work on shutdown", async () => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const init = initTextWorker("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await init;

    const invalid = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    const request = child.send.mock.calls.find(
      ([message]) => message.type === "embed"
    )?.[0];
    child.emit("message", {
      type: "result",
      requestId: request.requestId,
      ...getWorkerIdentity(child),
      vectors: [[1]],
    });
    await expect(invalid).rejects.toThrow("Invalid text embedding result");

    const pending = embedTextsInWorker(["two"], "model-path");
    await Promise.resolve();
    shutdownTextWorker();
    await expect(pending).rejects.toThrow("shut down");
  });

  it("times out initialization and terminates the stuck worker", async () => {
    const { initTextWorker } = await import("@/services/ai/text-worker-client");
    const initialization = initTextWorker("model-path");
    const rejection = expect(initialization).rejects.toThrow(
      "initialization timed out"
    );

    await vi.advanceTimersByTimeAsync(300_001);

    await rejection;
    expect(childProcessMock.children[0].kill).toHaveBeenCalledOnce();
  });

  it("rejects a ready message with missing model identity", async () => {
    const { initTextWorker } = await import("@/services/ai/text-worker-client");
    const initialization = initTextWorker("model-path");
    const child = childProcessMock.children[0];

    child.emit("message", { type: "ready" });

    await expect(initialization).rejects.toThrow(
      "Stale text embedding worker ready"
    );
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it("does not let an old ready message supersede a replacement", async () => {
    const { initTextWorker, shutdownTextWorker } = await import(
      "@/services/ai/text-worker-client"
    );
    const first = initTextWorker("model-a");
    const firstRejection = expect(first).rejects.toThrow(
      "Stale text embedding worker ready"
    );
    const firstChild = childProcessMock.children[0];

    const replacement = initTextWorker("model-b");
    const replacementChild = childProcessMock.children[1];
    firstChild.emit("message", {
      type: "ready",
      ...getWorkerIdentity(firstChild),
    });
    emitReady(replacementChild);

    await firstRejection;
    await replacement;
    await initTextWorker("model-b");
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    shutdownTextWorker();
  });

  it.each([
    ["empty", [[]]],
    ["wrong-dimensional", [[1]]],
    [
      "non-finite",
      [[Number.POSITIVE_INFINITY, ...Array.from({ length: 767 }, () => 0)]],
    ],
    ["non-L2", [Array.from({ length: 768 }, () => 0)]],
  ])("rejects a %s text vector", async (_label, invalidVectors) => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const initialization = initTextWorker("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await initialization;

    const result = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    const request = child.send.mock.calls.find(
      ([message]) => message.type === "embed"
    )?.[0];
    child.emit("message", {
      type: "result",
      requestId: request.requestId,
      ...getWorkerIdentity(child),
      vectors: invalidVectors,
    });

    await expect(result).rejects.toThrow("Invalid text embedding result");
    shutdownTextWorker();
  });

  it("discards a text result from an old adapter run", async () => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const initialization = initTextWorker("model-path");
    const child = childProcessMock.children[0];
    emitReady(child);
    await initialization;

    const result = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    const request = child.send.mock.calls.find(
      ([message]) => message.type === "embed"
    )?.[0];
    child.emit("message", {
      type: "result",
      requestId: request.requestId,
      adapterId: "old-adapter",
      fingerprint: "0".repeat(64),
      vectors: vectors(1),
    });

    await expect(result).rejects.toThrow("Stale text embedding worker result");
    shutdownTextWorker();
  });
});
