import path from "node:path";
import { app } from "electron";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";

let vectordb: any = null;
let photoTable: any = null;
let embeddingModel: {
  embedImage: (imagePath: string) => Promise<number[]>;
  embedText: (text: string) => Promise<number[]>;
} | null = null;

const MODEL_CACHE_KEY = "clip_model_loaded";
let isModelLoaded = false;

interface EmbedProgress {
  processed: number;
  total: number;
  phase: "loading" | "embedding" | "complete";
  currentFile: string;
}

type EmbedProgressCallback = (progress: EmbedProgress) => void;
let isEmbedding = false;

export async function initVectorDB(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const vectorPath = path.join(userDataPath, "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  // Dynamic import to avoid static native module loading at startup
  const lancedb = await import("@lancedb/lancedb");
  vectordb = await lancedb.connect(vectorPath);

  // Create or open photo embeddings table
  const tableNames = await vectordb.tableNames();
  if (!tableNames.includes("photo_embeddings")) {
    photoTable = await vectordb.createTable("photo_embeddings", [
      { photo_id: 0, vector: Array(512).fill(0), created_at: Date.now() },
    ]);
    console.log("[AI] Created photo_embeddings table");
  } else {
    photoTable = await vectordb.openTable("photo_embeddings");
    console.log("[AI] Opened existing photo_embeddings table");
  }
}

async function loadModel(): Promise<void> {
  if (isModelLoaded && embeddingModel) return;

  const { pipeline, env } = await import("@xenova/transformers");
  env.localModelPath = path.join(app.getPath("userData"), "models");
  env.allowRemoteModels = true;

  const extractor = await pipeline("feature-extraction", "Xenova/clip-vit-base-patch32", {
    quantized: true,
  });

  embeddingModel = {
    embedImage: async (imagePath: string) => {
      const result = await extractor(imagePath, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },
    embedText: async (text: string) => {
      const result = await extractor(text, { pooling: "mean", normalize: true });
      return Array.from(result.data as Float32Array);
    },
  };

  isModelLoaded = true;
  console.log("[AI] CLIP model loaded");
}

export function isAiModelLoaded(): boolean {
  return isModelLoaded;
}

export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  const db = getDatabase();
  isEmbedding = true;

  onProgress?.({ processed: 0, total: 0, phase: "loading", currentFile: "" });
  await loadModel();
  await initVectorDB();

  if (!embeddingModel || !photoTable) {
    throw new Error("AI embedding model or vector DB not initialized");
  }

  // Find photos without AI processing
  const unprocessed = db.select({
    id: photos.id,
    path: photos.path,
  }).from(photos)
    .where(eq(photos.isAiProcessed, false))
    .all();

  const total = unprocessed.length;
  let processed = 0;

  for (const photo of unprocessed) {
    if (!isEmbedding) break;

    onProgress?.({ processed, total, phase: "embedding", currentFile: path.basename(photo.path) });

    try {
      const vector = await embeddingModel.embedImage(photo.path);

      // Store in LanceDB
      await photoTable.add([{
        photo_id: photo.id,
        vector,
        created_at: Date.now(),
      }]);

      // Update SQLite
      db.update(photos)
        .set({ isAiProcessed: true, vectorId: `vec_${photo.id}` })
        .where(eq(photos.id, photo.id))
        .run();

      processed++;
    } catch (error) {
      console.error(`[AI] Error embedding photo ${photo.id}:`, error);
    }
  }

  onProgress?.({ processed, total, phase: "complete", currentFile: "" });
  isEmbedding = false;
  return processed;
}

export async function searchByText(
  query: string,
  limit: number = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  await loadModel();
  await initVectorDB();

  if (!embeddingModel || !photoTable) {
    throw new Error("AI embedding model or vector DB not initialized");
  }

  const queryVector = await embeddingModel.embedText(query);
  const results = await photoTable.search(queryVector).limit(limit).execute();

  return results.map((r: Record<string, unknown>) => ({
    photoId: r.photo_id as number,
    similarity: r._distance as number,
  }));
}

export async function searchByImage(
  imagePath: string,
  limit: number = 20
): Promise<Array<{ photoId: number; similarity: number }>> {
  await loadModel();
  await initVectorDB();

  if (!embeddingModel || !photoTable) {
    throw new Error("AI embedding model or vector DB not initialized");
  }

  const queryVector = await embeddingModel.embedImage(imagePath);
  const results = await photoTable.search(queryVector).limit(limit).execute();

  return results.map((r: Record<string, unknown>) => ({
    photoId: r.photo_id as number,
    similarity: r._distance as number,
  }));
}

export function stopEmbedding(): void {
  isEmbedding = false;
}

export function getEmbeddingProgress(): { isActive: boolean; isModelLoaded: boolean } {
  return { isActive: isEmbedding, isModelLoaded };
}
