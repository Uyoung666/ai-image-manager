import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isHeifInput } from "./heif-decoder.mjs";

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
  function stop() {
    clearTimeout(idleTimer);
    if (useProcess) {
      child?.kill();
    } else {
      child?.terminate();
    }
    child = undefined;
  }
  function decode(input) {
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
        stop();
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
        if (error) {
          reject(error);
        } else {
          resolve(result);
        }
        idleTimer = setTimeout(stop, 10_000);
        idleTimer.unref();
        active.unref();
        active.channel?.unref();
      }
      function onMessage(message) {
        finish(message.error ? new Error(message.error) : null, message.result);
      }
      function onError(error) {
        stop();
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
        active.postMessage({ input });
        return;
      }
      active.send({ input }, (error) => {
        if (error) {
          onError(error);
        }
      });
    });
  }
  async function resolveInput(input) {
    if (!(await isHeifInput(input))) {
      return input;
    }
    const key = input;
    if (pending.has(key)) {
      return pending.get(key);
    }
    const job = tail
      .then(() => decode(input))
      .then((result) => Buffer.from(result.buffer));
    pending.set(key, job);
    tail = job.catch(() => undefined);
    try {
      return await job;
    } finally {
      pending.delete(key);
    }
  }
  return { resolveInput, stop };
}

// Threads die with their owning AI process, including forced pool termination.
const localResolver = createHeifResolver({ useProcess: false });
export const resolveHeifInput = localResolver.resolveInput;
export const stopHeifDecoder = localResolver.stop;
