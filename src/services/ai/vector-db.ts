import fs from "node:fs";
import path from "node:path";
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
import {
  isVectorDBReady,
  photoTable,
  colorTable,
  setIsVectorDBReady,
  setPhotoTable,
  setColorTable,
  setVectordb,
  setWasAutoRepaired,
  vectordb,
} from "./state";
import { planVectorReconciliation } from "./vector-reconciliation";

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
      if (typeof (photoTable as any).compactFiles === "function") {
        await (photoTable as any).compactFiles();
        console.log("[AI] Maintenance: compactFiles OK");
      }
    } catch (err: any) {
      console.warn("[AI] Maintenance: compactFiles skipped:", err?.message);
    }

    // Phase 2: cleanup old versions — removes stale version history
    try {
      if (typeof (photoTable as any).cleanupOldVersions === "function") {
        await (photoTable as any).cleanupOldVersions();
        console.log("[AI] Maintenance: cleanupOldVersions OK");
      }
    } catch (err: any) {
      console.warn(
        "[AI] Maintenance: cleanupOldVersions skipped:",
        err?.message
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

export function initVectorDB(): Promise<void> {
  if (isVectorDBReady && vectordb && photoTable) {
    return Promise.resolve();
  }

  if (!vectorDbInitPromise) {
    vectorDbInitPromise = initializeVectorDB().finally(() => {
      vectorDbInitPromise = null;
    });
  }

  return vectorDbInitPromise;
}

async function initializeVectorDB(): Promise<void> {
  // 清理上次重建残留的 .bak 目录
  await cleanupStaleBackups();

  const vectorPath = path.join(getDataPath(), "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  const lancedb = await import("@lancedb/lancedb");

  let db: any;
  try {
    db = await lancedb.connect(vectorPath);
  } catch (err: any) {
    console.error("[AI] LanceDB connect failed:", err?.message);
    throw new Error(`Failed to connect to vector database: ${err?.message}`);
  }
  setVectordb(db);
  const VECTOR_DIM = 512;

  const tableNames = await db.tableNames();

  if (tableNames.includes("photo_embeddings")) {
    let table: any;
    try {
      table = await db.openTable("photo_embeddings");
    } catch (err: any) {
      console.error("[AI] LanceDB openTable failed:", err?.message);
      // Table exists but can't be opened — likely corrupted. Drop and recreate.
      try {
        await db.dropTable("photo_embeddings");
      } catch {
        // best-effort cleanup
      }
      setPhotoTable(null as any);
      // Fall through to create fresh table below
    }

    if (table) {
      setPhotoTable(table);

      // Validate schema: vector column must be FixedSizeList<Float32>[512]
      const schema = await table.schema();
      const vectorField = schema.fields.find((f: any) => f.name === "vector");
      const schemaValid =
        vectorField &&
        vectorField.type !== null &&
        typeof vectorField.type === "object" &&
        (vectorField.type as any).listSize === VECTOR_DIM;

      if (schemaValid) {
        console.log("[AI] Opened existing photo_embeddings table (schema OK)");

        // Run deep validation BEFORE checking the crash-safety marker.
        // If the data is actually healthy (e.g. dev server restart where
        // closeVectorDB never ran), we should NOT drop it — just write the
        // marker and proceed. Only rebuild if validation genuinely fails.
        const validation = await validateVectorDB();

        if (validation.healthy) {
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
            console.warn("[AI] Color backfill failed:", err?.message)
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
        "[AI] Schema mismatch — vector column not FixedSizeList<512>. Recreating..."
      );
      await db.dropTable("photo_embeddings");
      setPhotoTable(null as any);
    }
  }

  // Create fresh table with explicit FixedSizeList<Float32>[512] schema
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field(
      "vector",
      new FixedSizeList(VECTOR_DIM, new Field("item", new Float32()))
    ),
    new Field("created_at", new Float64()),
  ]);

  const newTable = await db.createEmptyTable("photo_embeddings", schema);
  setPhotoTable(newTable);
  console.log(
    "[AI] Created photo_embeddings table (explicit FixedSizeList<Float32>[512] schema)"
  );
  markIndexDirty(); // New table has no data — will be set to ready after index build completes

  // ── 初始化颜色向量表（3D RGB） ───────────────────────────────────
  await initColorTable(db);

  // 后台回填已有的 dominant_colors 到 LanceDB 颜色表（不阻塞启动）
  backfillColorVectors().catch((err) =>
    console.warn("[AI] Color backfill failed:", err?.message)
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
      const remainingRows = await photoTable.countRows();
      deleted = Math.max(0, allRows.length - remainingRows);
      console.log(
        `[AI] Vector reconciliation: removed ${deleted} rows (${orphanIds.length} orphan photo IDs, ${duplicateIds.length} duplicate photo IDs re-queued)`
      );
    }
  } catch (err: any) {
    console.error("[AI] Orphan vector cleanup failed:", err?.message);
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
  } catch (err: any) {
    console.error("[AI] Failed to delete vectors:", err?.message);
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
      } else if (typeof (rawVec as any).toArray === "function") {
        vec = Array.from((rawVec as any).toArray());
      } else if (ArrayBuffer.isView(rawVec)) {
        vec = Array.from(rawVec as Float32Array);
      } else if (typeof (rawVec as any)[Symbol.iterator] === "function") {
        vec = Array.from(rawVec as Iterable<number>);
      } else {
        continue;
      }

      if (vec.length > 0) {
        map.set(pid, vec);
      }
    }
  } catch (err: any) {
    console.error("[AI] getPhotoVectors failed:", err?.message);
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
      (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
    );

    if (hasIndex && !force) {
      return true;
    }

    const rowCount = await photoTable.countRows();
    if (rowCount < MIN_VECTORS_FOR_INDEX) {
      console.log(
        `[AI] Index not needed: ${rowCount} < ${MIN_VECTORS_FOR_INDEX} threshold`
      );
      return false;
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
  } catch (err: any) {
    console.error("[AI] Index creation failed:", err?.message);
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
  } catch (err: any) {
    return {
      healthy: false,
      reason: `countRows failed (data file corruption): ${err?.message ?? "unknown"}`,
    };
  }

  // Phase 2: query 1 row — 验证向量列结构可序列化
  if (rowCount > 0) {
    try {
      await photoTable.query().limit(1).toArray();
    } catch (err: any) {
      return {
        healthy: false,
        reason: `query failed (vector data corruption): ${err?.message ?? "unknown"}`,
      };
    }
  }

  // Phase 3: listIndices — 验证索引元数据可读
  try {
    await photoTable.listIndices();
  } catch (err: any) {
    return {
      healthy: false,
      reason: `listIndices failed (IVF_PQ index corruption): ${err?.message ?? "unknown"}`,
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
  } catch (err: any) {
    console.error("[AI] Failed to reset isAiProcessed flags:", err?.message);
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
export async function rebuildVectorDB(): Promise<{
  success: boolean;
  error?: string;
}> {
  try {
    // 1. 优先通过 LanceDB API 清理（正确处理内部文件锁）
    if (vectordb) {
      const tableNames = await vectordb.tableNames();
      if (tableNames.includes("photo_embeddings")) {
        try {
          await vectordb.dropTable("photo_embeddings");
          console.log("[AI] rebuildVectorDB: dropped via LanceDB API");
        } catch (dropErr: any) {
          console.warn(
            "[AI] rebuildVectorDB: dropTable failed, will use filesystem fallback:",
            dropErr?.message
          );
        }
      }
    }

    // 2. 关闭连接（先清理维护定时器，避免在已关闭连接上执行维护操作）
    clearVectorMaintenance();
    if (vectordb) {
      try {
        await vectordb.close();
      } catch (err: any) {
        console.warn("[AI] rebuildVectorDB: close failed:", err?.message);
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
      } catch (rmErr: any) {
        // Windows mmap 锁：重命名绕过，下次启动时清理
        if (rmErr.code === "EPERM" || rmErr.code === "EBUSY") {
          const bakPath = path.join(getDataPath(), `vectors.bak.${Date.now()}`);
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
  } catch (err: any) {
    const message = err?.message ?? String(err);
    console.error("[AI] rebuildVectorDB failed:", message);
    return { success: false, error: message };
  }
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

export async function closeVectorDB(): Promise<void> {
  clearVectorMaintenance();
  if (vectordb) {
    try {
      diagLog("closeVectorDB: calling vectordb.close()");
      await vectordb.close();
      diagLog("closeVectorDB: OK");
      markIndexReady();
    } catch (err: any) {
      diagLog(`closeVectorDB: ERROR ${err?.message ?? err}`);
    }
    setVectordb(null);
    setPhotoTable(null);
    setIsVectorDBReady(false);
  } else {
    diagLog("closeVectorDB: vectordb already null, skip");
  }
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

async function initColorTable(db: any): Promise<void> {
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
  } catch (err: any) {
    console.warn("[AI] Color table init skipped:", err?.message);
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
    return;
  }
  try {
    // 删除旧记录（如果存在）
    await colorTable.delete(`photo_id = ${photoId}`);
    // 写入新记录
    await colorTable.add([{ photo_id: photoId, vector: [r, g, b] }]);
  } catch (err: any) {
    console.error(
      `[AI] Upsert color vector failed for photo ${photoId}:`,
      err?.message
    );
  }
}

/** 批量写入颜色向量 */
export async function upsertColorVectors(
  entries: Array<{ photoId: number; r: number; g: number; b: number }>
): Promise<void> {
  if (!colorTable || entries.length === 0) {
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
  } catch (err: any) {
    console.error("[AI] Batch upsert color vectors failed:", err?.message);
  }
}

/** 颜色向量 ANN 搜索。colorTable 不可用时返回 null，调用方降级 SQLite UDF。 */
export async function searchByColorVector(
  r: number,
  g: number,
  b: number,
  limit: number
): Promise<Array<{ photoId: number; distance: number }> | null> {
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
      distance: row._distance as number,
    }));
  } catch (err: any) {
    console.error("[AI] Color vector search failed:", err?.message);
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
  } catch (err: any) {
    console.error("[AI] Delete color vectors failed:", err?.message);
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

  // 查询有 dominant_colors 但无 color_bucket 的照片（未处理过的旧数据）
  const rows = db
    .select({
      id: photos.id,
      dominantColors: photos.dominantColors,
    })
    .from(photos)
    .where(
      sql`${photos.deletedAt} IS NULL AND ${photos.dominantColors} IS NOT NULL AND ${photos.colorBucket} IS NULL`
    )
    .all();

  const total = rows.length;
  if (total === 0) {
    console.log("[AI] Color backfill: 0 photos need backfill (all up to date)");
    // 标记完成，避免重复检查
    try {
      db.run(
        sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
      );
    } catch {
      /* best-effort */
    }
    return { total: 0, backfilled: 0 };
  }

  const BATCH = 100;
  let backfilled = 0;

  for (let i = 0; i < total; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const entries: Array<{ photoId: number; r: number; g: number; b: number }> =
      [];

    for (const row of batch) {
      try {
        const palette = JSON.parse(row.dominantColors!) as Array<{
          r: number;
          g: number;
          b: number;
          weight: number;
        }>;
        if (palette.length > 0) {
          const { r, g, b } = palette[0];
          entries.push({ photoId: row.id, r, g, b });
        }
      } catch {
        /* skip invalid JSON */
      }
    }

    if (entries.length > 0) {
      try {
        await upsertColorVectors(entries);
        backfilled += entries.length;
      } catch (err: any) {
        console.error(`[AI] Color backfill batch failed:`, err?.message);
      }
    }

    // 避免长时间阻塞
    await new Promise((r) => setTimeout(r, 0));
  }

  // 标记完成
  try {
    db.run(
      sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('color_vectors_backfilled', 'true', ${Date.now()})`
    );
  } catch {
    /* best-effort */
  }

  console.log(`[AI] Color vector backfill: ${backfilled}/${total}`);
  return { total, backfilled };
}
