import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface WorkerSlot {
  consecutiveFailures: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: EmbedResult[]) => void) | null;
  process: ChildProcess;
  status: WorkerStatus;
}

interface QueuedRequest {
  photos: Array<{ id: number; path: string }>;
  reject: (err: Error) => void;
  resolve: (results: EmbedResult[]) => void;
}

const BATCH_SIZE = 15;
const WORKER_TIMEOUT = 300_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESPAWN_DELAY_MS = 1000;

let slots: WorkerSlot[] = [];
let requestQueue: QueuedRequest[] = [];
let modelPath: string | null = null;
let initialized = false;
let poolSize = 0;

function findWorkerScript(): string {
  if (app.isPackaged) {
    // Preferred: app.asar.unpacked/scripts/embed-worker.mjs — sibling of
    // app.asar.unpacked/node_modules/, so ESM `import sharp from "sharp"`
    // resolves correctly via Node's normal node_modules lookup.
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    // Backward-compat: legacy extraResource layout (resources/scripts/...).
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error("embed-worker.mjs not found");
}

function spawnWorker(index: number): WorkerSlot {
  const workerScript = findWorkerScript();
  const child = fork(workerScript, [], {
    stdio: ["ignore", "inherit", "pipe", "ipc"],
    timeout: WORKER_TIMEOUT,
  });

  const slot: WorkerSlot = {
    process: child,
    index,
    status: "initializing",
    pendingResolve: null,
    pendingReject: null,
    consecutiveFailures: 0,
  };

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim();
    if (lines) {
      console.error(`[Pool Worker ${index}] ${lines}`);
      try {
        const logDir = path.join(app.getPath("userData"), "logs");
        fs.mkdirSync(logDir, { recursive: true });
        fs.writeFileSync(
          path.join(logDir, "ai-worker.log"),
          `${new Date().toISOString()} [Pool Worker ${index}] ${lines}\n`,
          { flag: "a" }
        );
      } catch {
        /* best-effort */
      }
    }
  });

  child.on("message", (msg: any) => {
    if (msg.type === "ready") {
      slot.status = "idle";
      drainQueue();
      return;
    }
    if (msg.type === "result" && slot.status === "busy") {
      const resolve = slot.pendingResolve;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.status = "idle";
      slot.consecutiveFailures = 0;
      resolve?.(msg.results as EmbedResult[]);
      drainQueue();
    }
  });

  child.on("exit", (code, signal) => {
    console.warn(
      `[Pool] Worker ${index} exited (code=${code}, signal=${signal})`
    );
    handleWorkerDeath(slot);
  });

  child.on("error", (err) => {
    console.error(`[Pool] Worker ${index} error:`, err.message);
    handleWorkerDeath(slot);
  });

  return slot;
}

function handleWorkerDeath(slot: WorkerSlot): void {
  if (slot.status === "dead") {
    return;
  }

  const hadPending = slot.pendingReject !== null;
  const reject = slot.pendingReject;
  slot.status = "dead";
  slot.pendingResolve = null;
  slot.pendingReject = null;
  slot.consecutiveFailures++;

  if (hadPending && reject) {
    reject(new Error(`Worker ${slot.index} died during processing`));
  }

  const aliveCount = slots.filter((s) => s.status !== "dead").length;
  if (aliveCount === 0) {
    initialized = false;
    // Reject all queued requests
    for (const req of requestQueue) {
      req.reject(new Error("All workers died, pool reset"));
    }
    requestQueue = [];
    return;
  }

  // Auto-respawn if under failure limit
  if (slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES && modelPath) {
    setTimeout(() => {
      if (slot.status !== "dead") {
        return;
      }
      console.log(
        `[Pool] Respawning worker ${slot.index} (attempt ${slot.consecutiveFailures})`
      );
      const newSlot = spawnWorker(slot.index);
      newSlot.consecutiveFailures = slot.consecutiveFailures;
      slots[slot.index] = newSlot;
      newSlot.process.send({ type: "init", modelPath });
    }, RESPAWN_DELAY_MS);
  } else {
    console.warn(
      `[Pool] Worker ${slot.index} exceeded max failures (${MAX_CONSECUTIVE_FAILURES}), not respawning`
    );
  }
}

function drainQueue(): void {
  while (requestQueue.length > 0) {
    const idleSlot = slots.find((s) => s.status === "idle");
    if (!idleSlot) {
      break;
    }

    const request = requestQueue.shift()!;
    dispatchToSlot(idleSlot, request.photos, request.resolve, request.reject);
  }
}

function dispatchToSlot(
  slot: WorkerSlot,
  photos: Array<{ id: number; path: string }>,
  resolve: (results: EmbedResult[]) => void,
  reject: (err: Error) => void
): void {
  slot.status = "busy";
  slot.pendingResolve = resolve;
  slot.pendingReject = reject;

  const timeout = setTimeout(() => {
    if (slot.status === "busy" && slot.pendingReject) {
      const rej = slot.pendingReject;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.status = "dead";
      slot.process.kill();
      rej(new Error(`Worker ${slot.index} timed out`));
      handleWorkerDeath(slot);
    }
  }, WORKER_TIMEOUT);

  slot.process.once("message", () => {
    clearTimeout(timeout);
  });

  slot.process.send({ type: "embed", modelPath, photos });
}

