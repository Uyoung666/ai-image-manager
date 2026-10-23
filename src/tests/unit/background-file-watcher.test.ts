/** @vitest-environment node */
import type { EventEmitter } from "node:events";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FileWatcherOptions } from "@/services/background-file-watcher";

const state = vi.hoisted(() => ({
  workers: [] as Array<
    EventEmitter & {
      sent: Array<{ type: string; id: number }>;
      terminate: ReturnType<typeof vi.fn>;
    }
  >,
}));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      sent: Array<{ type: string; id: number }> = [];
      terminate = vi.fn(async () => 0);
      constructor() {
        super();
        state.workers.push(this);
      }
      postMessage(message: { type: string; id: number }) {
        this.sent.push(message);
      }
    },
  };
});
const options: FileWatcherOptions = {
  ignored: [/\.cache/],
  ignoreInitial: true,
  ignorePermissionErrors: true,
  depth: 10,
  awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
};
let create: typeof import("@/services/background-file-watcher").createBackgroundWatcher;
beforeEach(async () => {
  vi.resetModules();
  state.workers = [];
  create = (await import("@/services/background-file-watcher"))
    .createBackgroundWatcher;
});

describe("shared host file watcher", () => {
  it("shares one worker, routes events, and terminates after the last close", async () => {
    const first = create("first", options);
    const second = create("second", options);
    const worker = state.workers[0];
    expect(state.workers).toHaveLength(1);
    const [a, b] = worker.sent;
    const add = vi.fn();
    const unlink = vi.fn();
    const ready = vi.fn();
    first.on("add", add).on("ready", ready);
    second.on("unlink", unlink);
    worker.emit("message", { type: "ready", id: a.id });
    worker.emit("message", {
      type: "event",
      id: a.id,
      event: "add",
      path: "a.webp",
    });
    worker.emit("message", {
      type: "event",
      id: b.id,
      event: "unlink",
      path: "b.webp",
    });
    expect(ready).toHaveBeenCalledOnce();
    expect(add).toHaveBeenCalledWith("a.webp");
    expect(unlink).toHaveBeenCalledWith("b.webp");
    const closingFirst = first.close();
    worker.emit("message", { type: "closed", id: a.id });
    await closingFirst;
    expect(worker.terminate).not.toHaveBeenCalled();
    const closingSecond = second.close();
    worker.emit("message", { type: "closed", id: b.id });
    await closingSecond;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("closes before readiness, ignores retired events, and shares the close promise", async () => {
    const watcher = create("first", options);
    const worker = state.workers[0];
    const id = worker.sent[0].id;
    const callback = vi.fn();
    watcher.on("add", callback);
    const closing = watcher.close();
    expect(watcher.close()).toBe(closing);
    expect(worker.sent.map((message) => message.type)).toEqual([
      "watch",
      "close",
    ]);
    worker.emit("message", {
      type: "event",
      id,
      event: "add",
      path: "late.webp",
    });
    worker.emit("message", { type: "closed", id });
    await closing;
    worker.emit("message", {
      type: "event",
      id,
      event: "add",
      path: "retired.webp",
    });
    expect(callback).not.toHaveBeenCalled();
  });

  it("preserves native error fields and rejects a failed close after releasing the thread", async () => {
    const watcher = create("first", options);
    const worker = state.workers[0];
    const id = worker.sent[0].id;
    const error = vi.fn();
    watcher.on("error", error);
    worker.emit("message", {
      type: "error",
      id,
      error: { message: "denied", code: "EACCES", syscall: "watch" },
    });
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ code: "EACCES", syscall: "watch" })
    );
    const closing = watcher.close();
    const rejected = expect(closing).rejects.toMatchObject({
      message: "close failed",
    });
    worker.emit("message", {
      type: "closed",
      id,
      error: { message: "close failed" },
    });
    await rejected;
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("settles pending closes and reports active watchers when a worker crashes", async () => {
    const first = create("first", options);
    const second = create("second", options);
    const worker = state.workers[0];
    const error = vi.fn();
    second.on("error", error);
    const closing = first.close();
    const rejected = expect(closing).rejects.toThrow("worker failed");
    worker.emit("error", new Error("worker failed"));
    await rejected;
    expect(error).toHaveBeenCalledOnce();
    await expect(second.close()).rejects.toThrow("worker failed");
    const replacement = create("replacement", options);
    expect(state.workers).toHaveLength(2);
    const next = state.workers[1];
    const done = replacement.close();
    next.emit("message", { type: "closed", id: next.sent[0].id });
    await done;
  });
});
