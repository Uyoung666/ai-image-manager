import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";
import type { SerializedWorkerAdapter } from "@/services/ai/model-adapter";
import { getActiveEmbeddingWorkerAdapter } from "@/services/ai/model-config";

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

type WorkerStatus = "initializing" | "idle" | "busy" | "dead";

interface WorkerSlot {
  consecutiveFailures: number;
  generation: number;
  index: number;
  pendingReject: ((err: Error) => void) | null;
  pendingResolve: ((results: EmbedResult[]) => void) | null;
  process: ChildProcess;
  status: WorkerStatus;
  timeoutId?: ReturnType<typeof setTimeout> | null;
}

interface QueuedRequest {
  photos: Array<{ id: number; path: string }>;
  reject: (err: Error) => void;
  resolve: (results: EmbedResult[]) => void;
}

interface EmbedPoolConfig {
  batchSize: number;
  intraOpNumThreads: number;
  workers: number;
}

type EmbedBatchResultCallback = (
  results: EmbedResult[],
  batch: Array<{ id: number; path: string }>
) => Promise<void> | void;

const DEFAULT_BATCH_SIZE = 20;
const WORKER_TIMEOUT = 300_000;
const MAX_CONSECUTIVE_FAILURES = 3;
const RESPAWN_DELAY_MS = 1000;

let slots: WorkerSlot[] = [];
let requestQueue: QueuedRequest[] = [];
let modelPath: string | null = null;
let workerAdapter: SerializedWorkerAdapter | null = null;
let poolUseGPU = false;
let poolExecutionProvider: "cpu" | "directml" = "cpu";
let initialized = false;
let poolSize = 0;
let poolBatchSize = DEFAULT_BATCH_SIZE;
let poolIntraOpNumThreads = 1;
let poolGeneration = 0;
let activePoolKey: string | null = null;
let initializationKey: string | null = null;
let initializationPromise: Promise<void> | null = null;

/** Per-worker init progress: Map<workerIndex, percent 0-100> */
const workerInitProgress = new Map<number, number>();

function parsePositiveInt(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function resolveEmbedPoolConfig(
  cpuCount = os.cpus().length,
  useGPU = false,
  env: NodeJS.ProcessEnv = process.env
): EmbedPoolConfig {
  const safeCpuCount = Math.max(1, cpuCount);
  // SigLIP vision currently runs CPU-only in embed-worker.mjs because DirectML
  // crashes on this model. Keep defaults conservative and allow opt-in tuning
  // with AI_EMBED_WORKERS / AI_EMBED_THREADS.
  let defaultWorkers = 1;
  if ((useGPU && safeCpuCount >= 8) || safeCpuCount >= 12) {
    defaultWorkers = 2;
  }
  const maxWorkers = Math.max(1, Math.min(3, safeCpuCount - 1 || 1));
  const workers = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_WORKERS) ?? defaultWorkers,
      maxWorkers
    )
  );

  const maxThreadsPerWorker = Math.max(
    1,
    Math.floor(Math.max(1, safeCpuCount - 1) / workers)
  );
  const defaultThreads = Math.max(1, Math.min(4, maxThreadsPerWorker));
  const intraOpNumThreads = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_THREADS) ?? defaultThreads,
      maxThreadsPerWorker
    )
  );

  const batchSize = Math.max(
    1,
    Math.min(
      parsePositiveInt(env.AI_EMBED_BATCH_SIZE) ?? DEFAULT_BATCH_SIZE,
      100
    )
  );

  return { batchSize, intraOpNumThreads, workers };
}

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

function isCurrentSlot(slot: WorkerSlot): boolean {
  return slot.generation === poolGeneration && slots[slot.index] === slot;
}

