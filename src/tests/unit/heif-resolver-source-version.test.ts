/** @vitest-environment node */
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { createHeifResolver } from "../../../scripts/heif-input.mjs";

const state = vi.hoisted(() => ({ fork: vi.fn(), isHeif: vi.fn() }));
vi.mock("node:child_process", () => ({ fork: state.fork }));
vi.mock("../../../scripts/heif-decoder.mjs", () => ({
  isHeifInput: state.isHeif,
}));

class Decoder extends EventEmitter {
  connected = true;
  stderr = { resume: vi.fn() };
  channel = { ref: vi.fn(), unref: vi.fn() };
  ref = vi.fn();
  unref = vi.fn();
  send = vi.fn((_message: unknown, callback: (error: null) => void) =>
    callback(null)
  );
  kill = vi.fn(() => {
    this.connected = false;
    this.emit("exit", 0);
    return true;
  });

  respond(pixels: string) {
    this.emit("message", {
      result: {
        buffer: Buffer.from(pixels),
        originalWidth: 1,
        originalHeight: 1,
        width: 1,
        height: 1,
      },
    });
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

const flushQueue = () => new Promise<void>((resolve) => setImmediate(resolve));
let runtime: TestRuntime;
let source: string;
let resolver: ReturnType<typeof createHeifResolver>;
let workers: Decoder[];

beforeEach(() => {
  vi.clearAllMocks();
  runtime = new TestRuntime("heif-resolver-source-version");
  source = path.join(runtime.root, "source.heic");
  fs.writeFileSync(source, "red!");
  // Keep the stat awaits deterministic while exercising real file identities.
  vi.spyOn(fs.promises, "stat").mockImplementation(async (file) =>
    fs.statSync(file)
  );
  workers = [];
  state.isHeif.mockResolvedValue(true);
  state.fork.mockImplementation(() => {
    const worker = new Decoder();
    workers.push(worker);
    return worker;
  });
  resolver = createHeifResolver();
});

afterEach(() => {
  resolver.stop();
  vi.restoreAllMocks();
  expect(runtime.cleanup().status).toBe("deleted");
});

describe("HEIF resolver source versions", () => {
  it("shares one decode for unchanged path requests", async () => {
    const first = resolver.resolveResult(source);
    const second = resolver.resolveResult(source);
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    workers[0].respond("red pixels");
    const results = await Promise.all([first, second]);
    expect(results[0]).toBe(results[1]);
    expect(results[0]?.buffer.toString()).toBe("red pixels");
  });

  it("skips cancelled prefetch and promotes a shared queued decode ahead of other work", async () => {
    const active = resolver.resolveResult(Buffer.from("active"));
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    const request = new AbortController();
    const cancelled = resolver.resolveResult(
      Buffer.from("obsolete"),
      {},
      { signal: request.signal, priority: () => 2 }
    );
    const discarded = expect(cancelled).rejects.toMatchObject({
      name: "AbortError",
    });
    const nextBackground = Buffer.from("background");
    const background = resolver.resolveResult(
      nextBackground,
      {},
      { priority: () => 2 }
    );
    const target = Buffer.from("foreground");
    const prefetched = resolver.resolveResult(
      target,
      {},
      { priority: () => 2 }
    );
    await flushQueue();
    const foreground = resolver.resolveResult(
      target,
      {},
      { priority: () => 0 }
    );
    await flushQueue();
    request.abort();
    workers[0].respond("active done");
    await active;
    await discarded;
    await vi.waitFor(() => expect(workers[0].send).toHaveBeenCalledTimes(2));
    expect(workers[0].send.mock.calls[1][0]).toMatchObject({ input: target });
    workers[0].respond("foreground done");
    const [one, two] = await Promise.all([prefetched, foreground]);
    expect(one).toBe(two);
    await vi.waitFor(() => expect(workers[0].send).toHaveBeenCalledTimes(3));
    expect(workers[0].send.mock.calls[2][0]).toMatchObject({
      input: nextBackground,
    });
    workers[0].respond("background done");
    await background;
  });

  it.each([
    {},
    { output: "import" as const, thumbnailSize: 512 },
  ])("isolates replacement pixels from a previous decode with options %j", async (options) => {
    const previousStat = fs.statSync(source);
    const previous = resolver.resolveResult(source, options);
    const rejected = expect(previous).rejects.toThrow("source changed");
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    fs.renameSync(source, path.join(runtime.root, "moved.heic"));
    fs.writeFileSync(source, "blue");
    fs.utimesSync(source, previousStat.atime, previousStat.mtime);
    const current = resolver.resolveResult(source, options);
    await flushQueue();
    workers[0].respond("red pixels");
    await rejected;
    await vi.waitFor(() => expect(workers[0].send).toHaveBeenCalledTimes(2));
    workers[0].respond("blue pixels");
    expect((await current)?.buffer.toString()).toBe("blue pixels");
  });

  it("rejects a source changed while queued before opening it in the decoder", async () => {
    const blocked = resolver.resolveResult(source);
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    const queuedSource = path.join(runtime.root, "queued.heic");
    fs.writeFileSync(queuedSource, "before");
    const queued = resolver.resolveResult(queuedSource);
    const rejected = expect(queued).rejects.toThrow("source changed");
    await flushQueue();
    fs.writeFileSync(queuedSource, "replaced while waiting");
    workers[0].respond("first pixels");
    await blocked;
    await rejected;
    expect(workers[0].send).toHaveBeenCalledOnce();
    const retried = resolver.resolveResult(queuedSource);
    await vi.waitFor(() => expect(workers[0].send).toHaveBeenCalledTimes(2));
    workers[0].respond("latest pixels");
    expect((await retried)?.buffer.toString()).toBe("latest pixels");
  });

  it("preserves Buffer identity coalescing and separate output policies", async () => {
    const input = Buffer.from("immutable input");
    const first = resolver.resolveResult(input);
    const duplicate = resolver.resolveResult(input);
    const pixels = resolver.resolveResult(input, { output: "pixels" });
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    workers[0].respond("png");
    const results = await Promise.all([first, duplicate]);
    expect(results[0]).toBe(results[1]);
    await vi.waitFor(() => expect(workers[0].send).toHaveBeenCalledTimes(2));
    workers[0].respond("rgba");
    expect((await pixels)?.buffer.toString()).toBe("rgba");
    expect(fs.promises.stat).not.toHaveBeenCalled();
  });

  it("cancels a request stopped during header inspection", async () => {
    const inspection = deferred<boolean>();
    state.isHeif.mockReturnValueOnce(inspection.promise);
    const pending = resolver.resolveResult(source);
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    resolver.stop();
    inspection.resolve(true);
    await cancelled;
    expect(state.fork).not.toHaveBeenCalled();
  });

  it("cancels a request stopped while its initial source stat is pending", async () => {
    const snapshot = deferred<fs.Stats>();
    vi.mocked(fs.promises.stat).mockReturnValueOnce(snapshot.promise);
    const pending = resolver.resolveResult(source);
    const cancelled = expect(pending).rejects.toThrow("cancelled");
    await flushQueue();
    resolver.stop();
    snapshot.resolve(fs.statSync(source));
    await cancelled;
    expect(state.fork).not.toHaveBeenCalled();
  });

  it("does not join stopped Buffer work when a new generation requests the same Buffer", async () => {
    const input = Buffer.from("same input across restart");
    const previous = resolver.resolveResult(input);
    const cancelled = expect(previous).rejects.toThrow("exited");
    await vi.waitFor(() => expect(workers[0]?.send).toHaveBeenCalledOnce());
    resolver.stop();
    const current = resolver.resolveResult(input);
    await cancelled;
    await vi.waitFor(() => expect(workers[1]?.send).toHaveBeenCalledOnce());
    workers[1].respond("new generation");
    expect((await current)?.buffer.toString()).toBe("new generation");
  });

  it("keeps non-HEIF fallback inputs unchanged without additional stat calls", async () => {
    state.isHeif.mockResolvedValue(false);
    expect(await resolver.resolveInput(source)).toBe(source);
    expect(fs.promises.stat).not.toHaveBeenCalled();
    expect(state.fork).not.toHaveBeenCalled();
  });
});
