import fs from "node:fs";
import path from "node:path";
import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
} from "apache-arrow";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { appSettings, photos } from "@/db/schema";
import { getDataPath } from "@/utils/data-path";
import { MIN_VECTORS_FOR_INDEX } from "./constants";
import { getActiveEmbeddingAdapter } from "./model-adapter";
import {
  getActiveEmbeddingModel,
  getActiveEmbeddingRuntimeInfo,
} from "./model-config";
import {
  decideVectorCompatibility,
  getModelFingerprint,
  inspectStoredVectorFingerprint,
  isVectorCompatibilitySearchable,
  type VectorCompatibility,
  verifyAdapterArtifacts,
  writeStoredVectorFingerprint,
} from "./model-fingerprint";
import {
  _localModelPath,
  colorTable,
  getActiveEmbeddingRuntime,
  isVectorDBReady,
  photoTable,
  setActiveEmbeddingRuntime,
  setColorTable,
  setIsVectorDBReady,
  setPhotoTable,
  setVectorCompatibility,
  setVectordb,
  setWasAutoRepaired,
  vectordb,
} from "./state";
import { getActiveThresholdProfile } from "./threshold-profile";
import {
  getUnreconciledVectorIds,
  planVectorReconciliation,
} from "./vector-reconciliation";

type MaintenanceTable = LanceTable & {
  cleanupOldVersions?: () => Promise<void>;
  compactFiles?: () => Promise<void>;
};

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error === "object" && error !== null && "code" in error) {
    const code = error.code;
    return typeof code === "string" ? code : undefined;
  }
  return undefined;
}

function getListSize(type: unknown): number | undefined {
  if (
    typeof type === "object" &&
    type !== null &&
    "listSize" in type &&
    typeof type.listSize === "number"
  ) {
    return type.listSize;
  }
  return undefined;
}

interface ArrayLikeVector {
  toArray: () => ArrayLike<number>;
}

function isArrayLikeVector(value: unknown): value is ArrayLikeVector {
  return (
    typeof value === "object" &&
    value !== null &&
    "toArray" in value &&
    typeof value.toArray === "function"
  );
}

function isNumberIterable(value: unknown): value is Iterable<number> {
  return (
    typeof value === "object" && value !== null && Symbol.iterator in value
  );
}

// ── 向量数据库定期维护 ──────────────────────────────────────────────
// 数据追加后 LanceDB 产生碎片和旧版本文件，定期压缩清理释放磁盘空间。
// 首次延迟 30s 避开启动 I/O 高峰，后续每 24h 静默执行一次。

let maintenanceTimer: ReturnType<typeof setTimeout> | null = null;
let maintenanceRunning = false;

async function runVectorMaintenance(): Promise<void> {
  if (!photoTable || maintenanceRunning) {
    return;
  }
  maintenanceRunning = true;
  try {
    // Phase 1: compact files — merges fragmented data shards
    try {
      const maintenanceTable = photoTable as MaintenanceTable;
      if (maintenanceTable.compactFiles) {
        await maintenanceTable.compactFiles();
        console.log("[AI] Maintenance: compactFiles OK");
      }
    } catch (err: unknown) {
      console.warn(
        "[AI] Maintenance: compactFiles skipped:",
        getErrorMessage(err)
      );
    }

    // Phase 2: cleanup old versions — removes stale version history
    try {
      const maintenanceTable = photoTable as MaintenanceTable;
      if (maintenanceTable.cleanupOldVersions) {
        await maintenanceTable.cleanupOldVersions();
        console.log("[AI] Maintenance: cleanupOldVersions OK");
      }
    } catch (err: unknown) {
      console.warn(
        "[AI] Maintenance: cleanupOldVersions skipped:",
        getErrorMessage(err)
      );
    }
  } finally {
    maintenanceRunning = false;
  }
}

function scheduleVectorMaintenance(): void {
  if (maintenanceTimer) {
    return;
  }
  maintenanceTimer = setTimeout(() => {
    runVectorMaintenance();
    // 首次完成后切换为每日定时（24h）
    maintenanceTimer = setInterval(runVectorMaintenance, 24 * 60 * 60 * 1000);
  }, 30_000);
}

function clearVectorMaintenance(): void {
  if (maintenanceTimer) {
    clearInterval(maintenanceTimer);
    maintenanceTimer = null;
  }
}

let vectorDbInitPromise: Promise<void> | null = null;
let vectorDbGeneration = 0;
let vectorDbOperationTail = Promise.resolve();

