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
} = {}) {
  let child;
  let tail = Promise.resolve();
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
      if (useProcess) {
        child = track(
          fork(
            workerPath ??
              fileURLToPath(new URL("./heif-worker.mjs", import.meta.url)),
            [],
            {
              execArgv: process.execArgv.filter(
                (arg) => !arg.startsWith("--input-type")
              ),
              serialization: "advanced",
              stdio: ["ignore", "ignore", "pipe", "ipc"],
              env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
            }
          )
        );
      } else {
        child = new Worker(
          workerPath ??
            fileURLToPath(new URL("./heif-worker.mjs", import.meta.url)),
          {
            execArgv: process.execArgv.filter(
              (arg) => !arg.startsWith("--input-type")
            ),
            stdout: true,
            stderr: true,
          }
        );
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
  async function resolveResult(input, options = {}) {
    const scheduledGeneration = generation;
    const supported = await isHeifInput(input);
    assertGeneration(scheduledGeneration);
    if (!supported) {
      return null;
    }
    const identity = await sourceIdentity(input);
    assertGeneration(scheduledGeneration);
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
    if (pending.has(key)) {
      const result = await pending.get(key);
      await assertSource(input, identity, scheduledGeneration);
      return result;
    }
    const queuedAt = performance.now();
    let queueMs = 0;
    const job = tail
      .then(async () => {
        await assertSource(input, identity, scheduledGeneration);
        queueMs = performance.now() - queuedAt;
        return decode(input, options);
      })
      .then(async (result) => {
        await assertSource(input, identity, scheduledGeneration);
        if (result.timings) {
          result.timings.queueMs = queueMs;
        }
        if (result.buffer) {
          result.buffer = Buffer.from(result.buffer);
        }
        return result;
      });
    pending.set(key, job);
    tail = job.catch(() => undefined);
    try {
      return await job;
    } finally {
      if (pending.get(key) === job) {
        pending.delete(key);
      }
    }
  }
  async function resolveInput(input) {
    const result = await resolveResult(input);
    return result ? result.buffer : input;
  }
  function stop() {
    generation++;
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
