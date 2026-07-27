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
    Array.from({ length: 768 }, () => 0.5)
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
    child.emit("message", { type: "ready" });
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
    firstChild.emit("message", { type: "ready" });
    await init;

    const pending = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    firstChild.emit("exit", 1, null);
    await expect(pending).rejects.toThrow("exited");

    const replacement = initTextWorker("model-path");
    expect(childProcessMock.fork).toHaveBeenCalledTimes(2);
    childProcessMock.children[1].emit("message", { type: "ready" });
    await replacement;
    shutdownTextWorker();
  });

  it("rejects invalid vectors and clears pending work on shutdown", async () => {
    const { embedTextsInWorker, initTextWorker, shutdownTextWorker } =
      await import("@/services/ai/text-worker-client");
    const init = initTextWorker("model-path");
    const child = childProcessMock.children[0];
    child.emit("message", { type: "ready" });
    await init;

    const invalid = embedTextsInWorker(["one"], "model-path");
    await Promise.resolve();
    const request = child.send.mock.calls.find(
      ([message]) => message.type === "embed"
    )?.[0];
    child.emit("message", {
      type: "result",
      requestId: request.requestId,
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
});