/** Start worker pool. Workers load the CLIP model once and stay alive. */
export async function initWorkerPool(mp: string): Promise<void> {
  if (initialized && slots.some((s) => s.status !== "dead")) {
    return;
  }

  modelPath = mp;
  slots = [];
  requestQueue = [];

  const cpuCount = os.cpus().length;
  poolSize = Math.max(2, Math.min(cpuCount - 1, 4));
  const workerScript = findWorkerScript();
  console.log(
    `[Pool] Starting ${poolSize} persistent workers: ${workerScript}`
  );

  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < poolSize; i++) {
    const slot = spawnWorker(i);
    slots.push(slot);

    readyPromises.push(
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`Worker ${i} init timed out`));
        }, 60_000);

        const check = setInterval(() => {
          if (slot.status === "idle") {
            clearInterval(check);
            clearTimeout(timer);
            resolve();
          } else if (slot.status === "dead") {
            clearInterval(check);
            clearTimeout(timer);
            reject(new Error(`Worker ${i} died during init`));
          }
        }, 50);
      })
    );
  }

  // Send init to all workers
  for (const slot of slots) {
    slot.process.send({ type: "init", modelPath });
  }

  await Promise.all(readyPromises);
  console.log(`[Pool] All ${poolSize} workers ready`);
  initialized = true;
}

/** Send a batch of photos to an available worker for embedding. */
function dispatchBatch(
  photos: Array<{ id: number; path: string }>
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    // Auto-reinitialize if pool is dead
    if (!initialized || slots.every((s) => s.status === "dead")) {
      if (!modelPath) {
        reject(new Error("Worker pool not initialized and no model path"));
        return;
      }
      initWorkerPool(modelPath)
        .then(() => {
          const idleSlot = slots.find((s) => s.status === "idle");
          if (idleSlot) {
            dispatchToSlot(idleSlot, photos, resolve, reject);
          } else {
            requestQueue.push({ photos, resolve, reject });
          }
        })
        .catch(reject);
      return;
    }

    const idleSlot = slots.find((s) => s.status === "idle");
    if (idleSlot) {
      dispatchToSlot(idleSlot, photos, resolve, reject);
    } else {
      requestQueue.push({ photos, resolve, reject });
    }
  });
}

/** Shut down all workers gracefully. */
export function shutdownPool(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "shutdown" });
    } catch {
      /* ignore */
    }
    try {
      slot.process.kill();
    } catch {
      /* ignore */
    }
  }
  slots = [];
  requestQueue = [];
  initialized = false;
}

export function isPoolReady(): boolean {
  return (
    initialized && slots.some((s) => s.status === "idle" || s.status === "busy")
  );
}

export function getPoolHealth(): {
  alive: number;
  busy: number;
  idle: number;
  dead: number;
  queueLength: number;
} {
  return {
    alive: slots.filter((s) => s.status !== "dead").length,
    busy: slots.filter((s) => s.status === "busy").length,
    idle: slots.filter((s) => s.status === "idle").length,
    dead: slots.filter((s) => s.status === "dead").length,
    queueLength: requestQueue.length,
  };
}

export async function embedSingleImage(
  imagePath: string,
  mp: string
): Promise<number[]> {
  if (!initialized || slots.every((s) => s.status === "dead")) {
    await initWorkerPool(mp);
  }
  const results = await dispatchBatch([{ id: 0, path: imagePath }]);
  const result = results[0];
  if (result?.vector && result.vector.length > 0) {
    return result.vector;
  }
  throw new Error(result?.error || "Empty vector from pool");
}

/**
 * Embed all given photos using the persistent worker pool.
 * Returns the full results array with vectors for persistence.
 */
export async function embedWithPool(
  photos: Array<{ id: number; path: string }>,
  onProgress?: (processed: number, total: number) => void
): Promise<EmbedResult[]> {
  if (!initialized) {
    throw new Error("Worker pool not initialized");
  }

  const allResults: EmbedResult[] = [];
  const total = photos.length;

  for (let i = 0; i < photos.length; i += BATCH_SIZE) {
    const batch = photos.slice(i, i + BATCH_SIZE);

    try {
      const results = await dispatchBatch(batch);
      allResults.push(...results);
    } catch (err: any) {
      console.warn(
        `[Pool] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`
      );
      if (batch.length > 1) {
        const left = await processResultsFallback(
          batch.slice(0, Math.floor(batch.length / 2))
        );
        const right = await processResultsFallback(
          batch.slice(Math.floor(batch.length / 2))
        );
        allResults.push(...left, ...right);
      } else {
        allResults.push({ id: batch[0].id, error: err.message });
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, total), total);
  }

  return allResults;
}

async function processResultsFallback(
  batch: Array<{ id: number; path: string }>
): Promise<EmbedResult[]> {
  if (batch.length === 0) {
    return [];
  }
  try {
    return await dispatchBatch(batch);
  } catch (err: any) {
    if (batch.length === 1) {
      console.warn(
        `[Pool] Skipping corrupted photo ${batch[0].id}: ${err.message}`
      );
      return [{ id: batch[0].id, error: err.message }];
    }
    const mid = Math.floor(batch.length / 2);
    const left = await processResultsFallback(batch.slice(0, mid));
    const right = await processResultsFallback(batch.slice(mid));
    return [...left, ...right];
  }
}
