import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import { createLogger } from "@/utils/logger";

const _log = createLogger("face-worker-pool");

export interface FaceDetectionResult {
  error?: string;
  faces: Array<{
    faceIndex: number;
    bbox: { x: number; y: number; width: number; height: number };
    confidence: number;
    embedding?: number[] | null;
  }>;
  height?: number;
  id: number;
  width?: number;
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface FaceWorkerMessage {
  error?: string;
  percent?: number;
  requestId?: string;
  results?: FaceDetectionResult[];
  type?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface WorkerSlot {
  consecutiveFailures: number;
  deathHandled: boolean;
  generation: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: FaceDetectionResult[]) => void) | null;
  process: ChildProcess;
  requestId: string | null;
  respawnTimer: ReturnType<typeof setTimeout> | null;
  status: WorkerStatus;
  timeoutId?: ReturnType<typeof setTimeout> | null;
}

interface QueuedRequest {
  photos: Array<{ id: number; path: string }>;
  reject: (err: Error) => void;
  requestId: string;
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
let poolGeneration = 0;
let requestSequence = 0;
let initPromise: Promise<void> | null = null;
let shuttingDown = false;

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

function spawnWorker(index: number, generation = poolGeneration): WorkerSlot {
  const workerScript = findWorkerScript();
  const child = fork(workerScript, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    timeout: WORKER_TIMEOUT,
  });
  captureWorkerOutput(child, `face-worker-${index}`);

  const slot: WorkerSlot = {
    process: child,
    index,
    status: "initializing",
    pendingResolve: null,
    pendingReject: null,
    consecutiveFailures: 0,
    deathHandled: false,
    generation,
    requestId: null,
    respawnTimer: null,
  };

  child.stderr?.on("data", (data: Buffer) => {
    const lines = data.toString().trim();
    if (lines) {
      console.error(`[FacePool W${index}] ${lines}`);
    }
  });

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker protocol handling keeps init, stale-result, and failure transitions together.
  child.on("message", (rawMessage: unknown) => {
    if (slot.generation !== poolGeneration || slots[slot.index] !== slot) {
      return;
    }
    if (typeof rawMessage !== "object" || rawMessage === null) {
      return;
    }
    const msg = rawMessage as FaceWorkerMessage;
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
    if (
      msg.type === "result" &&
      slot.status === "busy" &&
      (msg.requestId === undefined || msg.requestId === slot.requestId)
    ) {
      if (slot.timeoutId) {
        clearTimeout(slot.timeoutId);
        slot.timeoutId = null;
      }
      const resolve = slot.pendingResolve;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.requestId = null;
      slot.status = "idle";
      slot.consecutiveFailures = 0;
      const results = msg.results ?? [];
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

function handleWorkerDeath(slot: WorkerSlot, reason?: Error): void {
  if (slot.deathHandled) {
    return;
  }

  slot.deathHandled = true;
  if (slot.timeoutId) {
    clearTimeout(slot.timeoutId);
    slot.timeoutId = null;
  }
  const hadPending = slot.pendingReject !== null;
  const reject = slot.pendingReject;
  slot.status = "dead";
  slot.pendingResolve = null;
  slot.pendingReject = null;
  slot.requestId = null;
  slot.consecutiveFailures++;

  if (hadPending && reject) {
    reject(reason ?? new Error(`Worker ${slot.index} died during processing`));
  }

  const isCurrentSlot =
    slot.generation === poolGeneration && slots[slot.index] === slot;
  const aliveCount = slots.filter(
    (s) => s.generation === poolGeneration && s.status !== "dead"
  ).length;
  if (isCurrentSlot && aliveCount === 0) {
    initialized = false;
  }

  if (
    isCurrentSlot &&
    !shuttingDown &&
    slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES &&
    poolModelsDir
  ) {
    slot.respawnTimer = setTimeout(() => {
      slot.respawnTimer = null;
      if (
        shuttingDown ||
        slot.generation !== poolGeneration ||
        slots[slot.index] !== slot ||
        slot.status !== "dead"
      ) {
        return;
      }
      console.log(
        `[FacePool] Respawning worker ${slot.index} (attempt ${slot.consecutiveFailures})`
      );
      const newSlot = spawnWorker(slot.index, poolGeneration);
      newSlot.consecutiveFailures = slot.consecutiveFailures;
      slots[slot.index] = newSlot;
      try {
        newSlot.process.send({
          type: "init",
          modelsDir: poolModelsDir,
          useGPU: poolUseGPU,
        });
      } catch (_error) {
        handleWorkerDeath(newSlot);
      }
    }, RESPAWN_DELAY_MS);
  } else {
    console.warn(
      `[FacePool] Worker ${slot.index} exceeded max failures, not respawning`
    );
  }
}

function drainQueue(): void {
  if (shuttingDown) {
    return;
  }
  while (requestQueue.length > 0) {
    const idleSlot = slots.find((s) => s.status === "idle");
    if (!idleSlot) {
      break;
    }

    const request = requestQueue.shift();
    if (!request) {
      break;
    }
    dispatchToSlot(
      idleSlot,
      request.photos,
      request.requestId,
      request.resolve,
      request.reject
    );
  }
}

function dispatchToSlot(
  slot: WorkerSlot,
  photos: Array<{ id: number; path: string }>,
  requestId: string,
  resolve: (results: FaceDetectionResult[]) => void,
  reject: (err: Error) => void
): void {
  slot.status = "busy";
  slot.requestId = requestId;
  slot.pendingResolve = resolve;
  slot.pendingReject = reject;

  console.log(
    `[FacePool] Dispatching ${photos.length} photos to Worker ${slot.index}`
  );

  slot.timeoutId = setTimeout(() => {
    if (
      slot.status === "busy" &&
      slot.requestId === requestId &&
      slot.pendingReject
    ) {
      handleWorkerDeath(slot, new Error(`Worker ${slot.index} timed out`));
      try {
        slot.process.kill();
      } catch {
        /* ignore */
      }
    }
  }, WORKER_TIMEOUT);

  try {
    slot.process.send({ type: "detect", photos, requestId });
  } catch (error) {
    handleWorkerDeath(
      slot,
      error instanceof Error ? error : new Error(String(error))
    );
  }
}

function rejectRequests(error: Error): void {
  const queued = requestQueue;
  requestQueue = [];
  for (const request of queued) {
    request.reject(error);
  }
}

function terminateSlots(slotsToTerminate: WorkerSlot[]): void {
  for (const slot of slotsToTerminate) {
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    if (slot.respawnTimer) {
      clearTimeout(slot.respawnTimer);
      slot.respawnTimer = null;
    }
    slot.deathHandled = true;
    slot.status = "dead";
    slot.requestId = null;
    const reject = slot.pendingReject;
    slot.pendingResolve = null;
    slot.pendingReject = null;
    reject?.(new Error(`Face worker ${slot.index} was stopped`));
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
}

function waitForWorkerReady(slot: WorkerSlot): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const check = setInterval(() => {
      if (slot.status === "idle") {
        settled = true;
        clearInterval(check);
        clearTimeout(timer);
        resolve();
      } else if (slot.status === "dead") {
        settled = true;
        clearInterval(check);
        clearTimeout(timer);
        reject(new Error(`Worker ${slot.index} died during init`));
      }
    }, 50);
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      clearInterval(check);
      reject(new Error(`Worker ${slot.index} init timed out`));
    }, 60_000);
  });
}

