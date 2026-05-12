import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { BATCH_SIZE, MIN_VECTORS_FOR_INDEX, WORKER_TIMEOUT } from "./constants";
import { ensureLocalModel } from "./model-loader";
import {
  _localModelPath,
  currentProgress,
  isEmbedding,
  photoTable,
  setCurrentProgress,
  setIsEmbedding,
  setLocalModelPath,
} from "./state";
import type { EmbedProgressCallback } from "./state";
import { batchSuggestTags } from "./tag-suggester";
import { initVectorDB } from "./vector-db";

// --- Worker script location ---

function findWorkerScript(): string {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } else {
    const cwd = process.cwd();
    const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
    if (fs.existsSync(alt)) {
      return alt;
    }
  }
  throw new Error("embed-worker.mjs not found");
}

// --- Types ---

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

function runEmbedBatch(
  batchPhotos: Array<{ id: number; path: string }>,
  modelPath: string
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    const workerScript = findWorkerScript();

    console.log(
      `[AI] Forking worker for ${batchPhotos.length} photos: ${workerScript}`
    );

    const child = fork(workerScript, [], {
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      timeout: WORKER_TIMEOUT,
    });

    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(
          new Error(
            `Worker timed out after ${WORKER_TIMEOUT}ms: ${stderr.slice(-300)}`
          )
        );
      }
    }, WORKER_TIMEOUT);

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(msg.results as EmbedResult[]);
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Worker exited unexpectedly (code ${code}): ${stderr.slice(-500) || "no stderr"}`
          )
        );
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.send({ type: "embed", modelPath, photos: batchPhotos });
  });
}

// --- Batch embedding ---

export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  // Atomically guard against concurrent calls
  if (isEmbedding) {
    console.warn(
      "[AI] embedAllPhotos already running, skipping duplicate call"
    );
    return 0;
  }
  setIsEmbedding(true);

  const db = getDatabase();

  // Check that the worker script exists before starting
  try {
    const workerScript = findWorkerScript();
    console.log(`[AI] Embed worker found: ${workerScript}`);
  } catch (err: any) {
    setIsEmbedding(false);
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      error: `嵌入 Worker 脚本未找到: ${err.message}`,
    });
    onProgress?.(currentProgress);
    return 0;
  }

  setCurrentProgress({
    processed: 0,
    total: 0,
    phase: "loading",
    currentFile: "",
  });
  onProgress?.(currentProgress);

  // Ensure model path is resolved (worker needs the local model path)
  if (!_localModelPath) {
    setLocalModelPath(await ensureLocalModel());
  }

  await initVectorDB();

  if (!photoTable) {
    setIsEmbedding(false);
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      error: "向量数据库初始化失败",
    });
    onProgress?.(currentProgress);
    return 0;
  }
  // Repair: detect orphaned isAiProcessed flags from previous worker crashes.
  const processedRow = db
    .select({ count: sql<number>`count(*)` })
    .from(photos)
    .where(eq(photos.isAiProcessed, true))
    .get();

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(photos)
    .get();

  const totalPhotos: number = totalRow?.count ?? 0;
  const processedCount: number = processedRow?.count ?? 0;

  let vectorCount = 0;
  try {
    vectorCount = await photoTable.countRows();
  } catch {
    vectorCount = 0;
  }

  console.log(
    `[AI] DB state: ${totalPhotos} total photos, ${processedCount} processed, ${vectorCount} vectors`
  );

  const needsRepair =
    processedCount > 0 &&
    (vectorCount <= 1 || vectorCount < processedCount * 0.5);

  if (needsRepair) {
    console.log(
      "[AI] Repair: mismatch detected — resetting all isAiProcessed flags"
    );
    db.update(photos)
      .set({ isAiProcessed: false })
      .where(eq(photos.isAiProcessed, true))
      .run();
  }

  const unprocessed = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(eq(photos.isAiProcessed, false))
    .all();

  const total = unprocessed.length;
  let processed = 0;

  console.log(
    `[AI] Starting embedding for ${total} photos via Worker Pool`
  );

  // Use persistent worker pool
  let poolReady = false;
  try {
    const { initWorkerPool, embedWithPool, shutdownPool } = await import(
      "@/services/embed-worker-pool"
    );
    await initWorkerPool(_localModelPath!);
    poolReady = true;

    const poolResults = await embedWithPool(unprocessed, (done, tot) => {
      setCurrentProgress({
        processed: done,
        total: tot,
        phase: "embedding",
        currentFile: `pool: ${done}/${tot}`,
      });
      onProgress?.(currentProgress);
    });
    // Persist results to LanceDB and SQLite
    const successResults = poolResults.filter((r) => r.vector && r.vector.length > 0);
    if (successResults.length > 0 && photoTable) {
      const batchIds = successResults.map((r) => r.id);
      try { await photoTable.delete(`photo_id IN (${batchIds.join(", ")})`); } catch { /* ok */ }

      for (const result of successResults) {
        try {
          await photoTable.add([
            { photo_id: result.id, vector: result.vector, created_at: Date.now() },
          ]);
        } catch (lanceErr: any) {
          console.warn(`[AI] Photo ${result.id} LanceDB write failed: ${lanceErr?.message}`);
          continue;
        }
        try {
          db.update(photos)
            .set({ isAiProcessed: true, vectorId: `vec_${result.id}` })
            .where(eq(photos.id, result.id))
            .run();
        } catch (dbErr: any) {
          console.warn(`[AI] Photo ${result.id} SQLite update failed: ${dbErr?.message}`);
        }
      }
      processed = successResults.length;
    }
  } catch (poolErr: any) {
    console.error("[AI] Worker pool failed:", poolErr?.message);
  }

  // If pool is not available, fall back to legacy per-batch fork
  if (!poolReady) {
    async function processBatch(
      batch: Array<{ id: number; path: string }>,
    ): Promise<number> {
      if (batch.length === 0) return 0;

      try {
        const results = await runEmbedBatch(batch, _localModelPath!);
        let count = 0;

        const batchIds = results.filter((r) => r.vector).map((r) => r.id);
        if (batchIds.length > 0) {
          try {
            await photoTable.delete(`photo_id IN (${batchIds.join(", ")})`);
          } catch { /* best-effort */ }
        }

        for (const result of results) {
          if (result.vector && result.vector.length > 0) {
            try {
              await photoTable.add([
                { photo_id: result.id, vector: result.vector, created_at: Date.now() },
              ]);
            } catch (lanceErr: any) {
              console.warn(`[AI] Photo ${result.id} LanceDB write failed: ${lanceErr?.message}`);
              continue;
            }
            try {
              db.update(photos)
                .set({ isAiProcessed: true, vectorId: `vec_${result.id}` })
                .where(eq(photos.id, result.id))
                .run();
            } catch (dbErr: any) {
              console.warn(`[AI] Photo ${result.id} SQLite update failed: ${dbErr?.message}`);
            }
            count++;
          } else if (result.error) {
            console.warn(`[AI] Photo ${result.id} embedding failed: ${result.error}`);
          }
        }
        return count;
      } catch (err: any) {
        if (batch.length === 1) {
          console.warn(`[AI] Skipping photo ${batch[0].id} — worker crash: ${err.message}`);
          return 0;
        }
        const mid = Math.floor(batch.length / 2);
        const left = await processBatch(batch.slice(0, mid));
        const right = await processBatch(batch.slice(mid));
        return left + right;
      }
    }
    for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
      if (!isEmbedding) { console.log("[AI] Embedding stopped by user"); break; }
      const batch = unprocessed.slice(i, i + BATCH_SIZE);
      setCurrentProgress({
        processed, total,
        phase: "embedding",
        currentFile: `batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)}`,
      });
      onProgress?.(currentProgress);
      const batchCount = await processBatch(batch);
      processed += batchCount;
      if (batchCount < batch.length) {
        console.warn(`[AI] Batch: ${batchCount}/${batch.length} succeeded`);
      }
    }
  }

  // If there were no photos at all, stay in "idle" phase so the UI
  // allows restarting after the user imports photos.
  if (total === 0 && totalPhotos === 0) {
    setCurrentProgress({ processed: 0, total: 0, phase: "idle", currentFile: "" });
  } else {
    setCurrentProgress({
      processed,
      total: processed > 0 ? processed : total,
      phase: "complete",
      currentFile: "",
    });
  }
  onProgress?.(currentProgress);
  setIsEmbedding(false);

  // Run batch auto-tagging now that all vectors are in LanceDB.
  if (processed > 0) {
    const allDbPhotos = db
      .select({ id: photos.id })
      .from(photos)
      .all();
    const allIds = allDbPhotos.map((p) => p.id);
    batchSuggestTags(allIds)
      .then((r) => console.log(`[AI] Auto-tag complete: ${r.tagged} tagged, ${r.skipped} skipped`))
      .catch((err) => console.error("[AI] Auto-tag failed:", err?.message));
  }

  // Create / rebuild vector index now that all data is in place.
  if (processed > 0 && photoTable) {
    try {
      const rowCount = await photoTable.countRows();
      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(`[AI] Building vector index on ${rowCount} rows...`);
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index built successfully");
      } else {
        console.log(
          `[AI] Skipping index build: ${rowCount} vectors < ${MIN_VECTORS_FOR_INDEX} threshold`
        );
      }
    } catch (err: any) {
      console.error("[AI] Failed to create vector index:", err?.message);
    }
  }

  return processed;
}
