import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";

// --- Module-level state ---

let vectordb: any = null;
let photoTable: any = null;
let isModelLoaded = false;
let isVectorDBReady = false;

// References to ONNX model internals for periodic disposal/reload
let _clipModel: any = null;
let _clipProcessor: any = null;
let _clipTokenizer: any = null;

let embeddingModel: {
  embedImage: (imagePath: string) => Promise<number[]>;
  embedText: (text: string) => Promise<number[]>;
} | null = null;

// --- Types ---

interface EmbedProgress {
  currentFile: string;
  error?: string;
  phase: "idle" | "loading" | "embedding" | "complete" | "error";
  processed: number;
  total: number;
}

type EmbedProgressCallback = (progress: EmbedProgress) => void;
let isEmbedding = false;
let currentProgress: EmbedProgress = {
  processed: 0,
  total: 0,
  phase: "idle",
  currentFile: "",
};

// --- Helpers ---

function disposeTensors(output: Record<string, any>): void {
  for (const value of Object.values(output)) {
    if (value && typeof value === "object" && typeof value.dispose === "function") {
      try { value.dispose(); } catch { /* best-effort */ }
    }
  }
}

/**
 * Completely destroy the ONNX inference session and free all WASM memory.
 * Called periodically during batch embedding to prevent WASM heap exhaustion.
 */
async function destroyModel(): Promise<void> {
  // Dispose the ONNX inference session (this is what holds WASM memory)
  if (_clipModel) {
    try {
      // PreTrainedModel.dispose() → OrtSession.release() → frees WASM heap
      if (typeof _clipModel.dispose === "function") {
        await _clipModel.dispose();
      }
    } catch (err) {
      console.warn("[AI] Error disposing model:", err);
    }
    _clipModel = null;
  }

  _clipProcessor = null;
  _clipTokenizer = null;
  embeddingModel = null;
  isModelLoaded = false;
}

// --- Vector DB ---

export async function initVectorDB(): Promise<void> {
  if (isVectorDBReady && vectordb && photoTable) {
    return;
  }

  const userDataPath = app.getPath("userData");
  const vectorPath = path.join(userDataPath, "vectors");

  console.log(`[AI] Initializing vector DB at: ${vectorPath}`);
  const lancedb = await import("@lancedb/lancedb");
  vectordb = await lancedb.connect(vectorPath);

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

  isVectorDBReady = true;
}

// --- Model loading ---

async function ensureLocalModel(): Promise<string> {
  const userDataPath = app.getPath("userData");
  const localModelPath = path.join(userDataPath, "models");

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
    // Not packaged
  }

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

async function loadModelOnce(): Promise<void> {
  if (isModelLoaded && embeddingModel) {
    return;
  }

  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

  // Force @xenova/transformers to use onnxruntime-web (WASM)
  const realReleaseName = process.release.name;
  try {
    (process.release as any).name = "browser";
  } catch { /* ignore */ }

  const {
    AutoProcessor,
    AutoTokenizer,
    CLIPModel,
    RawImage,
    env,
  } = await import("@xenova/transformers");

  try {
    (process.release as any).name = realReleaseName;
  } catch { /* ignore */ }

  env.localModelPath = _localModelPath;

  const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/";
    console.log(`[AI] Using HF mirror: ${mirror}`);
  }

  env.allowRemoteModels = true;
  console.log("[AI] Using ONNX Web (WASM) backend — no native dependencies");

  const modelId = "Xenova/clip-vit-base-patch32";

  _clipProcessor = await AutoProcessor.from_pretrained(modelId);
  _clipTokenizer = await AutoTokenizer.from_pretrained(modelId);
  _clipModel = await CLIPModel.from_pretrained(modelId, { quantized: true });

  // Capture local refs for the closures below (module-level refs get nulled on dispose)
  const processor = _clipProcessor;
  const tokenizer = _clipTokenizer;
  const model = _clipModel;

  embeddingModel = {
    embedImage: async (imagePath: string) => {
      const image = await RawImage.read(imagePath);
      const inputs = await processor(image);
      const output = await model(inputs);
      try {
        const { image_embeds } = output;
        const vec = Array.from(image_embeds.data as Float32Array);
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return vec.map((v) => v / (norm || 1));
      } finally {
        disposeTensors(output);
      }
    },
    embedText: async (text: string) => {
      const inputs = await tokenizer([text], { padding: true, truncation: true });
      const output = await model(inputs);
      try {
        const { text_embeds } = output;
        const vec = Array.from(text_embeds.data as Float32Array);
        const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
        return vec.map((v) => v / (norm || 1));
      } finally {
        disposeTensors(output);
      }
    },
  };

  isModelLoaded = true;
  console.log("[AI] CLIP model loaded");
}

