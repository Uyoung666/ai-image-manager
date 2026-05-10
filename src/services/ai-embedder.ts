import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";

let vectordb: any = null;
let photoTable: any = null;
let embeddingModel: {
  embedImage: (imagePath: string) => Promise<number[]>;
  embedText: (text: string) => Promise<number[]>;
} | null = null;

const _MODEL_CACHE_KEY = "clip_model_loaded";
let isModelLoaded = false;

interface EmbedProgress {
  currentFile: string;
  error?: string;
  phase: "loading" | "embedding" | "complete" | "error";
  processed: number;
  total: number;
}

type EmbedProgressCallback = (progress: EmbedProgress) => void;
let isEmbedding = false;
let currentProgress: EmbedProgress = {
  processed: 0,
  total: 0,
  phase: "loading",
  currentFile: "",
};

export async function initVectorDB(): Promise<void> {
  const userDataPath = app.getPath("userData");
  const vectorPath = path.join(userDataPath, "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  // Dynamic import to avoid static native module loading at startup
  const lancedb = await import("@lancedb/lancedb");
  vectordb = await lancedb.connect(vectorPath);

  // Create or open photo embeddings table
  const tableNames = await vectordb.tableNames();
  if (tableNames.includes("photo_embeddings")) {
    photoTable = await vectordb.openTable("photo_embeddings");
    console.log("[AI] Opened existing photo_embeddings table");
  } else {
    photoTable = await vectordb.createTable("photo_embeddings", [
      { photo_id: 0, vector: new Array(512).fill(0), created_at: Date.now() },
    ]);
    console.log("[AI] Created photo_embeddings table");
  }
}

async function ensureLocalModel(): Promise<string> {
  const userDataPath = app.getPath("userData");
  const localModelPath = path.join(userDataPath, "models");

  // Check if model already exists in userData
  const modelMarker = path.join(
    localModelPath,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "model_quantized.onnx"
  );
  if (fs.existsSync(modelMarker)) {
    return localModelPath;
  }

  // Check bundled models in app resources (production)
  try {
    const resourcesPath = process.resourcesPath;
    const bundledModelPath = path.join(resourcesPath, "models");
    const bundledMarker = path.join(
      bundledModelPath,
      "Xenova",
      "clip-vit-base-patch32",
      "onnx",
      "model_quantized.onnx"
    );

    if (fs.existsSync(bundledMarker)) {
      console.log("[AI] Copying bundled models to userData...");
      await copyDir(bundledModelPath, localModelPath);
      console.log("[AI] Models copied from resources");
      return localModelPath;
    }
  } catch {
    // Not packaged (dev mode) or no bundled models
  }

  // Dev mode: check project root models/ directory
  if (!app.isPackaged) {
    const devCandidates = [
      path.join(process.cwd(), "models"),
      path.join(app.getAppPath(), "models"),
      path.join(app.getAppPath(), "..", "models"),
      path.join(app.getAppPath(), "..", "..", "models"),
    ];

    console.log("[AI] Dev mode - searching for models...");
    for (const candidate of devCandidates) {
      const marker = path.join(
        candidate,
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "model_quantized.onnx"
      );
      console.log(`[AI]   check: ${marker}`);
      if (fs.existsSync(marker)) {
        console.log(`[AI] Found model at: ${candidate}`);
        return candidate;
      }
    }
    console.log("[AI] Model not found in dev paths, will attempt download");
  }

  return localModelPath;
}

function copyDir(src: string, dest: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    fs.cp(src, dest, { recursive: true }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

let _localModelPath: string | null = null;

async function loadModel(): Promise<void> {
  if (isModelLoaded && embeddingModel) {
    return;
  }

  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

  // Force @xenova/transformers to use onnxruntime-web (WASM) instead of
  // onnxruntime-node (native). The native ONNX Runtime requires VC++ Redist
  // on Windows and will crash the process if missing. WASM is pure bytecode
  // with zero native dependencies — slower per inference but never crashes.
  const realReleaseName = process.release.name;
  try {
    (process.release as any).name = "browser";
  } catch {
    // Ignore if read-only
  }

  const {
    AutoProcessor,
    AutoTokenizer,
    CLIPModel,
    RawImage,
    env,
  } = await import("@xenova/transformers");

  // Restore immediately after the internal onnx.js module has initialized
  try {
    (process.release as any).name = realReleaseName;
  } catch {
    // Ignore
  }

  env.localModelPath = _localModelPath;

  // Support HuggingFace mirror via env var (e.g. hf-mirror.com for China)
  const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/";
    console.log(`[AI] Using HF mirror: ${mirror}`);
  }

  env.allowRemoteModels = true;
  console.log("[AI] Using ONNX Web (WASM) backend — no native dependencies");

  const modelId = "Xenova/clip-vit-base-patch32";
  const processor = await AutoProcessor.from_pretrained(modelId);
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await CLIPModel.from_pretrained(modelId, { quantized: true });

  embeddingModel = {
    embedImage: async (imagePath: string) => {
      const image = await RawImage.read(imagePath);
      const inputs = await processor(image);
      const { image_embeds } = await model(inputs);
      const vec = Array.from(image_embeds.data as Float32Array);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / (norm || 1));
    },
    embedText: async (text: string) => {
      const inputs = await tokenizer([text], { padding: true, truncation: true });
      const { text_embeds } = await model(inputs);
      const vec = Array.from(text_embeds.data as Float32Array);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      return vec.map((v) => v / (norm || 1));
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

  currentProgress = {
    processed: 0,
    total: 0,
    phase: "loading",
    currentFile: "",
  };
  onProgress?.(currentProgress);

  try {
    await loadModel();
  } catch (err: any) {
    isEmbedding = false;
    currentProgress = {
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      error: `模型加载失败: ${err?.message || "未知错误"}`,
    };
    onProgress?.(currentProgress);
    console.error("[AI] Model load error:", err);
    return 0;
  }

  await initVectorDB();

  if (!(embeddingModel && photoTable)) {
    isEmbedding = false;
    currentProgress = {
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      error: "向量数据库初始化失败",
    };
    onProgress?.(currentProgress);
    return 0;
  }

  // Find photos without AI processing
  const unprocessed = db
    .select({
      id: photos.id,
      path: photos.path,
    })
    .from(photos)
    .where(eq(photos.isAiProcessed, false))
    .all();

  const total = unprocessed.length;
  let processed = 0;

  console.log(`[AI] Starting embedding for ${total} photos`);

  for (const photo of unprocessed) {
    if (!isEmbedding) {
      console.log("[AI] Embedding stopped by user");
      break;
    }

    currentProgress = {
      processed,
      total,
      phase: "embedding",
      currentFile: path.basename(photo.path),
    };
    onProgress?.(currentProgress);

    try {
      // Validate the file exists and is accessible
      if (!fs.existsSync(photo.path)) {
        console.warn(`[AI] Skipping missing file: ${photo.path}`);
        // Mark as processed anyway so we don't retry forever
        db.update(photos)
          .set({ isAiProcessed: true })
          .where(eq(photos.id, photo.id))
          .run();
        continue;
      }

      // Small delay to avoid overwhelming the ONNX runtime
      if (processed > 0) {
        await new Promise((r) => setTimeout(r, 50));
      }

      console.log(`[AI] Embedding photo ${photo.id}: ${path.basename(photo.path)}`);
      const vector = await embeddingModel.embedImage(photo.path);

      // Store in LanceDB
      await photoTable.add([
        {
          photo_id: photo.id,
          vector,
          created_at: Date.now(),
        },
      ]);

      // Update SQLite
      db.update(photos)
        .set({ isAiProcessed: true, vectorId: `vec_${photo.id}` })
        .where(eq(photos.id, photo.id))
        .run();

      processed++;
      console.log(`[AI] Photo ${photo.id} embedded successfully (${processed}/${total})`);
    } catch (error: any) {
      console.error(
        `[AI] Error embedding photo ${photo.id}: ${error?.message || error}`,
        `\n  File: ${photo.path}`
      );
      // Continue to next photo - don't crash the whole batch
    }
  }

  currentProgress = { processed, total, phase: "complete", currentFile: "" };
  onProgress?.(currentProgress);
  isEmbedding = false;
  return processed;
}

export async function searchByText(
  query: string,
  limit = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] searchByText: model load failed:", err?.message);
    return [];
  }

  await initVectorDB();

  if (!(embeddingModel && photoTable)) {
    console.warn("[AI] searchByText: AI not initialized");
    return [];
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
  limit = 20
): Promise<Array<{ photoId: number; similarity: number }>> {
  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] searchByImage: model load failed:", err?.message);
    return [];
  }

  await initVectorDB();

  if (!(embeddingModel && photoTable)) {
    console.warn("[AI] searchByImage: AI not initialized");
    return [];
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

export function getEmbeddingProgress(): EmbedProgress & {
  isActive: boolean;
  isModelLoaded: boolean;
} {
  return {
    ...currentProgress,
    isActive: isEmbedding || currentProgress.phase === "loading",
    isModelLoaded,
  };
}
