import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { eq, inArray, sql } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import {
  isEmbeddingProviderError,
  shutdownPool,
} from "@/services/embed-worker-pool";
import { getSetting } from "@/services/settings-manager";
import { trackChildProcess } from "@/services/tracked-child-processes";
import { BATCH_SIZE, WORKER_TIMEOUT } from "./constants";
import { getActiveEmbeddingWorkerAdapter } from "./model-config";
import { shouldPublishVectorFingerprint } from "./model-fingerprint";
import { ensureLocalModel } from "./model-loader";
import type { EmbedProgress, EmbedProgressCallback } from "./state";
import {
  _localModelPath,
  activeEmbeddingRunId,
  addPendingAutoTagPhotoIds,
  addWrittenPhotoIdsForRun,
  beginEmbeddingRun,
  clearWrittenPhotoIdsForRun,
  currentProgress,
  drainPendingAutoTagPhotoIds,
  finishEmbeddingRun,
  getAiControlState,
  getWrittenPhotoIds,
  getWrittenPhotoIdsForRun,
  isCurrentEmbeddingRun,
  isEmbedding,
  isRunWritable,
  photoTable,
  poolCancelled,
  removePendingAutoTagPhotoIds,
  setCurrentProgress,
  setIsEmbedding,
  setLocalModelPath,
  setPoolCancelled,
  setWasAutoRepaired,
  setWrittenPhotoIds,
  wasAutoRepaired,
} from "./state";
import { batchSuggestTags } from "./tag-suggester";
import {
  buildPhotoIdFilter,
  cleanupOrphanVectors,
  deletePhotoVectors,
  ensureVectorIndex,
  initVectorDB,
  persistActiveVectorFingerprint,
  withVectorDbOperation,
} from "./vector-db";

