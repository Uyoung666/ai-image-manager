import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { createLogger } from "@/utils/logger";

const log = createLogger("face-worker-pool");

export interface FaceDetectionResult {
  faces: Array<{
    faceIndex: number;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    embedding?: number[] | null;
  }>;
  id: number;
  error?: string;
}

interface FaceBatchError {
  error?: string;
  faces: never[];
  id: number;
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface WorkerSlot {
  consecutiveFailures: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: FaceDetectionResult[]) => void) | null;
  process: ChildProcess;
  status: WorkerStatus;
  timeoutId?: ReturnType<typeof setTimeout> | null;
}

interface QueuedRequest {
  photos: Array<{ id: number; path: string }>;
  reject: (err: Error) => void;
  resolve: (results: FaceDetectionResult[]) => void;
}

const WORKER_TIMEOUT = 300_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESPAWN_DELAY_MS = 1000;

let slots: WorkerSlot[] = [];
let requestQueue: QueuedRequest[] = [];
let poolModelsDir: string | null = null;
let poolUseGPU = false;
let initialized = false;
let poolSize = 0;

/** Per-worker init progress: Map<workerIndex, percent 0-100> */
const workerInitProgress = new Map<number, number>();

function findWorkerScript(): string {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "face-worker.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "face-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "face-worker.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", "face-worker.mjs");
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error("face-worker.mjs not found");
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
      console.error(`[FacePool W${index}] ${lines}`);
    }
  });

  child.on("message", (msg: any) => {
    // Clear any pending dispatch timeout when worker responds
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    if (msg.type === "init-progress") {
      const pct = Number(msg.percent ?? 0);
      workerInitProgress.set(index, pct);
      return;
    }
    if (msg.type === "ready") {
      if (msg.error) {
        console.error(`[FacePool] Worker ${index} init failed: ${msg.error}`);
        slot.status = "dead";
        handleWorkerDeath(slot);
      } else {
        workerInitProgress.set(index, 100);
        slot.status = "idle";
        drainQueue();
      }
      return;
    }
    if (msg.type === "result" && slot.status === "busy") {
      const resolve = slot.pendingResolve;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.status = "idle";
      slot.consecutiveFailures = 0;
      const results = (msg.results as FaceDetectionResult[]) ?? [];
      resolve?.(
        msg.error
          ? results.map((result) => ({ ...result, error: String(msg.error) }))
          : results
      );
      drainQueue();
    }
  });

  child.on("exit", (code, signal) => {
    console.warn(
      `[FacePool] Worker ${index} exited (code=${code}, signal=${signal})`
    );
    handleWorkerDeath(slot);
  });

  child.on("error", (err) => {
    console.error(`[FacePool] Worker ${index} error:`, err.message);
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
    for (const req of requestQueue) {
      req.reject(new Error("All workers died, pool reset"));
    }
    requestQueue = [];
    return;
  }

  if (slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES && poolModelsDir) {
    setTimeout(() => {
      if (slot.status !== "dead") {
        return;
      }
      console.log(
        `[FacePool] Respawning worker ${slot.index} (attempt ${slot.consecutiveFailures})`
      );
      const newSlot = spawnWorker(slot.index);
      newSlot.consecutiveFailures = slot.consecutiveFailures;
      slots[slot.index] = newSlot;
      newSlot.process.send({
        type: "init",
        modelsDir: poolModelsDir,
        useGPU: poolUseGPU,
      });
    }, RESPAWN_DELAY_MS);
  } else {
    console.warn(
      `[FacePool] Worker ${slot.index} exceeded max failures, not respawning`
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
  resolve: (results: FaceDetectionResult[]) => void,
  reject: (err: Error) => void
): void {
  slot.status = "busy";
  slot.pendingResolve = resolve;
  slot.pendingReject = reject;

  console.log(
    `[FacePool] Dispatching ${photos.length} photos to Worker ${slot.index}`
  );

  slot.timeoutId = setTimeout(() => {
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

  slot.process.send({ type: "detect", photos });
}

/** Start the face-worker pool. Workers load ONNX models once and stay alive. */
export async function initFaceWorkerPool(
  modelsDir: string,
  useGPU: boolean
): Promise<void> {
  if (initialized && slots.some((s) => s.status !== "dead")) {
    return;
  }

  poolModelsDir = modelsDir;
  poolUseGPU = useGPU;
  slots = [];
  requestQueue = [];
  workerInitProgress.clear();

  const cpuCount = os.cpus().length;
  // Face models are lightweight (~200MB per worker including DML context)
  poolSize = cpuCount >= 8 ? 3 : 2;
  const workerScript = findWorkerScript();
  console.log(
    `[FacePool] Starting ${poolSize} persistent face-workers: ${workerScript}`
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

  for (const slot of slots) {
    slot.process.send({
      type: "init",
      modelsDir,
      useGPU,
    });
  }

  await Promise.all(readyPromises);
  console.log(`[FacePool] All ${poolSize} workers ready`);
  initialized = true;
}

/** Send a batch of photos to an available worker. */
function dispatchBatch(
  photos: Array<{ id: number; path: string }>
): Promise<FaceDetectionResult[]> {
  return new Promise((resolve, reject) => {
    if (!initialized || slots.every((s) => s.status === "dead")) {
      if (!poolModelsDir) {
        reject(new Error("Face pool not initialized"));
        return;
      }
      initFaceWorkerPool(poolModelsDir, poolUseGPU)
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

/** Send abort signal to all running face workers (best-effort mid-batch interrupt). */
export function abortAllFaceWorkers(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
}

/** Shut down all workers gracefully. */
export function shutdownFacePool(): void {
  // Send abort first so workers can stop mid-batch if idle enough
  // to receive the message, then send shutdown + kill.
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
  // Small grace period for abort messages to be processed
  const killAll = () => {
    for (const slot of slots) {
      try {
        slot.process.kill();
      } catch {
        /* ignore */
      }
    }
    slots = [];
    requestQueue = [];
    initialized = false;
  };
  setTimeout(killAll, 500);
}

/** Aggregate init progress across all face workers (0-100). Returns 0 if no workers have reported yet. */
export function getFacePoolInitProgress(): number {
  if (slots.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const slot of slots) {
    sum += workerInitProgress.get(slot.index) ?? 0;
  }
  return Math.round(sum / slots.length);
}

export function isFacePoolReady(): boolean {
  return (
    initialized && slots.some((s) => s.status === "idle" || s.status === "busy")
  );
}

export function getFacePoolHealth(): {
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

/**
 * Binary-split fallback when a batch fails — recursively splits the batch
 * to isolate problematic photos instead of degrading to one-by-one processing.
 */
async function processResultsFallback(
  batch: Array<{ id: number; path: string }>
): Promise<FaceDetectionResult[]> {
  if (batch.length === 0) {
    return [];
  }
  try {
    return await dispatchBatch(batch);
  } catch (err: any) {
    if (batch.length === 1) {
      console.warn(
        `[FacePool] Skipping corrupted photo ${batch[0].id}: ${err.message}`
      );
      return [{ id: batch[0].id, faces: [], error: err.message }];
    }
    const mid = Math.floor(batch.length / 2);
    const left = await processResultsFallback(batch.slice(0, mid));
    const right = await processResultsFallback(batch.slice(mid));
    return [...left, ...right];
  }
}

/**
 * Run face detection + embedding on all given photos using the persistent
 * worker pool. Returns results for DB persistence.
 */
export async function detectFacesWithPool(
  photos: Array<{ id: number; path: string }>,
  batchSize: number,
  onProgress?: (processed: number, total: number) => void,
  shouldCancel?: () => boolean
): Promise<FaceDetectionResult[]> {
  if (!initialized) {
    throw new Error("Face worker pool not initialized");
  }

  const total = photos.length;
  const aliveCount = slots.filter((s) => s.status !== "dead").length;
  const concurrency = Math.min(poolSize, aliveCount);

  const batchList: Array<Array<{ id: number; path: string }>> = [];
  for (let i = 0; i < photos.length; i += batchSize) {
    batchList.push(photos.slice(i, i + batchSize));
  }

  const allResults: FaceDetectionResult[] = [];
  let processed = 0;
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < batchList.length) {
      if (shouldCancel?.()) {
        break;
      }
      const idx = cursor++;
      if (idx >= batchList.length) {
        break;
      }
      if (shouldCancel?.()) {
        break;
      }
      const batch = batchList[idx];
      try {
        const results = await dispatchBatch(batch);
        allResults.push(...results);
      } catch (err: any) {
        console.warn(`[FacePool] Batch failed: ${err.message}`);
        // If cancelled, don't retry — just mark failed and move on
        if (shouldCancel?.()) {
          allResults.push(
            ...batch.map((p) => ({
              id: p.id,
              faces: [] as never[],
              error: "cancelled",
            }))
          );
        } else {
          const fallbackResults = await processResultsFallback(batch);
          allResults.push(...fallbackResults);
        }
      }
      processed += batch.length;
      onProgress?.(Math.min(processed, total), total);
    }
  }

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  return allResults;
}