/** Serialize destructive rebuild/close operations with embedding and search IO. */
export function withVectorDbOperation<T>(
  operation: () => Promise<T> | T
): Promise<T> {
  const run = vectorDbOperationTail.then(operation, operation);
  vectorDbOperationTail = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

export function getVectorDbGeneration(): number {
  return vectorDbGeneration;
}

function modelRootCandidates(): string[] {
  const candidates = [
    path.join(getDataPath(), "models"),
    path.join(process.cwd(), "models"),
    _localModelPath,
  ];
  return [
    ...new Set(
      candidates.filter((candidate): candidate is string => !!candidate)
    ),
  ];
}

async function canAdoptLegacyVectorStore(): Promise<boolean> {
  const adapter = getActiveEmbeddingAdapter();
  for (const modelRoot of modelRootCandidates()) {
    if (await verifyAdapterArtifacts(modelRoot, adapter.artifacts)) {
      return true;
    }
  }
  return false;
}

async function inspectVectorCompatibility(
  dataPath: string,
  dimensions: number,
  rowCount: number
): Promise<{ status: VectorCompatibility; adoptLegacy: boolean }> {
  const adapter = getActiveEmbeddingAdapter();
  const fingerprint = getModelFingerprint(adapter);
  const marker = inspectStoredVectorFingerprint(dataPath);
  const shouldVerifyLegacyArtifacts =
    marker.state === "missing" &&
    rowCount > 0 &&
    adapter.legacyKind === "siglip" &&
    dimensions === adapter.embeddingSpace.dimensions;

  return decideVectorCompatibility({
    active: {
      adapterId: adapter.id,
      dimensions: adapter.embeddingSpace.dimensions,
      fingerprint,
      legacyKind: adapter.legacyKind,
    },
    marker,
    rowCount,
    vectorDimensions: dimensions,
    legacyArtifactsVerified:
      shouldVerifyLegacyArtifacts && (await canAdoptLegacyVectorStore()),
  });
}

function initializeEmbeddingRuntime(): void {
  const info = getActiveEmbeddingRuntimeInfo();
  const profile = getActiveThresholdProfile();
  const current = getActiveEmbeddingRuntime();
  setActiveEmbeddingRuntime({
    ...info,
    vectorCompatibility:
      current?.adapterId === info.adapterId &&
      current.fingerprint === info.fingerprint &&
      current.dimensions === info.dimensions
        ? current.vectorCompatibility
        : "empty",
    thresholdProfileId: profile.profileId,
    calibrationStatus: profile.calibrationStatus,
  });
}

export async function persistActiveVectorFingerprint(
  source: "fresh-build" | "legacy-adoption" = "fresh-build"
): Promise<void> {
  const adapter = getActiveEmbeddingAdapter();
  await writeStoredVectorFingerprint(getDataPath(), {
    schemaVersion: 1,
    fingerprint: getModelFingerprint(adapter),
    adapterId: adapter.id,
    dimensions: adapter.embeddingSpace.dimensions,
    createdAt: new Date().toISOString(),
    source,
  });
  setVectorCompatibility(
    source === "legacy-adoption" ? "legacy-compatible" : "matching"
  );
}

export function initVectorDB(): Promise<void> {
  if (isVectorDBReady && vectordb && photoTable) {
    return Promise.resolve();
  }

  if (!vectorDbInitPromise) {
    const promise = initializeVectorDB();
    const trackedPromise = promise.finally(() => {
      if (vectorDbInitPromise === trackedPromise) {
        vectorDbInitPromise = null;
      }
    });
    vectorDbInitPromise = trackedPromise;
  }

  return vectorDbInitPromise;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Vector DB startup keeps compatibility checks, corruption recovery, and table setup in one flow.
async function initializeVectorDB(): Promise<void> {
  const generation = vectorDbGeneration;
  initializeEmbeddingRuntime();
  // 清理上次重建残留的 .bak 目录
  await cleanupStaleBackups();

  const vectorPath = path.join(getDataPath(), "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  const lancedb = await import("@lancedb/lancedb");

  let db: LanceConnection;
  try {
    db = await lancedb.connect(vectorPath);
  } catch (err: unknown) {
    const message = getErrorMessage(err);
    console.error("[AI] LanceDB connect failed:", message);
    throw new Error(`Failed to connect to vector database: ${message}`);
  }
  if (generation !== vectorDbGeneration) {
    try {
      await db.close();
    } catch {
      /* best-effort close for a superseded connection */
    }
    throw new Error("Vector DB initialization superseded");
  }
  setVectordb(db);
  const model = getActiveEmbeddingModel();
  const vectorDimensions = model.vectorDimensions;

  const tableNames = await db.tableNames();

  if (tableNames.includes("photo_embeddings")) {
    let table: LanceTable | null = null;
    try {
      table = await db.openTable("photo_embeddings");
    } catch (err: unknown) {
      console.error("[AI] LanceDB openTable failed:", getErrorMessage(err));
      // Table exists but can't be opened — likely corrupted. Drop and recreate.
      try {
        await db.dropTable("photo_embeddings");
      } catch {
        // best-effort cleanup
      }
      setPhotoTable(null);
      // Fall through to create fresh table below
    }

    if (table) {
      setPhotoTable(table);

      const existingRowCount = await table.countRows();
      const compatibility = await inspectVectorCompatibility(
        getDataPath(),
        vectorDimensions,
        existingRowCount
      );
      setVectorCompatibility(compatibility.status);
      if (
        existingRowCount > 0 &&
        !isVectorCompatibilitySearchable(compatibility.status)
      ) {
        throw new Error(
          `Vector store is incompatible with active embedding model (${compatibility.status}); rebuild required`
        );
      }

      // Model changes also change the vector schema and require re-indexing.
      const schema = await table.schema();
      const vectorField = schema.fields.find(
        (field) => field.name === "vector"
      );
      const schemaValid =
        vectorField &&
        vectorField.type !== null &&
        typeof vectorField.type === "object" &&
        getListSize(vectorField.type) === vectorDimensions;

      if (schemaValid) {
        console.log("[AI] Opened existing photo_embeddings table (schema OK)");

        // Run deep validation BEFORE checking the crash-safety marker.
        // If the data is actually healthy (e.g. dev server restart where
        // closeVectorDB never ran), we should NOT drop it — just write the
        // marker and proceed. Only rebuild if validation genuinely fails.
        const validation = await validateVectorDB();

        if (validation.healthy) {
          if (compatibility.adoptLegacy) {
            await persistActiveVectorFingerprint("legacy-adoption");
            console.log("[AI] Adopted legacy SigLIP v1 vector fingerprint");
          }
          // Data is intact. If the marker is missing, it was a clean dev
          // restart or similar — just write it now and continue.
          if (!isIndexCleanShutdown()) {
            console.log(
              "[AI] Marker missing but data healthy — writing marker (clean restart)"
            );
            markIndexReady();
          }

          const indexOk = await ensureVectorIndex();
          if (!indexOk) {
            console.warn(
              "[AI] Proceeding without vector index — search may be slower"
            );
          }

          // ── 初始化颜色向量表（如不存在则创建） ───────────────
          await initColorTable(db);

          // 后台回填已有的 dominant_colors 到 LanceDB 颜色表
          backfillColorVectors().catch((err) =>
            console.warn("[AI] Color backfill failed:", getErrorMessage(err))
          );

          setIsVectorDBReady(true);
          scheduleVectorMaintenance();
          return;
        }

        // Validation failed — genuine corruption detected. Auto-rebuild.
        console.error(
          `[AI] Vector DB validation failed: ${validation.reason}. Auto-rebuilding...`
        );
        diagLog(
          `initVectorDB: validation failed — ${validation.reason}, auto-rebuilding`
        );

        if (vectordb) {
          try {
            await vectordb.close();
          } catch {
            /* best-effort */
          }
          setVectordb(null);
          setPhotoTable(null);
          setIsVectorDBReady(false);
        }

        const rebuildResult = await rebuildVectorDB();
        if (rebuildResult.success) {
          console.log("[AI] Auto-repair: vector DB rebuilt successfully");
          const resetCount = resetAllAiProcessedFlags();
          console.log(
            `[AI] Auto-repair: ${resetCount} photos marked for re-index`
          );
          setWasAutoRepaired(true);
          return;
        }
        console.error(
          `[AI] Auto-repair failed: ${rebuildResult.error}, proceeding degraded`
        );
      }
      console.log(
        `[AI] Schema mismatch — expected FixedSizeList<${vectorDimensions}> for ${model.displayName}. Recreating...`
      );
      await db.dropTable("photo_embeddings");
      setPhotoTable(null);
      const resetCount = resetAllAiProcessedFlags();
      console.log(
        `[AI] Model migration: ${resetCount} photos marked for ${model.displayName} re-index`
      );
      setWasAutoRepaired(true);
    }
  }

  // Create a fresh table matching the active embedding model.
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field(
      "vector",
      new FixedSizeList(vectorDimensions, new Field("item", new Float32()))
    ),
    new Field("created_at", new Float64()),
  ]);

  const newTable = await db.createEmptyTable("photo_embeddings", schema);
  setPhotoTable(newTable);
  setVectorCompatibility("empty");
  console.log(
    `[AI] Created photo_embeddings table (FixedSizeList<Float32>[${vectorDimensions}], ${model.displayName})`
  );
  markIndexDirty(); // New table has no data — will be set to ready after index build completes

  // ── 初始化颜色向量表（3D RGB） ───────────────────────────────────
  await initColorTable(db);

  // 后台回填已有的 dominant_colors 到 LanceDB 颜色表（不阻塞启动）
  backfillColorVectors().catch((err) =>
    console.warn("[AI] Color backfill failed:", getErrorMessage(err))
  );

  setIsVectorDBReady(true);
  scheduleVectorMaintenance();
}

export function buildPhotoIdFilter(ids: number[]): string {
  const validated = ids.filter(
    (id) => Number.isInteger(id) && id > 0 && id < 2_147_483_647
  );
  if (validated.length === 0) {
    throw new Error("[AI] buildPhotoIdFilter: no valid IDs");
  }
  return `photo_id IN (${validated.join(", ")})`;
}

/**
 * 清理孤儿和重复向量。
 * - SQLite 中不存在或已软删除的 photo_id：直接删除
 * - 同一有效 photo_id 存在多条向量：删除全部旧向量，并把照片重新排队嵌入
 */
export async function cleanupOrphanVectors(
  softDeletedIds: number[]
): Promise<number> {
  if (!(isVectorDBReady && photoTable)) {
    return 0;
  }
  let deleted = 0;
  try {
    const allRows = (await photoTable
      .query()
      .select(["photo_id"])
      .toArray()) as Array<{ photo_id: number }>;
    const db = getDatabase();
    const validIds = new Set(
      db
        .select({ id: photos.id })
        .from(photos)
        .where(isNull(photos.deletedAt))
        .all()
        .map((row) => row.id)
    );
    const { duplicateIds, orphanIds } = planVectorReconciliation(
      allRows.map((row) => row.photo_id),
      validIds,
      softDeletedIds
    );
    const idsToDelete = [...new Set([...orphanIds, ...duplicateIds])];
    const CHUNK_SIZE = 500;

    for (let index = 0; index < idsToDelete.length; index += CHUNK_SIZE) {
      await photoTable.delete(
        buildPhotoIdFilter(idsToDelete.slice(index, index + CHUNK_SIZE))
      );
    }

    if (duplicateIds.length > 0) {
      for (let index = 0; index < duplicateIds.length; index += CHUNK_SIZE) {
        db.update(photos)
          .set({ isAiProcessed: false })
          .where(
            inArray(photos.id, duplicateIds.slice(index, index + CHUNK_SIZE))
          )
          .run();
      }
    }

    if (idsToDelete.length > 0) {
      const remainingRows = (await photoTable
        .query()
        .select(["photo_id"])
        .toArray()) as Array<{ photo_id: number }>;
      const failedIds = getUnreconciledVectorIds(
        idsToDelete,
        remainingRows.map((row) => Number(row.photo_id))
      );
      if (failedIds.length > 0) {
        throw new Error(
          `Vector reconciliation could not remove photo IDs: ${failedIds.join(",")}`
        );
      }
      deleted = Math.max(0, allRows.length - remainingRows.length);
      console.log(
        `[AI] Vector reconciliation: removed ${deleted} rows (${orphanIds.length} orphan photo IDs, ${duplicateIds.length} duplicate photo IDs re-queued)`
      );
    }
  } catch (err: unknown) {
    console.error("[AI] Orphan vector cleanup failed:", getErrorMessage(err));
    throw err;
  }
  return deleted;
}

export async function deletePhotoVectors(photoIds: number[]): Promise<void> {
  if (photoIds.length === 0) {
    return;
  }

  try {
    if (!(isVectorDBReady && photoTable)) {
      await initVectorDB();
    }
    if (!photoTable) {
      throw new Error("vector database is not available");
    }

    const uniqueIds = [...new Set(photoIds)];
    const CHUNK_SIZE = 500;
    for (let index = 0; index < uniqueIds.length; index += CHUNK_SIZE) {
      await photoTable.delete(
        buildPhotoIdFilter(uniqueIds.slice(index, index + CHUNK_SIZE))
      );
    }
    console.log(
      `[AI] Deleted vectors for ${uniqueIds.length} photos from LanceDB`
    );
  } catch (err: unknown) {
    console.error("[AI] Failed to delete vectors:", getErrorMessage(err));
    throw err;
  }
}

export async function getPhotoVectors(
  photoIds: number[]
): Promise<Map<number, number[]>> {
  const map = new Map<number, number[]>();
  if (!(isVectorDBReady && photoTable) || photoIds.length === 0) {
    return map;
  }
  try {
    const filter = buildPhotoIdFilter(photoIds);
    const rows = (await photoTable.query().where(filter).toArray()) as Record<
      string,
      unknown
    >[];
    for (const row of rows) {
      const pid = row.photo_id as number;
      const rawVec = row.vector;
      if (pid == null || !rawVec) {
        continue;
      }

      // LanceDB returns Apache Arrow Vector — normalize to number[]
      let vec: number[];
      if (Array.isArray(rawVec)) {
        vec = rawVec as number[];
      } else if (isArrayLikeVector(rawVec)) {
        vec = Array.from(rawVec.toArray());
      } else if (ArrayBuffer.isView(rawVec)) {
        vec = Array.from(rawVec as Float32Array);
      } else if (isNumberIterable(rawVec)) {
        vec = Array.from(rawVec);
      } else {
        continue;
      }

      if (vec.length > 0) {
        map.set(pid, vec);
      }
    }
  } catch (err: unknown) {
    console.error("[AI] getPhotoVectors failed:", getErrorMessage(err));
  }
  return map;
}

export async function ensureVectorIndex(force = false): Promise<boolean> {
  if (!photoTable) {
    return false;
  }

  try {
    const indices = await photoTable.listIndices();
    const hasIndex = indices.some(
      (idx) => idx.columns.includes("vector") || idx.name === "vector_idx"
    );

    if (hasIndex && !force) {
      return true;
    }

    const rowCount = await photoTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] Index not needed: ${rowCount} < ${MIN_VECTORS_FOR_INDEX} threshold`
      );
      return true;
    }

    const { Index: LIdx } = await import("@lancedb/lancedb");
    console.log(
      `[AI] ${force ? "Rebuilding" : "Creating"} vector index on ${rowCount} rows...`
    );
    // Crash-safety: mark dirty before the potentially-long index build,
    // so unclean shutdown during ANY index creation is detected on next startup.
    markIndexDirty();
    await photoTable.createIndex("vector", {
      config: LIdx.ivfPq({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
        distanceType: "cosine",
      }),
    });
    console.log("[AI] Vector index ready");
    markIndexReady();
    return true;
  } catch (err: unknown) {
    console.error("[AI] Index creation failed:", getErrorMessage(err));
    return false;
  }
}

export function isVectorDBInitialized(): boolean {
  return isVectorDBReady && vectordb !== null && photoTable !== null;
}

/**
 * 对已初始化的向量数据库进行快速健康检查。
 * 在不触发重量操作的前提下验证底层数据文件可读性。
 * 返回 { healthy: true } 表示通过；{ healthy: false, reason } 表示需要自动修复。
 */
export async function validateVectorDB(): Promise<{
  healthy: boolean;
  reason?: string;
}> {
  // 直接检查 photoTable 实例是否存在（不依赖 isVectorDBReady，
  // 因为本函数可能在 initVectorDB 还未标记 ready 时被调用）。
  if (!photoTable) {
    return { healthy: false, reason: "vector DB not initialized" };
  }

  // Phase 1: countRows — 验证数据文件可读
  let rowCount = 0;
  try {
    rowCount = await photoTable.countRows();
  } catch (err: unknown) {
    return {
      healthy: false,
      reason: `countRows failed (data file corruption): ${getErrorMessage(err)}`,
    };
  }

  // Phase 2: query 1 row — 验证向量列结构可序列化
  if (rowCount > 0) {
    try {
      await photoTable.query().limit(1).toArray();
    } catch (err: unknown) {
      return {
        healthy: false,
        reason: `query failed (vector data corruption): ${getErrorMessage(err)}`,
      };
    }
  }

  // Phase 3: listIndices — 验证索引元数据可读
  try {
    await photoTable.listIndices();
  } catch (err: unknown) {
    return {
      healthy: false,
      reason: `listIndices failed (IVF_PQ index corruption): ${getErrorMessage(err)}`,
    };
  }

  return { healthy: true };
}

/**
 * 将所有照片的 isAiProcessed 标志重置为 false。
 * 在向量数据库重建后调用，使系统重新索引导入所有图片。
 */
export function resetAllAiProcessedFlags(): number {
  try {
    const db = getDatabase();
    const result = db
      .update(photos)
      .set({ isAiProcessed: false })
      .where(sql`${photos.deletedAt} IS NULL`)
      .run();
    console.log(
      `[AI] Reset isAiProcessed flags: ${result.changes} photos marked for re-index`
    );
    return result.changes;
  } catch (err: unknown) {
    console.error(
      "[AI] Failed to reset isAiProcessed flags:",
      getErrorMessage(err)
    );
    return 0;
  }
}

/**
 * 重建整个向量数据库：关闭连接 → 删除磁盘文件 → 重新初始化空表。
 * 用于修复 LanceDB 索引损坏导致的搜索闪退问题。
 * 调用方需要额外重置 isAiProcessed 标志并重新触发索引。
 *
 * 注意：Windows 上 LanceDB 可能持有 mmap 文件句柄，close() 后不会立即释放。
 * 优先使用 LanceDB 的 dropTable API 清理，失败时用 rename 绕过文件锁。
 */
export function rebuildVectorDB(): Promise<{
  success: boolean;
  error?: string;
}> {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Rebuild keeps filesystem and LanceDB recovery ordering atomic.
  return withVectorDbOperation(async () => {
    vectorDbGeneration++;
    vectorDbInitPromise = null;
    setIsVectorDBReady(false);
    setPhotoTable(null);
    try {
      // 1. 优先通过 LanceDB API 清理（正确处理内部文件锁）
      if (vectordb) {
        const tableNames = await vectordb.tableNames();
        if (tableNames.includes("photo_embeddings")) {
          try {
            await vectordb.dropTable("photo_embeddings");
            console.log("[AI] rebuildVectorDB: dropped via LanceDB API");
          } catch (dropErr: unknown) {
            console.warn(
              "[AI] rebuildVectorDB: dropTable failed, will use filesystem fallback:",
              getErrorMessage(dropErr)
            );
          }
        }
      }

      // 2. 关闭连接（先清理维护定时器，避免在已关闭连接上执行维护操作）
      clearVectorMaintenance();
      if (vectordb) {
        try {
          await vectordb.close();
        } catch (err: unknown) {
          console.warn(
            "[AI] rebuildVectorDB: close failed:",
            getErrorMessage(err)
          );
        }
        setVectordb(null);
        setPhotoTable(null);
        setIsVectorDBReady(false);
      }

      // 3. 清理残留文件（处理 dropTable 失败或 close 未释放句柄的情况）
      const vectorPath = path.join(getDataPath(), "vectors");
      if (fs.existsSync(vectorPath)) {
        try {
          await fs.promises.rm(vectorPath, { recursive: true, force: true });
          console.log(`[AI] rebuildVectorDB: removed ${vectorPath}`);
        } catch (rmErr: unknown) {
          // Windows mmap 锁：重命名绕过，下次启动时清理
          const code = getErrorCode(rmErr);
          if (code === "EPERM" || code === "EBUSY") {
            const bakPath = path.join(
              getDataPath(),
              `vectors.bak.${Date.now()}`
            );
            await fs.promises.rename(vectorPath, bakPath);
            console.log(
              `[AI] rebuildVectorDB: renamed to ${bakPath} (mmap lock bypass)`
            );
            // 异步清理备份（延迟 10s 等系统释放句柄）
            setTimeout(() => {
              try {
                fs.promises.rm(bakPath, { recursive: true, force: true });
              } catch {
                // 残留文件不阻塞，下次 initVectorDB 时会跳过（目录名已不同）
              }
            }, 10_000);
          } else {
            throw rmErr;
          }
        }
      }

      // 4. 重新初始化
      await initVectorDB();

      return { success: true };
    } catch (err: unknown) {
      const message = getErrorMessage(err);
      console.error("[AI] rebuildVectorDB failed:", message);
      return { success: false, error: message };
    }
  });
}

/**
 * 清理上一次重建遗留的 .bak 目录（在 initVectorDB 之前调用）。
 * 这些目录是 rebuildVectorDB 在 Windows 上因 mmap 锁无法删除时残留的。
 */
export async function cleanupStaleBackups(): Promise<void> {
  const dataPath = getDataPath();
  try {
    const entries = await fs.promises.readdir(dataPath);
    for (const entry of entries) {
      if (entry.startsWith("vectors.bak.")) {
        const fullPath = path.join(dataPath, entry);
        try {
          await fs.promises.rm(fullPath, { recursive: true, force: true });
          console.log(`[AI] Cleaned up stale backup: ${entry}`);
        } catch {
          // best-effort, will try again next startup
        }
      }
    }
  } catch {
    // best-effort
  }
}

export function closeVectorDB(): Promise<void> {
  return withVectorDbOperation(async () => {
    vectorDbGeneration++;
    vectorDbInitPromise = null;
    clearVectorMaintenance();
    const currentDb = vectordb;
    setVectordb(null);
    setPhotoTable(null);
    setIsVectorDBReady(false);
    if (currentDb) {
      try {
        diagLog("closeVectorDB: calling vectordb.close()");
        await currentDb.close();
        diagLog("closeVectorDB: OK");
        markIndexReady();
      } catch (err: unknown) {
        diagLog(`closeVectorDB: ERROR ${getErrorMessage(err)}`);
      }
    } else {
      diagLog("closeVectorDB: vectordb already null, skip");
    }
  });
}

// ── Crash-safety marker ─────────────────────────────────────────────────
// Writes a .index_ready marker after clean shutdown / index completion.
// If the marker is missing on startup, the previous session did not exit
// cleanly — auto-rebuild to avoid corruption from partial index builds.

function indexReadyPath(): string {
  return path.join(getDataPath(), "vectors", ".index_ready");
}

function markIndexReady(): void {
  try {
    const markerPath = indexReadyPath();
    const dir = path.dirname(markerPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(markerPath, Date.now().toString(), "utf-8");
  } catch {
    // best-effort
  }
}

function markIndexDirty(): void {
  try {
    const markerPath = indexReadyPath();
    if (fs.existsSync(markerPath)) {
      fs.unlinkSync(markerPath);
    }
  } catch {
    // best-effort
  }
}

function isIndexCleanShutdown(): boolean {
  try {
    return fs.existsSync(indexReadyPath());
  } catch {
    return false;
  }
}

// ── 颜色向量表（Color Vector Table） ──────────────────────────────
// 替代 SQLite closest_color_dist JS UDF 全表扫描，将主导色 [R,G,B] 存入
// LanceDB 3D 向量表，利用 IVF_PQ ANN 将 O(N) 转化为 O(log N)。

const COLOR_TABLE_NAME = "color_embeddings";
const COLOR_VECTOR_DIM = 3;

async function initColorTable(db: LanceConnection): Promise<void> {
  try {
    const tableNames = await db.tableNames();

    if (tableNames.includes(COLOR_TABLE_NAME)) {
      const table = await db.openTable(COLOR_TABLE_NAME);
      setColorTable(table);
      console.log("[AI] Opened existing color_embeddings table");
      return;
    }

    // 创建新表
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(COLOR_VECTOR_DIM, new Field("item", new Float32()))
      ),
    ]);

    const table = await db.createEmptyTable(COLOR_TABLE_NAME, schema);
    setColorTable(table);
    console.log(
      "[AI] Created color_embeddings table (FixedSizeList<Float32>[3])"
    );
  } catch (err: unknown) {
    console.warn("[AI] Color table init skipped:", getErrorMessage(err));
    // 非关键路径：颜色搜索降级为 SQLite UDF
  }
}

/** 写入或更新照片的主导颜色向量 */
export async function upsertColorVector(
  photoId: number,
  r: number,
  g: number,
  b: number
): Promise<void> {
  if (!colorTable) {
    throw new Error("color vector table is not initialized");
  }
  try {
    // 删除旧记录（如果存在）
    await colorTable.delete(`photo_id = ${photoId}`);
    // 写入新记录
    await colorTable.add([{ photo_id: photoId, vector: [r, g, b] }]);
  } catch (err: unknown) {
    console.error(
      `[AI] Upsert color vector failed for photo ${photoId}:`,
      getErrorMessage(err)
    );
    throw err;
  }
}

/** 批量写入颜色向量 */
export async function upsertColorVectors(
  entries: Array<{ photoId: number; r: number; g: number; b: number }>
): Promise<void> {
  if (!colorTable || entries.length === 0) {
    if (entries.length > 0 && !colorTable) {
      throw new Error("color vector table is not initialized");
    }
    return;
  }
  try {
    // 批量删除旧记录
    const ids = entries.map((e) => e.photoId);
    await colorTable.delete(`photo_id IN (${ids.join(",")})`);
    // 批量写入
    const rows = entries.map((e) => ({
      photo_id: e.photoId,
      vector: [e.r, e.g, e.b],
    }));
    await colorTable.add(rows);
    console.log(`[AI] Upserted ${entries.length} color vectors`);
  } catch (err: unknown) {
    console.error(
      "[AI] Batch upsert color vectors failed:",
      getErrorMessage(err)
    );
    throw err;
  }
}

/** 颜色向量 ANN 搜索。colorTable 不可用时返回 null，调用方降级 SQLite UDF。 */
export async function searchByColorVector(
  r: number,
  g: number,
  b: number,
  limit: number
): Promise<Array<{ photoId: number; distanceSquared: number }> | null> {
  if (!colorTable) {
    return null;
  }
  try {
    const targetVector = Array.from(
      { length: COLOR_VECTOR_DIM },
      (_, i) => [r, g, b][i]
    );
    const rawResults = (await colorTable
      .vectorSearch(targetVector)
      .distanceType("l2")
      .limit(limit)
      .toArray()) as Record<string, unknown>[];

    return rawResults.map((row) => ({
      photoId: row.photo_id as number,
      // LanceDB L2 exposes squared Euclidean distance, the same unit used by
      // SQLite closest_color_dist.
      distanceSquared: row._distance as number,
    }));
  } catch (err: unknown) {
    console.error("[AI] Color vector search failed:", getErrorMessage(err));
    return null;
  }
}

/** 删除指定照片的颜色向量 */
export async function deleteColorVectors(photoIds: number[]): Promise<void> {
  if (!colorTable || photoIds.length === 0) {
    return;
  }
  try {
    await colorTable.delete(`photo_id IN (${photoIds.join(",")})`);
  } catch (err: unknown) {
    console.error("[AI] Delete color vectors failed:", getErrorMessage(err));
  }
}

// best-effort sync write for native crash diagnostics
function diagLog(msg: string) {
  try {
    const dir = path.join(
      process.env.APPDATA || "/tmp",
      "AI Image Manager",
      "logs"
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

// ── 颜色向量回填 ─────────────────────────────────────────────────────
// 将已有 dominant_colors 但 LanceDB 中无颜色向量的照片批量回填。
// 首次启动时自动运行，后续跳过（通过 app_settings 标记）。
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Backfill coordinates marker checks, JSON normalization, batch writes, and yielding without changing startup lifecycle.
export async function backfillColorVectors(): Promise<{
  total: number;
  backfilled: number;
}> {
  if (!colorTable) {
    console.log("[AI] Color backfill skipped: colorTable not initialized");
    return { total: 0, backfilled: 0 };
  }

  const db = getDatabase();

  // 检查是否已回填
  const marker = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "color_vectors_backfilled"))
    .get();

  if (marker?.value === "true") {
    console.log("[AI] Color backfill: already completed (marker set)");
    return { total: 0, backfilled: 0 };
  }

  // 只统计需要处理的行，并按批读取，避免一次性把旧数据全部载入内存。
  const needsBackfill = sql`
    ${photos.deletedAt} IS NULL AND
    ${photos.dominantColors} IS NOT NULL AND
    ${photos.colorBucket} IS NULL
  `;
  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(photos)
    .where(needsBackfill)
    .get();
  const total = Number(totalRow?.count ?? 0);
  if (total === 0) {
    console.log("[AI] Color backfill: 0 photos need backfill (all up to date)");
    try {
      db.run(
        sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
      );
    } catch (err: unknown) {
      console.error(
        "[AI] Color backfill completion marker failed:",
        getErrorMessage(err)
      );
    }
    return { total: 0, backfilled: 0 };
  }

  const BATCH = 100;
  let backfilled = 0;
  let failed = 0;

  for (let i = 0; i < total; i += BATCH) {
    const batch = db
      .select({
        id: photos.id,
        dominantColors: photos.dominantColors,
      })
      .from(photos)
      .where(needsBackfill)
      .limit(BATCH)
      .offset(i)
      .all();
    const entries: Array<{ photoId: number; r: number; g: number; b: number }> =
      [];

    for (const row of batch) {
      try {
        if (!row.dominantColors) {
          failed++;
          continue;
        }
        const palette = JSON.parse(row.dominantColors) as Array<{
          r: number;
          g: number;
          b: number;
          weight: number;
        }>;
        const color = palette[0];
        if (!color) {
          failed++;
          continue;
        }
        const hasValidChannels = [color.r, color.g, color.b].every(
          (channel) =>
            typeof channel === "number" &&
            Number.isFinite(channel) &&
            channel >= 0 &&
            channel <= 255
        );
        if (!hasValidChannels) {
          failed++;
          continue;
        }
        entries.push({ photoId: row.id, r: color.r, g: color.g, b: color.b });
      } catch {
        failed++;
      }
    }

    if (entries.length > 0) {
      try {
        await upsertColorVectors(entries);
        backfilled += entries.length;
      } catch (err: unknown) {
        failed += entries.length;
        console.error(
          "[AI] Color backfill batch failed:",
          getErrorMessage(err)
        );
      }
    }

    // 避免长时间阻塞
    await new Promise((r) => setTimeout(r, 0));
  }

  // 只有每一行都成功写入且完成标记本身写入成功时，才宣布回填完成。
  if (failed === 0 && backfilled === total) {
    try {
      db.run(
        sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
      );
    } catch (err: unknown) {
      console.error(
        "[AI] Color backfill completion marker failed:",
        getErrorMessage(err)
      );
    }
  }

  console.log(
    `[AI] Color vector backfill: ${backfilled}/${total}${failed > 0 ? ` (${failed} failed)` : ""}`
  );
  return { total, backfilled };
}