function appendAiWorkerLog(message: string): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "ai-worker.log"),
      `${new Date().toISOString()} ${message}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

function findWorkerScript(): string {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
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

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function batchUpdatePhotoStatus(
  db: ReturnType<typeof getDatabase>,
  photoIds: number[]
): number[] {
  if (photoIds.length === 0) {
    return [];
  }

  const CHUNK_SIZE = 500;
  const updatedIds: number[] = [];

  for (let i = 0; i < photoIds.length; i += CHUNK_SIZE) {
    const chunk = photoIds.slice(i, i + CHUNK_SIZE);

    try {
      db.update(photos)
        .set({ isAiProcessed: true })
        .where(inArray(photos.id, chunk))
        .run();
      updatedIds.push(...chunk);
    } catch {
      console.warn(
        `[AI] Batch update failed for chunk ${i}-${i + chunk.length}, falling back to individual updates`
      );

      for (const id of chunk) {
        try {
          db.update(photos)
            .set({ isAiProcessed: true, vectorId: `vec_${id}` })
            .where(eq(photos.id, id))
            .run();
          updatedIds.push(id);
        } catch {
          /* skip */
        }
      }
    }
  }
  return updatedIds;
}

interface EmbedWorkerMessage {
  adapterId?: string;
  error?: string;
  file?: string;
  fingerprint?: string;
  loaded?: number;
  percent?: number;
  results?: EmbedResult[];
  total?: number;
  type?: string;
}

function isEmbedWorkerMessage(message: unknown): message is EmbedWorkerMessage {
  return typeof message === "object" && message !== null;
}

function runEmbedBatch(
  batchPhotos: Array<{ id: number; path: string }>,
  modelPath: string
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    const adapter = getActiveEmbeddingWorkerAdapter(modelPath);
    const workerScript = findWorkerScript();

    appendAiWorkerLog(
      `[Batch Worker] spawn script=${workerScript} modelPath=${modelPath} photos=${batchPhotos.length}`
    );
    console.log(
      `[AI] Forking worker for ${batchPhotos.length} photos: ${workerScript}`
    );

    const child = trackChildProcess(
      fork(workerScript, [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        timeout: WORKER_TIMEOUT,
      })
    );
    captureWorkerOutput(child, "embedder-worker");

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
      const line = data.toString().trim();
      if (line) {
        appendAiWorkerLog(`[Batch Worker] stderr ${line}`);
      }
    });

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Worker protocol handling must keep all terminal and progress states synchronized.
    child.on("message", (rawMessage: unknown) => {
      if (!isEmbedWorkerMessage(rawMessage)) {
        return;
      }
      const msg = rawMessage;
      if (msg.type === "init-progress") {
        const loaded = Number(msg.loaded ?? 0);
        const total = Number(msg.total ?? 0);
        const rawPercent = Math.max(1, Math.min(99, Number(msg.percent ?? 1)));
        const prev = currentProgress.downloadPercent ?? 0;
        const downloadPercent = rawPercent > prev ? rawPercent : prev;
        setCurrentProgress({
          ...currentProgress,
          phase: "loading",
          currentFile: msg.file ?? "SigLIP model",
          downloadPercent,
        });
        if (total > 0) {
          console.log(
            `[AI] SigLIP download ${downloadPercent}% (${loaded}/${total})`
          );
        }
        return;
      }
      if (msg.type === "ready") {
        child.send({ type: "embed", photos: batchPhotos });
        return;
      }
      if (msg.type === "init-error" && !resolved) {
        appendAiWorkerLog(
          `[Batch Worker] init-error ${msg.error || "Worker init failed"}`
        );
        resolved = true;
        clearTimeout(timeout);
        reject(new Error(msg.error || "Worker init failed"));
        return;
      }
      if (msg.type === "result" && !resolved) {
        if (
          msg.adapterId !== adapter.adapterId ||
          msg.fingerprint !== adapter.fingerprint
        ) {
          resolved = true;
          clearTimeout(timeout);
          reject(new Error("Stale image embedding worker result discarded"));
          return;
        }
        const results = msg.results ?? [];
        appendAiWorkerLog(
          `[Batch Worker] result ok=${results.filter((r) => r.vector && r.vector.length > 0).length} errors=${results
            .filter((r) => r.error)
            .map((r) => `${r.id}:${r.error}`)
            .join(" | ")
            .slice(0, 1000)}`
        );
        resolved = true;
        clearTimeout(timeout);
        resolve(results);
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

    child.send({
      type: "init",
      adapter,
      execution: { provider: "cpu", intraOpNumThreads: 1 },
    });
  });
}

/**
 * Clean up partially embedded data when user cancels AI indexing.
 * Follows the same pattern as scan cancellation cleanup in listing.ts.
 */
export async function cleanupPartialEmbedding(
  runId = activeEmbeddingRunId
): Promise<void> {
  const ids =
    runId > 0
      ? [...getWrittenPhotoIdsForRun(runId)]
      : [...getWrittenPhotoIds()];
  if (ids.length === 0) {
    if (runId > 0) {
      clearWrittenPhotoIdsForRun(runId);
    }
    return;
  }

  const db = getDatabase();
  console.log(`[AI] Cleaning up ${ids.length} partially embedded photos`);

  // 1. Transaction: batch reset SQLite isAiProcessed flags
  const CHUNK_SIZE = 500;
  db.transaction(() => {
    for (let i = 0; i < ids.length; i += CHUNK_SIZE) {
      const chunk = ids.slice(i, i + CHUNK_SIZE);
      db.update(photos)
        .set({ isAiProcessed: false })
        .where(inArray(photos.id, chunk))
        .run();
    }
  });

  // 2. Delete LanceDB vectors
  await deletePhotoVectors(ids).catch(() => {
    /* best-effort */
  });
  removePendingAutoTagPhotoIds(ids);

  // 3. Clear tracked IDs
  // Note: Thumbnail files are preserved — they were generated during import,
  // not during AI indexing. Deleting them would cause unnecessary regeneration.
  if (runId > 0) {
    clearWrittenPhotoIdsForRun(runId);
  } else {
    setWrittenPhotoIds(new Set());
  }

  console.log(`[AI] Cleanup complete: ${ids.length} photos reverted`);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Embedding orchestration preserves cancellation, recovery, persistence, and auto-tagging lifecycle in one transaction-like flow.
export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  // Atomically guard against concurrent calls
  if (getAiControlState() !== "idle" || isEmbedding) {
    console.warn(
      `[AI] embedAllPhotos skipped because controlState=${getAiControlState()}`
    );
    return 0;
  }
  const shouldResetPool = poolCancelled;
  const runId = beginEmbeddingRun();
  const shouldStopRun = () => !isRunWritable(runId) || poolCancelled;
  let didFinishCurrentRun = false;
  const finishRun = (nextState: "idle" | "paused") => {
    const finished = finishEmbeddingRun(runId, nextState);
    didFinishCurrentRun = didFinishCurrentRun || finished;
    return finished;
  };
  const settleStoppedRun = async (processedCount = 0) => {
    if (isCurrentEmbeddingRun(runId) && getAiControlState() === "cancelling") {
      await cleanupPartialEmbedding(runId);
      finishRun("idle");
      shutdownPool();
      return 0;
    }
    if (isCurrentEmbeddingRun(runId) && getAiControlState() === "pausing") {
      finishRun("paused");
      shutdownPool();
    }
    return processedCount;
  };

  // Reset the per-session tracking set so cancellations only affect this run.
  setWrittenPhotoIds(new Set());

  // Allow previous cancelled pool to fully settle before starting fresh.
  // Explicitly destroy the old pool so initWorkerPool doesn't short-circuit
  // and reuse stale slots — which could cause duplicate embeddings or
  // inconsistent state after a rapid stop→start cycle.
  if (shouldResetPool) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      shutdownPool();
    } catch {
      // pool may not have been started
    }
    // Reset the cancel flag so the fallback path is not blocked if pool init fails
    setPoolCancelled(false);
  }

  // Detect if this embedding was triggered by auto-repair of corrupted vector DB
  const isAutoRepair = wasAutoRepaired;
  if (isAutoRepair) {
    console.log("[AI] embedAllPhotos: running in auto-repair context");
    // Clear the flag so subsequent calls don't show repair reason
    setWasAutoRepaired(false);
  }

  try {
    const db = getDatabase();

    // Check that the worker script exists before starting
    try {
      const workerScript = findWorkerScript();
      console.log(`[AI] Embed worker found: ${workerScript}`);
    } catch (err: unknown) {
      setCurrentProgress({
        processed: 0,
        total: 0,
        phase: "error",
        currentFile: "",
        downloadPercent: undefined,
        error: `嵌入 Worker 脚本未找到: ${getErrorMessage(err)}`,
      });
      onProgress?.(currentProgress);
      finishRun("idle");
      return 0;
    }

    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: isAutoRepair ? "repairing" : "loading",
      currentFile: "",
      downloadPercent: 0,
      loadingStartedAt: Date.now(),
      repairReason: isAutoRepair
        ? "向量数据库损坏已自动修复，正在重新索引所有照片"
        : undefined,
    });
    onProgress?.(currentProgress);

    // Ensure model path is resolved (worker needs the local model path)
    const modelPath = _localModelPath ?? (await ensureLocalModel());
    if (!_localModelPath) {
      setLocalModelPath(modelPath);
    }
    if (shouldStopRun()) {
      return await settleStoppedRun(0);
    }

    await initVectorDB();
    if (shouldStopRun()) {
      return await settleStoppedRun(0);
    }

    if (!photoTable) {
      setCurrentProgress({
        processed: 0,
        total: 0,
        phase: "error",
        currentFile: "",
        downloadPercent: undefined,
        error: "向量数据库初始化失败",
      });
      onProgress?.(currentProgress);
      finishRun("idle");
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

    // Count non-deleted photos for orphan detection (soft-deleted photos still have vectors)
    const nonDeletedRow = db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(sql`${photos.deletedAt} IS NULL`)
      .get();
    const nonDeletedCount: number = nonDeletedRow?.count ?? 0;

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

    if (vectorCount > nonDeletedCount) {
      const softDeletedIds = db
        .select({ id: photos.id })
        .from(photos)
        .where(sql`${photos.deletedAt} IS NOT NULL`)
        .all()
        .map((p) => p.id);
      const removed = await cleanupOrphanVectors(softDeletedIds);
      if (removed > 0) {
        vectorCount = await photoTable.countRows();
      }
    }

    // Re-queue photos flagged as processed but missing from LanceDB. This
    // happens when a previous worker run failed mid-batch — SQLite still has
    // isAiProcessed=true on photos whose vectors never landed in LanceDB.
    if (!needsRepair && vectorCount < processedCount) {
      try {
        const lanceRows = (await photoTable
          .query()
          .select(["photo_id"])
          .toArray()) as Array<{ photo_id: number }>;
        const lanceIds = new Set(lanceRows.map((r) => r.photo_id));
        const processedIds = db
          .select({ id: photos.id })
          .from(photos)
          .where(
            sql`${photos.isAiProcessed} = 1 AND ${photos.deletedAt} IS NULL`
          )
          .all()
          .map((r) => r.id);
        const missing = processedIds.filter((id) => !lanceIds.has(id));
        if (missing.length > 0) {
          console.log(
            `[AI] Re-queuing ${missing.length} photos missing from LanceDB`
          );
          const CHUNK = 500;
          for (let i = 0; i < missing.length; i += CHUNK) {
            const chunk = missing.slice(i, i + CHUNK);
            db.update(photos)
              .set({ isAiProcessed: false })
              .where(sql`${photos.id} IN (${sql.raw(chunk.join(","))})`)
              .run();
          }
        }
      } catch (err: unknown) {
        console.warn(
          `[AI] Could not check LanceDB for missing vectors: ${getErrorMessage(err)}`
        );
      }
    }

    const unprocessed = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(sql`${photos.isAiProcessed} = 0 AND ${photos.deletedAt} IS NULL`)
      .all();

    const total = unprocessed.length;
    let processed = 0;
    const successfulIds: number[] = [];

    if (total === 0) {
      setCurrentProgress({
        processed: totalPhotos > 0 ? processedCount : 0,
        total: totalPhotos > 0 ? processedCount : 0,
        phase: totalPhotos > 0 ? "complete" : "idle",
        currentFile: "",
        downloadPercent: undefined,
        loadingStartedAt: null,
      });
      onProgress?.(currentProgress);
      console.log("[AI] No photos need embedding; worker pool startup skipped");
      finishRun("idle");
      return 0;
    }

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Persistence keeps vector writes, cancellation cleanup, and SQLite status updates atomic from the caller's perspective.
    async function persistEmbedResults(
      results: EmbedResult[]
    ): Promise<number> {
      if (!isRunWritable(runId)) {
        return 0;
      }
      const candidateResults = results.filter(
        (r) => r.vector && r.vector.length > 0
      );
      const candidateIds = candidateResults.map((result) => result.id);
      const activeIds = new Set(
        candidateIds.length > 0
          ? db
              .select({ id: photos.id })
              .from(photos)
              .where(
                sql`${photos.id} IN (${sql.raw(candidateIds.join(","))}) AND ${photos.deletedAt} IS NULL`
              )
              .all()
              .map((row) => row.id)
          : []
      );
      const successResults = candidateResults.filter((result) =>
        activeIds.has(result.id)
      );
      if (!(successResults.length > 0 && photoTable)) {
        return 0;
      }

      const batchIds = successResults.map((r) => r.id);

      try {
        await photoTable.delete(buildPhotoIdFilter(batchIds));
      } catch {
        /* first write 鈥?table may be empty */
      }

      const records = successResults.map((r) => ({
        photo_id: r.id,
        vector: r.vector,
        created_at: Date.now(),
      }));
      const writtenIds = new Set<number>();
      try {
        await photoTable.add(records);
        for (const id of batchIds) {
          writtenIds.add(id);
        }
      } catch (lanceErr: unknown) {
        console.warn(
          `[AI] Batch add failed (${getErrorMessage(lanceErr)}), falling back to individual writes`
        );
        for (const record of records) {
          try {
            await photoTable.add([record]);
            writtenIds.add(record.photo_id);
          } catch (individualErr: unknown) {
            console.warn(
              `[AI] Vector write failed for photo ${record.photo_id}: ${getErrorMessage(individualErr)}`
            );
          }
        }
      }

      if (!isRunWritable(runId)) {
        await deletePhotoVectors([...writtenIds]).catch(() => {
          /* best-effort */
        });
        return 0;
      }

      const writtenBatchIds = [...writtenIds];
      if (writtenBatchIds.length === 0) {
        return 0;
      }

      const stillActiveIds = new Set(
        db
          .select({ id: photos.id })
          .from(photos)
          .where(
            sql`${photos.id} IN (${sql.raw(writtenBatchIds.join(","))}) AND ${photos.deletedAt} IS NULL`
          )
          .all()
          .map((row) => row.id)
      );
      const removedDuringWrite = writtenBatchIds.filter(
        (photoId) => !stillActiveIds.has(photoId)
      );
      if (removedDuringWrite.length > 0) {
        await deletePhotoVectors(removedDuringWrite);
      }
      const persistedIds = writtenBatchIds.filter((photoId) =>
        stillActiveIds.has(photoId)
      );
      if (persistedIds.length === 0) {
        return 0;
      }

      const statusIds = batchUpdatePhotoStatus(db, persistedIds);
      const statusIdSet = new Set(statusIds);
      const failedStatusIds = persistedIds.filter((id) => !statusIdSet.has(id));
      if (failedStatusIds.length > 0) {
        await deletePhotoVectors(failedStatusIds).catch(() => {
          /* best-effort */
        });
      }
      addWrittenPhotoIdsForRun(runId, statusIds);
      addPendingAutoTagPhotoIds(statusIds);
      successfulIds.push(...statusIds);
      return statusIds.length;
    }

    console.log(`[AI] Starting embedding for ${total} photos via Worker Pool`);

    // Use persistent worker pool
    let poolReady = false;
    let gpuFallbackAttempted = false;
    const useGPU = getSetting("gpu.enabled") === "true";
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Pool orchestration keeps initialization, progress, cancellation, persistence, and the single CPU fallback together.
    async function runPoolEmbedding(
      attemptUseGPU: boolean
    ): Promise<number | null> {
      const { initWorkerPool, embedWithPool, getPoolInitProgress } =
        await import("@/services/embed-worker-pool");

      // Poll real pool init progress while workers load ONNX models.
      // Replaces the old time-based fake progress with worker-reported progress.
      const poolProgressInterval = setInterval(() => {
        if (!isCurrentEmbeddingRun(runId)) {
          return;
        }
        const pct = getPoolInitProgress();
        if (pct > 0) {
          setCurrentProgress({
            ...currentProgress,
            downloadPercent: pct,
            loadingStartedAt: null, // real progress, no need for time estimate
          });
          if (isEmbedding) {
            onProgress?.(currentProgress);
          }
        }
      }, 300);

      try {
        await initWorkerPool(modelPath, attemptUseGPU);
      } finally {
        clearInterval(poolProgressInterval);
        // Mark init complete at 100%
        if (isCurrentEmbeddingRun(runId)) {
          setCurrentProgress({
            ...currentProgress,
            downloadPercent: 100,
            loadingStartedAt: null,
          });
          if (isEmbedding) {
            onProgress?.(currentProgress);
          }
        }
      }
      poolReady = true;

      if (shouldStopRun()) {
        throw new Error("Embedding run stopped before worker pool dispatch");
      }
      await embedWithPool(
        unprocessed,
        (done, tot) => {
          if (!isCurrentEmbeddingRun(runId)) {
            return;
          }
          setCurrentProgress({
            processed: done,
            total: tot,
            phase: "embedding",
            currentFile: `pool: ${done}/${tot}`,
            downloadPercent: undefined,
            loadingStartedAt: null,
          });
          if (isEmbedding) {
            onProgress?.(currentProgress);
          }
        },
        shouldStopRun,
        async (results) => {
          processed += await withVectorDbOperation(() =>
            persistEmbedResults(results)
          );
        }
      );
      // Persist results to LanceDB and SQLite — batch write
      const successResults: EmbedResult[] = [];
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
        } catch (lanceErr: unknown) {
          console.warn(
            `[AI] Batch add failed (${getErrorMessage(lanceErr)}), falling back to individual writes`
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
        batchUpdatePhotoStatus(db, batchIds);

        // Track written IDs for potential cancel cleanup
        addWrittenPhotoIdsForRun(runId, batchIds);
        addPendingAutoTagPhotoIds(batchIds);

        processed = successResults.length;
        successfulIds.push(...batchIds);
      }

      // After pool completes (or stops due to cancel): check for cancellation
      if (
        isCurrentEmbeddingRun(runId) &&
        getAiControlState() === "cancelling"
      ) {
        console.log("[AI] Embedding cancelled by user, cleaning up...");
        await cleanupPartialEmbedding(runId);
        setCurrentProgress({
          processed: 0,
          total: 0,
          phase: "idle",
          currentFile: "",
          downloadPercent: undefined,
        });
        onProgress?.(currentProgress);
        finishRun("idle");
        shutdownPool();
        return 0;
      }

      if (isCurrentEmbeddingRun(runId) && getAiControlState() === "pausing") {
        console.log(
          `[AI] Embedding paused at ${processed}/${total}, preserving state`
        );
        setCurrentProgress({
          processed,
          total,
          phase: "embedding",
          currentFile: `paused at ${processed}/${total}`,
          downloadPercent: undefined,
          loadingStartedAt: null,
        });
        onProgress?.(currentProgress);
        finishRun("paused");
        shutdownPool();
        return processed;
      }
      return null;
    }

    try {
      const stoppedResult = await runPoolEmbedding(useGPU);
      if (stoppedResult !== null) {
        return stoppedResult;
      }
    } catch (poolErr: unknown) {
      if (
        isEmbeddingProviderError(poolErr) &&
        useGPU &&
        !gpuFallbackAttempted
      ) {
        gpuFallbackAttempted = true;
        console.warn(
          `[AI] DirectML embedding failed; cleaning partial vectors and retrying the full run on CPU: ${getErrorMessage(poolErr)}`
        );
        appendAiWorkerLog(
          `[Embedding] DirectML failed; CPU fallback started: ${getErrorMessage(poolErr)}`
        );
        await cleanupPartialEmbedding(runId);
        processed = 0;
        successfulIds.length = 0;
        poolReady = false;
        shutdownPool();
        try {
          const stoppedResult = await runPoolEmbedding(false);
          if (stoppedResult !== null) {
            return stoppedResult;
          }
        } catch (cpuErr: unknown) {
          console.error(
            `[AI] CPU retry after DirectML failure also failed: ${getErrorMessage(cpuErr)}`
          );
          appendAiWorkerLog(
            `[Embedding] CPU fallback failed after DirectML failure: ${getErrorMessage(cpuErr)}`
          );
          throw cpuErr;
        }
      } else {
        console.error("[AI] Worker pool failed:", getErrorMessage(poolErr));
      }
    }

    // If pool was cancelled or paused, don't proceed to fallback
    if (shouldStopRun()) {
      return await settleStoppedRun(processed);
    }

    // If pool is not available, fall back to legacy per-batch fork
    if (!poolReady) {
      const legacyTable = photoTable;
      if (!legacyTable) {
        return await settleStoppedRun(processed);
      }

      // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Legacy worker fallback recursively bisects failed batches while preserving the existing retry behavior.
      async function processBatch(
        batch: Array<{ id: number; path: string }>
      ): Promise<number> {
        if (batch.length === 0) {
          return 0;
        }

        try {
          const results = await runEmbedBatch(batch, modelPath);
          if (!isRunWritable(runId)) {
            return 0;
          }
          const candidateBatch = results.filter(
            (r) => r.vector && r.vector.length > 0
          );
          const candidateIds = candidateBatch.map((result) => result.id);
          const activeIds = new Set(
            candidateIds.length > 0
              ? db
                  .select({ id: photos.id })
                  .from(photos)
                  .where(
                    sql`${photos.id} IN (${sql.raw(candidateIds.join(","))}) AND ${photos.deletedAt} IS NULL`
                  )
                  .all()
                  .map((row) => row.id)
              : []
          );
          const successBatch = candidateBatch.filter((result) =>
            activeIds.has(result.id)
          );

          if (successBatch.length > 0) {
            const ids = successBatch.map((r) => r.id);
            try {
              await legacyTable.delete(buildPhotoIdFilter(ids));
            } catch {
              /* best-effort */
            }

            const records = successBatch.map((r) => ({
              photo_id: r.id,
              vector: r.vector,
              created_at: Date.now(),
            }));
            const writtenIds = new Set<number>();
            try {
              await legacyTable.add(records);
              for (const id of ids) {
                writtenIds.add(id);
              }
            } catch (lanceErr: unknown) {
              console.warn(
                `[AI] Legacy batch add failed (${getErrorMessage(lanceErr)}), falling back to individual writes`
              );
              for (const record of records) {
                try {
                  await legacyTable.add([record]);
                  writtenIds.add(record.photo_id);
                } catch (individualErr: unknown) {
                  console.warn(
                    `[AI] Legacy vector write failed for photo ${record.photo_id}: ${getErrorMessage(individualErr)}`
                  );
                }
              }
            }

            if (!isRunWritable(runId)) {
              await deletePhotoVectors([...writtenIds]).catch(() => {
                /* best-effort */
              });
              return 0;
            }

            const writtenBatchIds = [...writtenIds];
            if (writtenBatchIds.length === 0) {
              return 0;
            }

            const stillActiveIds = new Set(
              db
                .select({ id: photos.id })
                .from(photos)
                .where(
                  sql`${photos.id} IN (${sql.raw(writtenBatchIds.join(","))}) AND ${photos.deletedAt} IS NULL`
                )
                .all()
                .map((row) => row.id)
            );
            const removedDuringWrite = writtenBatchIds.filter(
              (photoId) => !stillActiveIds.has(photoId)
            );
            if (removedDuringWrite.length > 0) {
              await deletePhotoVectors(removedDuringWrite);
            }
            const persistedIds = writtenBatchIds.filter((photoId) =>
              stillActiveIds.has(photoId)
            );
            if (persistedIds.length === 0) {
              return 0;
            }

            const statusIds = batchUpdatePhotoStatus(db, persistedIds);
            const statusIdSet = new Set(statusIds);
            const failedStatusIds = persistedIds.filter(
              (id) => !statusIdSet.has(id)
            );
            if (failedStatusIds.length > 0) {
              await deletePhotoVectors(failedStatusIds).catch(() => {
                /* best-effort */
              });
            }
            // Track written IDs for potential cancel cleanup
            addWrittenPhotoIdsForRun(runId, statusIds);
            addPendingAutoTagPhotoIds(statusIds);
            successfulIds.push(...statusIds);
            return statusIds.length;
          }
          return 0;
        } catch (err: unknown) {
          if (batch.length === 1) {
            console.warn(
              `[AI] Skipping photo ${batch[0].id} — worker crash: ${getErrorMessage(err)}`
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
        if (shouldStopRun()) {
          console.log("[AI] Embedding stopped by user");
          break;
        }
        const batch = unprocessed.slice(i, i + BATCH_SIZE);
        setCurrentProgress({
          processed,
          total,
          phase: "embedding",
          currentFile: `batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)}`,
          downloadPercent: undefined,
          loadingStartedAt: null,
        });
        onProgress?.(currentProgress);
        const batchCount = await processBatch(batch);
        processed += batchCount;
        if (batchCount < batch.length) {
          console.warn(`[AI] Batch: ${batchCount}/${batch.length} succeeded`);
        }
      }
    }

    // If paused, skip the final phase reporting — already set in pool section
    if (shouldStopRun()) {
      return await settleStoppedRun(processed);
    }

    if (!isCurrentEmbeddingRun(runId)) {
      return processed;
    }

    let finalProgress: EmbedProgress;
    if (total === 0 && totalPhotos === 0) {
      finalProgress = {
        processed: 0,
        total: 0,
        phase: "idle",
        currentFile: "",
        downloadPercent: undefined,
      };
    } else if (total === 0 && totalPhotos > 0) {
      finalProgress = {
        processed: processedCount,
        total: processedCount,
        phase: "complete",
        currentFile: "",
        downloadPercent: undefined,
      };
    } else if (processed === 0) {
      finalProgress = {
        processed: 0,
        total,
        phase: "error",
        currentFile: "",
        downloadPercent: undefined,
        error:
          "AI 嵌入失败：Worker 进程未能处理任何照片，请检查模型文件和依赖是否完整",
      };
    } else {
      finalProgress = {
        processed,
        total,
        phase: "complete",
        currentFile: "",
        downloadPercent: undefined,
      };
    }

    const autoTagIds = drainPendingAutoTagPhotoIds();
    let tagError: string | undefined;
    if (finalProgress.phase !== "error" && autoTagIds.length > 0) {
      setCurrentProgress({
        processed: 0,
        total: autoTagIds.length,
        phase: "tagging",
        currentFile: "",
        downloadPercent: undefined,
      });
      onProgress?.(currentProgress);
      try {
        const r = await batchSuggestTags(
          autoTagIds,
          (taggedCount, tagTotal, photoId) => {
            setCurrentProgress({
              processed: taggedCount,
              total: tagTotal,
              phase: "tagging",
              currentFile: String(photoId),
              downloadPercent: undefined,
            });
            onProgress?.(currentProgress);
          }
        );
        console.log(
          `[AI] Auto-tag complete: ${r.tagged} tagged, ${r.skipped} skipped`
        );
      } catch (err: unknown) {
        tagError = getErrorMessage(err);
        console.error("[AI] Auto-tag failed:", tagError);
      }
    }

    // Publish the model identity only after every photo in this indexing run
    // has been persisted. A partial, cancelled, or failed build must not make
    // a mixed vector table look complete.
    if (processed > 0 && processed === total && photoTable) {
      const indexReady = await ensureVectorIndex(true);
      if (
        shouldPublishVectorFingerprint({
          hasVectorTable: Boolean(photoTable),
          indexReady,
          processed,
          runWritable: isRunWritable(runId),
          total,
        })
      ) {
        await persistActiveVectorFingerprint("fresh-build");
      }
    }

    if (tagError) {
      setCurrentProgress({
        processed: currentProgress.processed,
        total: currentProgress.total,
        phase: "tag-error",
        currentFile: "",
        downloadPercent: undefined,
        error: tagError,
      });
    } else {
      setCurrentProgress(finalProgress);
    }
    onProgress?.(currentProgress);

    finishRun("idle");
    return processed;
  } catch (err: unknown) {
    if (!isCurrentEmbeddingRun(runId)) {
      return 0;
    }
    if (getAiControlState() === "cancelling") {
      return await settleStoppedRun(0);
    }
    const message = getErrorMessage(err);
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      downloadPercent: undefined,
      error: message,
    });
    onProgress?.(currentProgress);
    finishRun("idle");
    throw err;
  } finally {
    if (isCurrentEmbeddingRun(runId)) {
      setIsEmbedding(false);
    }
    if (didFinishCurrentRun) {
      try {
        const { BrowserWindow } = await import("electron");
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("ai-embedding-done", {
            error:
              currentProgress.phase === "error"
                ? currentProgress.error
                : undefined,
          });
        }
      } catch {
        /* best-effort */
      }
    }
  }
}
