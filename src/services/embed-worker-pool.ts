import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { app } from "electron";

interface EmbedResult {
  id: number;
  vector?: number[];
  error?: string;
}

interface BatchRequest {
  type: "embed";
  modelPath: string;
  photos: Array<{ id: number; path: string }>;
}

const BATCH_SIZE = 15; // Photos per worker per dispatch
const WORKER_TIMEOUT = 300_000;

let workers: ChildProcess[] = [];
let modelPath: string | null = null;
let initialized = false;

function findWorkerScript(): string {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) return bundled;
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
  if (fs.existsSync(candidate)) return candidate;
  const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
  if (fs.existsSync(alt)) return alt;
  throw new Error("embed-worker.mjs not found");
}

/** Start worker pool. Workers load the CLIP model once and stay alive. */
export async function initWorkerPool(mp: string): Promise<void> {
  if (initialized && workers.length > 0) return;
  modelPath = mp;

  const cpuCount = os.cpus().length;
  const poolSize = Math.max(2, Math.min(cpuCount - 1, 4));
  const workerScript = findWorkerScript();
  console.log(`[Pool] Starting ${poolSize} persistent workers: ${workerScript}`);

  const pendingInits: Promise<void>[] = [];

  for (let i = 0; i < poolSize; i++) {
    const child = fork(workerScript, [], {
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      timeout: WORKER_TIMEOUT,
    });

    child.stderr?.on("data", (data: Buffer) => {
      const lines = data.toString().trim();
      if (lines) console.error(`[Pool Worker ${i}] ${lines}`);
    });

    child.on("exit", (code, signal) => {
      console.warn(`[Pool] Worker ${i} exited (code=${code}, signal=${signal})`);
      // Remove dead worker; will be replaced on next dispatch
      workers = workers.filter((w) => w !== child);
    });

    // Wait for worker readiness signal before adding to pool
    const ready = new Promise<void>((resolve) => {
      const onReady = (msg: any) => {
        if (msg.type === "ready") {
          child.removeListener("message", onReady);
          resolve();
        }
      };
      child.on("message", onReady);
    });

    pendingInits.push(ready);
    workers.push(child);
  }

  // Send model path to each worker so they can preload
  for (const child of workers) {
    child.send({ type: "init", modelPath });
  }

  await Promise.all(pendingInits);
  console.log(`[Pool] All ${poolSize} workers ready`);
  initialized = true;
}

/** Send a batch of photos to an available worker for embedding. */
function dispatchBatch(
  photos: Array<{ id: number; path: string }>,
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    if (!initialized || workers.length === 0 || !modelPath) {
      reject(new Error("Worker pool not initialized"));
      return;
    }

    // Round-robin: pick least recently used worker
    const worker = workers.shift()!;
    workers.push(worker);

    let resolved = false;
    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        worker.kill();
        workers = workers.filter((w) => w !== worker);
        reject(new Error("Embed batch timed out"));
      }
    }, WORKER_TIMEOUT);

    worker.once("message", (msg: any) => {
      if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(msg.results as EmbedResult[]);
      }
    });

    worker.once("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        workers = workers.filter((w) => w !== worker);
        reject(err);
      }
    });

    worker.send({ type: "embed", modelPath, photos });
  });
}

/** Shut down all workers gracefully. */
export function shutdownPool(): void {
  for (const w of workers) {
    try { w.send({ type: "shutdown" }); } catch { /* ignore */ }
    try { w.kill(); } catch { /* ignore */ }
  }
  workers = [];
  initialized = false;
}

export function isPoolReady(): boolean {
  return initialized && workers.length > 0;
}

export async function embedSingleImage(
  imagePath: string,
  mp: string,
): Promise<number[]> {
  if (!initialized || workers.length === 0) {
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
): Promise<EmbedResult[]> {
  if (!initialized) throw new Error("Worker pool not initialized");

  const allResults: EmbedResult[] = [];
  const total = photos.length;

  for (let i = 0; i < photos.length; i += BATCH_SIZE) {
    const batch = photos.slice(i, i + BATCH_SIZE);

    try {
      const results = await dispatchBatch(batch);
      allResults.push(...results);
    } catch (err: any) {
      console.warn(`[Pool] Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${err.message}`);
      // Retry with smaller batches on failure
      if (batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        const left = await processResultsFallback(batch.slice(0, mid));
        const right = await processResultsFallback(batch.slice(mid));
        allResults.push(...left, ...right);
      }
    }

    onProgress?.(Math.min(i + BATCH_SIZE, total), total);
  }

  return allResults;
}

async function processResultsFallback(
  batch: Array<{ id: number; path: string }>,
): Promise<EmbedResult[]> {
  if (batch.length === 0) return [];
  try {
    return await dispatchBatch(batch);
  } catch (err: any) {
    if (batch.length === 1) {
      console.warn(`[Pool] Skipping corrupted photo ${batch[0].id}: ${err.message}`);
      return [{ id: batch[0].id, error: err.message }];
    }
    const mid = Math.floor(batch.length / 2);
    const left = await processResultsFallback(batch.slice(0, mid));
    const right = await processResultsFallback(batch.slice(mid));
    return [...left, ...right];
  }
}