function spawnWorker(index: number, generation: number): WorkerSlot {
  const workerScript = findWorkerScript();
  const child = fork(workerScript, [], {
    stdio: ["ignore", "inherit", "pipe", "ipc"],
  });

  const slot: WorkerSlot = {
    process: child,
    generation,
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

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: worker IPC handler keeps progress, lifecycle, and stale-result validation together.
  child.on("message", (msg: unknown) => {
    const message = msg as {
      error?: string;
      adapterId?: string;
      fingerprint?: string;
      percent?: number;
      results?: EmbedResult[];
      type?: string;
    };
    // Clear any pending dispatch timeout when worker responds
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    if (message.type === "init-progress") {
      if (!isCurrentSlot(slot)) {
        return;
      }
      const pct = Number(message.percent ?? 0);
      workerInitProgress.set(index, pct);
      return;
    }
    if (message.type === "init-error") {
      console.error(
        `[Pool] Worker ${index} init failed: ${message.error || "unknown error"}`
      );
      handleWorkerDeath(slot);
      return;
    }
    if (message.type === "ready") {
      if (!isCurrentSlot(slot)) {
        return;
      }
      workerInitProgress.set(index, 100);
      slot.status = "idle";
      drainQueue();
      return;
    }
    if (message.type === "result" && slot.status === "busy") {
      const resolve = slot.pendingResolve;
      const reject = slot.pendingReject;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.status = "idle";
      slot.consecutiveFailures = 0;
      if (
        workerAdapter &&
        (message.adapterId !== workerAdapter.adapterId ||
          message.fingerprint !== workerAdapter.fingerprint)
      ) {
        reject?.(new Error("Stale embedding worker result discarded"));
      } else {
        resolve?.(message.results ?? []);
      }
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

  // A previous pool generation may exit after shutdown or replacement. It must
  // never mutate or respawn into the current pool.
  if (!isCurrentSlot(slot)) {
    return;
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

  // Initialization failures are handled by startWorkerPool(). Only a fully
  // initialized generation may replace one failed worker in place.
  if (!initialized) {
    return;
  }

  if (
    slot.consecutiveFailures < MAX_CONSECUTIVE_FAILURES &&
    modelPath &&
    workerAdapter
  ) {
    const generation = slot.generation;
    setTimeout(() => {
      if (
        slot.status !== "dead" ||
        generation !== poolGeneration ||
        slots[slot.index] !== slot ||
        !initialized
      ) {
        return;
      }
      console.log(
        `[Pool] Respawning worker ${slot.index} (attempt ${slot.consecutiveFailures})`
      );
      const newSlot = spawnWorker(slot.index, generation);
      newSlot.consecutiveFailures = slot.consecutiveFailures;
      slots[slot.index] = newSlot;
      newSlot.process.send({
        type: "init",
        adapter: workerAdapter,
        execution: {
          provider: poolExecutionProvider,
          intraOpNumThreads: poolIntraOpNumThreads,
        },
      });
    }, RESPAWN_DELAY_MS);
  } else if (slot.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
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

    const request = requestQueue.shift();
    if (!request) {
      break;
    }
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

  console.log(
    `[Pool] Dispatching ${photos.length} photos to Worker ${slot.index}`
  );

  slot.timeoutId = setTimeout(() => {
    if (slot.status === "busy" && slot.pendingReject) {
      const rej = slot.pendingReject;
      slot.pendingResolve = null;
      slot.pendingReject = null;
      slot.process.kill();
      rej(new Error(`Worker ${slot.index} timed out`));
      handleWorkerDeath(slot);
    }
  }, WORKER_TIMEOUT);

  slot.process.send({
    type: "embed",
    photos,
  });
}

async function startWorkerPool(
  mp: string,
  useGPU: boolean,
  key: string
): Promise<void> {
  const generation = ++poolGeneration;
  modelPath = mp;
  workerAdapter = getActiveEmbeddingWorkerAdapter(mp);
  poolUseGPU = useGPU;
  // Current SigLIP v1 vision execution remains CPU-only. The provider is an
  // adapter concern so a future adapter can opt into DirectML safely.
  poolExecutionProvider = "cpu";
  slots = [];
  requestQueue = [];
  workerInitProgress.clear();

  const config = resolveEmbedPoolConfig(os.cpus().length, useGPU);
  // 每个 worker ~200MB，2 个 = 400MB，4 核以上可以 3 个
  // 4 个 worker 在 8GB 机器上容易触发 OOM
  poolSize = config.workers;
  poolBatchSize = config.batchSize;
  poolIntraOpNumThreads = config.intraOpNumThreads;
  const workerScript = findWorkerScript();
  console.log(
    `[Pool] Starting ${poolSize} persistent workers (${poolIntraOpNumThreads} ORT threads each, batch=${poolBatchSize}): ${workerScript}`
  );

  const readyPromises: Promise<void>[] = [];

  for (let i = 0; i < poolSize; i++) {
    const slot = spawnWorker(i, generation);
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
    slot.process.send({
      type: "init",
      adapter: workerAdapter,
      execution: {
        provider: poolExecutionProvider,
        intraOpNumThreads: poolIntraOpNumThreads,
      },
    });
  }

  try {
    await Promise.all(readyPromises);
    if (generation !== poolGeneration) {
      throw new Error("Worker pool initialization superseded");
    }
    console.log(`[Pool] All ${poolSize} workers ready`);
    initialized = true;
    activePoolKey = key;
  } catch (error) {
    if (generation === poolGeneration) {
      initialized = false;
      activePoolKey = null;
      for (const slot of slots) {
        slot.status = "dead";
        try {
          slot.process.kill();
        } catch {
          /* best-effort */
        }
      }
      slots = [];
      workerInitProgress.clear();
    }
    throw error;
  }
}

/** Start the persistent worker pool exactly once for a given configuration. */
export function initWorkerPool(mp: string, useGPU = false): Promise<void> {
  const adapter = getActiveEmbeddingWorkerAdapter(mp);
  const key = JSON.stringify({
    adapterId: adapter.adapterId,
    fingerprint: adapter.fingerprint,
    modelRoot: adapter.modelRoot,
    executionProvider: "cpu",
  });

  if (
    initialized &&
    activePoolKey === key &&
    slots.some((slot) => slot.status !== "dead")
  ) {
    return Promise.resolve();
  }

  if (initializationPromise) {
    if (initializationKey === key) {
      return initializationPromise;
    }
    return initializationPromise
      .catch(() => undefined)
      .then(() => initWorkerPool(mp, useGPU));
  }

  if (initialized || slots.length > 0) {
    shutdownPool();
  }

  initializationKey = key;
  const pending = startWorkerPool(mp, useGPU, key).finally(() => {
    if (initializationPromise === pending) {
      initializationPromise = null;
      initializationKey = null;
    }
  });
  initializationPromise = pending;
  return pending;
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
      initWorkerPool(modelPath, poolUseGPU)
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

/** Send abort signal to all running workers (best-effort mid-batch interrupt). */
export function abortAllWorkers(): void {
  for (const slot of slots) {
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
}

/** Shut down all workers gracefully. */
export function shutdownPool(): void {
  const oldSlots = slots;
  const shutdownError = new Error("Worker pool shut down");

  // Detach the old generation immediately. This lets a new initialization
  // start safely during the grace period and makes old exit events inert.
  poolGeneration++;
  slots = [];
  initialized = false;
  activePoolKey = null;
  initializationPromise = null;
  initializationKey = null;
  workerInitProgress.clear();
  for (const request of requestQueue) {
    request.reject(shutdownError);
  }
  requestQueue = [];

  // Send abort first so workers can stop mid-batch if idle enough
  // to receive the message, then send shutdown + kill.
  for (const slot of oldSlots) {
    if (slot.timeoutId) {
      clearTimeout(slot.timeoutId);
      slot.timeoutId = null;
    }
    const reject = slot.pendingReject;
    slot.pendingResolve = null;
    slot.pendingReject = null;
    slot.status = "dead";
    reject?.(shutdownError);
    try {
      slot.process.send({ type: "abort" });
    } catch {
      /* ignore */
    }
  }
  // Small grace period for abort messages to be processed
  const killAll = () => {
    for (const slot of oldSlots) {
      try {
        slot.process.kill();
      } catch {
        /* ignore */
      }
    }
  };
  // Give workers a brief chance to process abort, then kill
  setTimeout(killAll, 500);
}

/** Aggregate init progress across all workers (0-100). Returns 0 if no workers have reported yet. */
export function getPoolInitProgress(): number {
  if (slots.length === 0) {
    return 0;
  }
  let sum = 0;
  for (const slot of slots) {
    sum += workerInitProgress.get(slot.index) ?? 0;
  }
  return Math.round(sum / slots.length);
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
  onProgress?: (processed: number, total: number) => void,
  shouldCancel?: () => boolean,
  onBatchResults?: EmbedBatchResultCallback
): Promise<EmbedResult[]> {
  if (!initialized) {
    throw new Error("Worker pool not initialized");
  }

  const total = photos.length;
  const aliveCount = slots.filter((s) => s.status !== "dead").length;
  const concurrency = Math.min(poolSize, aliveCount);
  if (concurrency < 1) {
    throw new Error("Worker pool has no live workers");
  }

  // 预切批次
  const batchList: Array<Array<{ id: number; path: string }>> = [];
  for (let i = 0; i < photos.length; i += poolBatchSize) {
    batchList.push(photos.slice(i, i + poolBatchSize));
  }

  const allResults: EmbedResult[] = [];
  let processed = 0;
  let cursor = 0;
  let callbackChain = Promise.resolve();

  async function publishBatchResults(
    results: EmbedResult[],
    batch: Array<{ id: number; path: string }>
  ): Promise<void> {
    if (!onBatchResults) {
      return;
    }
    const next = callbackChain.then(() => onBatchResults(results, batch));
    callbackChain = next.then(
      () => undefined,
      () => undefined
    );
    await next;
  }

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: scheduling loop keeps cancellation, retry, progress, and callback ordering together.
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
        await publishBatchResults(results, batch);
      } catch (err: unknown) {
        const message = getErrorMessage(err);
        console.warn(`[Pool] Batch failed: ${message}`);
        // If cancelled, don't retry — just mark failed and move on
        let fallbackResults: EmbedResult[];
        if (shouldCancel?.()) {
          fallbackResults = batch.map((p) => ({
            id: p.id,
            error: "cancelled",
          }));
        } else if (batch.length > 1) {
          const left = await processResultsFallback(
            batch.slice(0, Math.floor(batch.length / 2))
          );
          const right = await processResultsFallback(
            batch.slice(Math.floor(batch.length / 2))
          );
          fallbackResults = [...left, ...right];
        } else {
          fallbackResults = [{ id: batch[0].id, error: message }];
        }
        allResults.push(...fallbackResults);
        await publishBatchResults(fallbackResults, batch);
      }
      processed += batch.length;
      onProgress?.(Math.min(processed, total), total);
    }
  }

  // 启动 poolSize 个并发调度 worker
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  await callbackChain;

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
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    if (batch.length === 1) {
      console.warn(
        `[Pool] Skipping corrupted photo ${batch[0].id}: ${message}`
      );
      return [{ id: batch[0].id, error: message }];
    }
    const mid = Math.floor(batch.length / 2);
    const left = await processResultsFallback(batch.slice(0, mid));
    const right = await processResultsFallback(batch.slice(mid));
    return [...left, ...right];
  }
}
