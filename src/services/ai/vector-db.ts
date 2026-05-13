import path from "node:path";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
} from "apache-arrow";
import { app } from "electron";
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

  const userDataPath = app.getPath("userData");
  const vectorPath = path.join(userDataPath, "vectors");

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
    let logged = false;
    for (const row of rows) {
      const pid = row.photo_id as number;
      const rawVec = row.vector;
      if (pid == null || !rawVec) continue;

      if (!logged) {
        logged = true;
        console.log(`[AI] getPhotoVectors: rawVec type=${Object.prototype.toString.call(rawVec)}, constructor=${(rawVec as any)?.constructor?.name}, isArray=${Array.isArray(rawVec)}, isView=${ArrayBuffer.isView(rawVec)}, len=${(rawVec as any)?.length ?? (rawVec as any)?.size ?? 'N/A'}`);
      }

      // Normalize to number[] — handle Array, TypedArray, or any iterable with numeric indexing
      let vec: number[];
      if (Array.isArray(rawVec)) {
        vec = rawVec as number[];
      } else if (ArrayBuffer.isView(rawVec)) {
        vec = Array.from(rawVec as Float32Array);
      } else if (typeof (rawVec as any).toArray === "function") {
        vec = (rawVec as any).toArray();
      } else if (typeof (rawVec as any)[Symbol.iterator] === "function") {
        vec = Array.from(rawVec as Iterable<number>);
      } else if (typeof (rawVec as any).length === "number") {
        vec = Array.from({ length: (rawVec as any).length }, (_, i) => +(rawVec as any)[i]);
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
