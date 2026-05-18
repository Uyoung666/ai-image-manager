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
import { getDataPath } from "@/utils/data-path";
import { MIN_VECTORS_FOR_INDEX } from "./constants";
import {
  isVectorDBReady,
  photoTable,
  setIsVectorDBReady,
  setPhotoTable,
  setVectordb,
  vectordb,
} from "./state";

export async function initVectorDB(): Promise<void> {
  if (isVectorDBReady && vectordb && photoTable) {
    return;
  }

  const vectorPath = path.join(getDataPath(), "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  const lancedb = await import("@lancedb/lancedb");

  const db = await lancedb.connect(vectorPath);
  setVectordb(db);
  const VECTOR_DIM = 512;

  const tableNames = await db.tableNames();

  if (tableNames.includes("photo_embeddings")) {
    const table = await db.openTable("photo_embeddings");
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
      await ensureVectorIndex();
      setIsVectorDBReady(true);
      return;
    }
    console.log(
      "[AI] Schema mismatch — vector column not FixedSizeList<512>. Recreating..."
    );
    await db.dropTable("photo_embeddings");
    setPhotoTable(null as any);
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

  setIsVectorDBReady(true);
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

/** 清理孤儿向量：删除 photo_id 在 SQLite 中不存在或已软删除条目对应的向量 */
export async function cleanupOrphanVectors(
  softDeletedIds: number[]
): Promise<number> {
  if (!(isVectorDBReady && photoTable)) {
    return 0;
  }
  let deleted = 0;
  try {
    const allRows = (await photoTable.query().toArray()) as Array<
      Record<string, unknown>
    >;
    const orphanIds = new Set(softDeletedIds);
    const toDelete: number[] = [];
    for (const row of allRows) {
      const pid = row.photo_id as number;
      if (pid != null && orphanIds.has(pid)) {
        toDelete.push(pid);
      }
    }
    if (toDelete.length > 0) {
      await photoTable.delete(buildPhotoIdFilter(toDelete));
      deleted = toDelete.length;
      console.log(
        `[AI] Cleaned up ${deleted} orphan vectors (soft-deleted photos)`
      );
    }
  } catch (err: any) {
    console.error("[AI] Orphan vector cleanup failed:", err?.message);
  }
  return deleted;
}

export async function deletePhotoVectors(photoIds: number[]): Promise<void> {
  if (!(isVectorDBReady && photoTable) || photoIds.length === 0) {
    return;
  }
  try {
    await photoTable.delete(buildPhotoIdFilter(photoIds));
    console.log(`[AI] Deleted ${photoIds.length} vectors from LanceDB`);
  } catch (err: any) {
    console.error("[AI] Failed to delete vectors:", err?.message);
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
    const rows = (await photoTable.query().where(filter).toArray()) as Array<
      Record<string, unknown>
    >;
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
    await photoTable.createIndex("vector", {
      config: LIdx.ivfPq({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
        distanceType: "cosine",
      }),
    });
    console.log("[AI] Vector index ready");
    return true;
  } catch (err: any) {
    console.error("[AI] Index creation failed:", err?.message);
    return false;
  }
}

export function isVectorDBInitialized(): boolean {
  return isVectorDBReady && vectordb !== null && photoTable !== null;
}

export async function closeVectorDB(): Promise<void> {
  if (vectordb) {
    try {
      diagLog("closeVectorDB: calling vectordb.close()");
      await vectordb.close();
      diagLog("closeVectorDB: OK");
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
  } catch { /* best-effort */ }
}
