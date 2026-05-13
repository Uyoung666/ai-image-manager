import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { BATCH_SIZE, WORKER_TIMEOUT } from "./constants";
import { ensureLocalModel } from "./model-loader";
import type { EmbedProgressCallback } from "./state";
import {
  _localModelPath,
  currentProgress,
  isEmbedding,
  photoTable,
  setCurrentProgress,
  setIsEmbedding,
  setLocalModelPath,
} from "./state";
import { batchSuggestTags } from "./tag-suggester";
import {
  buildPhotoIdFilter,
  ensureVectorIndex,
  initVectorDB,
} from "./vector-db";

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
  const successfulIds: number[] = [];

  console.log(`[AI] Starting embedding for ${total} photos via Worker Pool`);

  // Use persistent worker pool
  let poolReady = false;
  try {
    const { initWorkerPool, embedWithPool } = await import(
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
    // Persist results to LanceDB and SQLite — batch write
    const successResults = poolResults.filter(
      (r) => r.vector && r.vector.length > 0
    );
    if (successResults.length > 0 && photoTable) {
      const batchIds = successResults.map((r) => r.id);

      // 1. Batch delete old vectors
      try {
        await photoTable.delete(buildPhotoIdFilter(batchIds));
      } catch {
        /* first write — table may be empty */
      }

      // 2. Batch add new vectors
      const records = successResults.map((r) => ({
        photo_id: r.id,
        vector: r.vector,
        created_at: Date.now(),
      }));
      try {
        await photoTable.add(records);
      } catch (lanceErr: any) {
        console.warn(
          `[AI] Batch add failed (${lanceErr?.message}), falling back to individual writes`
        );
        for (const record of records) {
          try {
            await photoTable.add([record]);
          } catch {
            /* skip */
          }
        }
      }

      // 3. Batch update SQLite
      for (const id of batchIds) {
        try {
          db.update(photos)
            .set({ isAiProcessed: true, vectorId: `vec_${id}` })
            .where(eq(photos.id, id))
            .run();
        } catch {
          /* skip */
        }
      }

      processed = successResults.length;
      successfulIds.push(...batchIds);
    }
  } catch (poolErr: any) {
    console.error("[AI] Worker pool failed:", poolErr?.message);
  }

  // If pool is not available, fall back to legacy per-batch fork
  if (!poolReady) {
    async function processBatch(
      batch: Array<{ id: number; path: string }>
    ): Promise<number> {
      if (batch.length === 0) {
        return 0;
      }

      try {
        const results = await runEmbedBatch(batch, _localModelPath!);
        const successBatch = results.filter(
          (r) => r.vector && r.vector.length > 0
        );

        if (successBatch.length > 0) {
          const ids = successBatch.map((r) => r.id);
          try {
            await photoTable.delete(buildPhotoIdFilter(ids));
          } catch {
            /* best-effort */
          }

          const records = successBatch.map((r) => ({
            photo_id: r.id,
            vector: r.vector,
            created_at: Date.now(),
          }));
          try {
            await photoTable.add(records);
          } catch {
            for (const record of records) {
              try {
                await photoTable.add([record]);
              } catch {
                /* skip */
              }
            }
          }

          for (const id of ids) {
            try {
              db.update(photos)
                .set({ isAiProcessed: true, vectorId: `vec_${id}` })
                .where(eq(photos.id, id))
                .run();
            } catch {
              /* skip */
            }
          }
          successfulIds.push(...ids);
          return successBatch.length;
        }
        return 0;
      } catch (err: any) {
        if (batch.length === 1) {
          console.warn(
            `[AI] Skipping photo ${batch[0].id} — worker crash: ${err.message}`
          );
          return 0;
        }
        const mid = Math.floor(batch.length / 2);
        const left = await processBatch(batch.slice(0, mid));
        const right = await processBatch(batch.slice(mid));
        return left + right;
      }
    }
    for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
      if (!isEmbedding) {
        console.log("[AI] Embedding stopped by user");
        break;
      }
      const batch = unprocessed.slice(i, i + BATCH_SIZE);
      setCurrentProgress({
        processed,
        total,
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
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "idle",
      currentFile: "",
    });
  } else if (total === 0 && totalPhotos > 0) {
    // All photos already processed — report complete with actual counts
    setCurrentProgress({
      processed: processedCount,
      total: processedCount,
      phase: "complete",
      currentFile: "",
    });
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

  // Run batch auto-tagging only for newly embedded photos (incremental).
  if (successfulIds.length > 0) {
    batchSuggestTags(successfulIds)
      .then((r) =>
        console.log(
          `[AI] Auto-tag complete: ${r.tagged} tagged, ${r.skipped} skipped`
        )
      )
      .catch((err) => console.error("[AI] Auto-tag failed:", err?.message));
  }

  // Create / rebuild vector index via unified entry point.
  if (processed > 0 && photoTable) {
    await ensureVectorIndex(true);
  }

  return processed;
}