/** Start the face-worker pool. Workers load ONNX models once and stay alive. */
export function initFaceWorkerPool(
  modelsDir: string,
  useGPU: boolean
): Promise<void> {
  if (initialized && !shuttingDown && slots.some((s) => s.status !== "dead")) {
    return Promise.resolve();
  }

  if (initPromise) {
    return initPromise;
  }

  poolModelsDir = modelsDir;
  poolUseGPU = useGPU;
  shuttingDown = false;
  const promise = (async () => {
    // Invalidate all handlers/timers from a failed or previous generation before
    // replacing the slot array. This also prevents old workers from respawning.
    poolGeneration++;
    const oldSlots = slots;
    slots = [];
    initialized = false;
    workerInitProgress.clear();
    terminateSlots(oldSlots);

    const cpuCount = os.cpus().length;
    // Face models are lightweight (~200MB per worker including DML context)
    poolSize = cpuCount >= 8 ? 3 : 2;
    const workerScript = findWorkerScript();
    console.log(
      `[FacePool] Starting ${poolSize} persistent face-workers: ${workerScript}`
    );

    const generation = poolGeneration;
    const readyPromises: Promise<void>[] = [];
    for (let i = 0; i < poolSize; i++) {
      const slot = spawnWorker(i, generation);
      slots.push(slot);
      readyPromises.push(waitForWorkerReady(slot));
    }

    try {
      for (const slot of slots) {
        slot.process.send({ type: "init", modelsDir, useGPU });
      }
      await Promise.all(readyPromises);
      if (generation !== poolGeneration || shuttingDown) {
        throw new Error("Face worker pool initialization was cancelled");
      }
      initialized = true;
      drainQueue();
      console.log(`[FacePool] All ${poolSize} workers ready`);
    } catch (error) {
      initialized = false;
      poolGeneration++;
      const failedSlots = slots;
      slots = [];
      terminateSlots(failedSlots);
      rejectRequests(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  })();
  const trackedPromise = promise.finally(() => {
    if (initPromise === trackedPromise) {
      initPromise = null;
    }
  });
  initPromise = trackedPromise;

  return initPromise;
}

/** Send a batch of photos to an available worker. */
function dispatchBatch(
  photos: Array<{ id: number; path: string }>
): Promise<FaceDetectionResult[]> {
  return new Promise((resolve, reject) => {
    if (shuttingDown) {
      reject(new Error("Face worker pool is shutting down"));
      return;
    }

    const request: QueuedRequest = {
      photos,
      requestId: `face-${poolGeneration}-${++requestSequence}`,
      resolve,
      reject,
    };
    requestQueue.push(request);
    drainQueue();

    if (!(initialized || initPromise) && poolModelsDir) {
      initFaceWorkerPool(poolModelsDir, poolUseGPU).catch((error) => {
        rejectRequests(
          error instanceof Error ? error : new Error(String(error))
        );
      });
    } else if (!(initialized || poolModelsDir)) {
      requestQueue = requestQueue.filter((item) => item !== request);
      reject(new Error("Face pool not initialized"));
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
  shuttingDown = true;
  initialized = false;
  poolGeneration++;
  const oldSlots = slots;
  slots = [];
  workerInitProgress.clear();
  rejectRequests(new Error("Face worker pool shut down"));
  terminateSlots(oldSlots);
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
  } catch (err: unknown) {
    if (batch.length === 1) {
      console.warn(
        `[FacePool] Skipping corrupted photo ${batch[0].id}: ${getErrorMessage(err)}`
      );
      return [{ id: batch[0].id, faces: [], error: getErrorMessage(err) }];
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
      } catch (err: unknown) {
        console.warn(`[FacePool] Batch failed: ${getErrorMessage(err)}`);
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
