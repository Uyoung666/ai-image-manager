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

      // Ensure vector index exists
      const indices = await table.listIndices();
      const hasVectorIndex = indices.some(
        (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
      );
      if (hasVectorIndex) {
        console.log("[AI] Vector index already exists");
      } else {
        const rowCount = await table.countRows();
        if (rowCount >= MIN_VECTORS_FOR_INDEX) {
          console.log(`[AI] Creating vector index on ${rowCount} rows...`);
          await table.createIndex("vector", {
            config: lancedb.Index.ivfPq({
              numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
              distanceType: "cosine",
            }),
          });
          console.log("[AI] Vector index created");
        } else {
          console.log(
            `[AI] Skipping index: ${rowCount} vectors < ${MIN_VECTORS_FOR_INDEX} threshold`
          );
        }
      }

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

export async function deletePhotoVectors(photoIds: number[]): Promise<void> {
  if (!(isVectorDBReady && photoTable) || photoIds.length === 0) {
    return;
  }
  try {
    const idList = photoIds.join(", ");
    await photoTable.delete(`photo_id IN (${idList})`);
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
    const idList = photoIds.join(", ");
    const rows = (await photoTable
      .query()
      .where(`photo_id IN (${idList})`)
      .toArray()) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const pid = row.photo_id as number;
      const vec = row.vector as number[];
      if (pid != null && vec?.length > 0) {
        map.set(pid, vec);
      }
    }
  } catch (err: any) {
    console.error("[AI] getPhotoVectors failed:", err?.message);
  }
  return map;
}

export function isVectorDBInitialized(): boolean {
  return isVectorDBReady && vectordb !== null && photoTable !== null;
}
