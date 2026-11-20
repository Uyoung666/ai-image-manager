import { fork } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isHeifInput } from "./heif-decoder.mjs";

async function sourceIdentity(input) {
  if (typeof input !== "string") {
    return null;
  }
  const stat = await fs.stat(input);
  if (!stat.isFile()) {
    throw new Error("HEIC source is not a file");
  }
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}:${stat.dev}`;
}

/** One serial decoder per owner process. Timeout/crash rejects only the current photo. */
export function createHeifResolver({
  workerPath,
  useProcess = true,
  track = (child) => child,
  timeoutMs = 60_000,
  onDecode = () => undefined,
} = {}) {
  let child;
  let running = false;
  const queue = [];
  let idleTimer;
  const pending = new Map();
  const bufferKeys = new WeakMap();
  let generation = 0;
  function assertGeneration(expected) {
    if (generation !== expected) {
      throw new Error("HEIC decoding cancelled");
    }
  }
  async function assertSource(input, identity, expectedGeneration) {
    assertGeneration(expectedGeneration);
    const current = await sourceIdentity(input);
    assertGeneration(expectedGeneration);
    if (current !== identity) {
      throw new Error("HEIC source changed during decoding");
    }
  }
  function recycle() {
    clearTimeout(idleTimer);
    if (useProcess) {
      child?.kill();
    } else {
      child?.terminate();
    }
    child = undefined;
  }
  function decode(input, options) {
    clearTimeout(idleTimer);
    if (!child || (useProcess ? !child.connected : child.threadId === -1)) {
      const script =
        (typeof workerPath === "function" ? workerPath() : workerPath) ??
        fileURLToPath(new URL("./heif-worker.mjs", import.meta.url));
      if (useProcess) {
        child = track(
          fork(script, [], {
            execArgv: process.execArgv.filter(
              (arg) => !arg.startsWith("--input-type")
            ),
            serialization: "advanced",
            stdio: ["ignore", "ignore", "pipe", "ipc"],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
          })
        );
      } else {
        child = new Worker(script, {
          execArgv: process.execArgv.filter(
            (arg) => !arg.startsWith("--input-type")
          ),
          stdout: true,
          stderr: true,
        });
        child.stdout?.resume();
      }
      // Drain diagnostics without persisting original file paths.
      child.stderr?.resume();
    }
    const active = child;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        recycle();
        finish(new Error("HEIC decoding timed out after 60 seconds"));
      }, timeoutMs);
      function finish(error, result) {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        active.removeListener("message", onMessage);
        active.removeListener("error", onError);
        active.removeListener("exit", onExit);
        if (
          result &&
          result.originalWidth * result.originalHeight > 24_000_000
        ) {
          recycle();
        }
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
        idleTimer = setTimeout(recycle, 10_000);
        idleTimer.unref();
        active.unref();
        active.channel?.unref();
      }
      function onMessage(message) {
        finish(message.error ? new Error(message.error) : null, message.result);
      }
      function onError(error) {
        recycle();
        finish(error);
      }
      function onExit() {
        if (child === active) {
          child = undefined;
        }
        finish(new Error("HEIC decoder exited before completing the image"));
      }
      active.once("message", onMessage);
      active.once("error", onError);
      active.once("exit", onExit);
      active.ref();
      active.channel?.ref();
      if (!useProcess) {
        active.postMessage({ input, options });
        return;
      }
      active.send({ input, options }, (error) => {
        if (error) {
          onError(error);
        }
      });
    });
  }
  const cancelled = () =>
    new DOMException("HEIC decoding cancelled", "AbortError");

  function pump() {
    if (running || !queue.length) {
      return;
    }
    const priority = (job) =>
      Math.min(...[...job.consumers].map((item) => item.priority()));
    queue.sort((a, b) => priority(a) - priority(b));
    const job = queue.shift();
    running = true;
    job
      .run()
      .then(
        (result) => finishJob(job, null, result),
        (error) => finishJob(job, error)
      )
      .finally(() => {
        running = false;
        pump();
      });
  }

  function finishJob(job, error, result) {
    if (pending.get(job.key) === job) {
      pending.delete(job.key);
    }
    for (const consumer of job.consumers) {
      consumer.finish(error, result);
    }
    job.consumers.clear();
  }

  async function resolveResult(input, options = {}, request = {}) {
    const scheduledGeneration = generation;
    request.signal?.throwIfAborted();
    const supported = await isHeifInput(input);
    assertGeneration(scheduledGeneration);
    if (!supported) {
      return null;
    }
    const identity = await sourceIdentity(input);
    assertGeneration(scheduledGeneration);
    request.signal?.throwIfAborted();
    const policy = JSON.stringify(options);
    let key;
    if (typeof input === "string") {
      const normalized = path.resolve(input);
      key = `${process.platform === "win32" ? normalized.toLowerCase() : normalized}:${identity}:${policy}`;
    } else {
      let policies = bufferKeys.get(input);
      if (!policies) {
        policies = new Map();
        bufferKeys.set(input, policies);
      }
      if (!policies.has(policy)) {
        policies.set(policy, Symbol("HEIF buffer request"));
      }
      key = policies.get(policy);
    }
    let job = pending.get(key);
    if (!job) {
      const queuedAt = performance.now();
      job = {
        key,
        consumers: new Set(),
        async run() {
          await assertSource(input, identity, scheduledGeneration);
          if (!this.consumers.size) {
            throw cancelled();
          }
          const queueMs = performance.now() - queuedAt;
          onDecode(options);
          const result = await decode(input, options);
          await assertSource(input, identity, scheduledGeneration);
          if (result.timings) {
            result.timings.queueMs = queueMs;
          }
          if (result.buffer) {
            result.buffer = Buffer.from(result.buffer);
          }
          return result;
        },
      };
      pending.set(key, job);
      queue.push(job);
    }
    const active = job;
    const result = await new Promise((resolve, reject) => {
      const abort = () => {
        active.consumers.delete(consumer);
        consumer.finish(cancelled());
        const index = queue.indexOf(active);
        if (active.consumers.size === 0 && index >= 0) {
          queue.splice(index, 1);
          finishJob(active, cancelled());
        }
      };
      const consumer = {
        priority: request.priority ?? (() => 1),
        finish(error, value) {
          request.signal?.removeEventListener("abort", abort);
          if (error) {
            reject(error);
          } else {
            resolve(value);
          }
        },
      };
      active.consumers.add(consumer);
      request.signal?.addEventListener("abort", abort, { once: true });
      pump();
    });
    await assertSource(input, identity, scheduledGeneration);
    request.signal?.throwIfAborted();
    return result;
  }
  async function resolveInput(input) {
    const result = await resolveResult(input);
    return result ? result.buffer : input;
  }
  function stop() {
    generation++;
    for (const job of queue.splice(0)) {
      finishJob(job, cancelled());
    }
    pending.clear();
    recycle();
  }
  return { resolveInput, resolveResult, stop };
}

// Threads die with their owning AI process, including forced pool termination.
const localResolver = createHeifResolver({ useProcess: false });
export const resolveHeifInput = localResolver.resolveInput;
export const stopHeifDecoder = localResolver.stop;

export const resolveHeifResult = localResolver.resolveResult;
