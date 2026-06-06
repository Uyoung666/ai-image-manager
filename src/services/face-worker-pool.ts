import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { createLogger } from "@/utils/logger";

const log = createLogger("face-worker-pool");

export interface FaceDetectionResult {
  id: number;
  faces: Array<{
    faceIndex: number;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    embedding?: number[] | null;
  }>;
}

interface FaceBatchError {
  error?: string;
  id: number;
  faces: never[];
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface WorkerSlot {
  consecutiveFailures: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: FaceDetectionResult[]) => void) | null;
  process: ChildProcess;
  status: WorkerStatus;
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
    if (msg.type === "ready") {
      if (msg.error) {
        console.error(
          `[FacePool] Worker ${index} init failed: ${msg.error}`
        );
        slot.status = "dead";
        handleWorkerDeath(slot);
      } else {
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
      resolve?.(msg.results as FaceDetectionResult[]);
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

  if (
    slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES &&
    poolModelsDir
  ) {
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

  const cpuCount = os.cpus().length;
  // Face models are lighter than CLIP (~200MB per worker including DML context)
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
    slot.process.send({ type: "init", modelsDir, useGPU });
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

/** Shut down all workers gracefully. */
export function shutdownFacePool(): void {
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

export function isFacePoolReady(): boolean {
  return (
    initialized &&
    slots.some((s) => s.status === "idle" || s.status === "busy")
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
        // Fallback: process one-by-one for corrupted images
        if (batch.length > 1) {
          for (const photo of batch) {
            try {
              const r = await dispatchBatch([photo]);
              allResults.push(...r);
            } catch (e2: any) {
              allResults.push({ id: photo.id, faces: [] });
            }
          }
        } else {
          allResults.push({ id: batch[0].id, faces: [] });
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