/**
 * Load the model (initial load or after a dispose cycle).
 * Safe to call multiple times — skips if already loaded.
 */
async function loadModel(): Promise<void> {
  await loadModelOnce();
}

/**
 * Dispose the current ONNX session and reload the model from disk.
 * This is the nuclear option for WASM heap pressure — it completely
 * destroys the inference session and creates a fresh one.
 */
async function reloadModel(): Promise<void> {
  console.log("[AI] Disposing ONNX session to reset WASM heap...");
  await destroyModel();
  await loadModelOnce();
  console.log("[AI] Model reloaded — WASM heap reset");
}

// --- Public API ---

export function isAiModelLoaded(): boolean {
  return isModelLoaded;
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
    isActive: isEmbedding,
    isModelLoaded,
  };
}

// --- Embedding ---

/**
 * How many photos to process before disposing and reloading the ONNX
 * model to reset WASM heap. CLIP ViT-B/32 inference in WASM mode
 * leaks ~15-25 MB per call in the arena allocator. After about 200
 * calls the 4 GB WASM heap fragments and the next allocation crashes.
 * Reloading every 20 keeps us well under the limit.
 */
const MODEL_RELOAD_INTERVAL = 20;

export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  const db = getDatabase();

  if (isEmbedding) {
    console.warn("[AI] embedAllPhotos already running, skipping duplicate call");
    return 0;
  }

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
  let sinceLastReload = 0;

  console.log(`[AI] Starting embedding for ${total} photos (reload every ${MODEL_RELOAD_INTERVAL})`);

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

    // --- Periodic ONNX session reset to free WASM heap ---
    if (sinceLastReload >= MODEL_RELOAD_INTERVAL) {
      console.log(
        `[AI] Reloading ONNX model at ${processed}/${total} (every ${MODEL_RELOAD_INTERVAL} photos)`
      );
      try {
        await reloadModel();
      } catch (err: any) {
        console.error("[AI] Model reload failed:", err?.message);
        // If reload fails, we're dead in the water — report error and stop
        isEmbedding = false;
        currentProgress = {
          processed,
          total,
          phase: "error",
          currentFile: "",
          error: `模型重载失败 (photo ${processed}/${total}): ${err?.message}`,
        };
        onProgress?.(currentProgress);
        return processed;
      }
      sinceLastReload = 0;

      // Short pause after reload to let everything settle
      await new Promise((r) => setTimeout(r, 2000));
    }

    try {
      if (!fs.existsSync(photo.path)) {
        console.warn(`[AI] Skipping missing file: ${photo.path}`);
        db.update(photos)
          .set({ isAiProcessed: true })
          .where(eq(photos.id, photo.id))
          .run();
        continue;
      }

      // Brief breath between photos
      if (processed > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }

      console.log(`[AI] Embedding photo ${photo.id}: ${path.basename(photo.path)}`);
      const vector = await embeddingModel!.embedImage(photo.path);

      await photoTable.add([
        { photo_id: photo.id, vector, created_at: Date.now() },
      ]);

      db.update(photos)
        .set({ isAiProcessed: true, vectorId: `vec_${photo.id}` })
        .where(eq(photos.id, photo.id))
        .run();

      processed++;
      sinceLastReload++;
      console.log(`[AI] Photo ${photo.id} embedded (${processed}/${total})`);
    } catch (error: any) {
      console.error(
        `[AI] Error embedding photo ${photo.id}: ${error?.message || error}`,
        `\n  File: ${photo.path}`
      );
      // Don't crash the batch — continue to next photo
    }
  }

  currentProgress = {
    processed,
    total,
    phase: "complete",
    currentFile: "",
  };
  onProgress?.(currentProgress);
  isEmbedding = false;
  return processed;
}

// --- Search ---

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
