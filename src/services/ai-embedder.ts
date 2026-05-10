import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { eq } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";

// --- Module-level state ---

let vectordb: any = null;
let photoTable: any = null;
let isModelLoaded = false;
let isVectorDBReady = false;

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
    // Use cosine distance for CLIP embeddings (vectors are L2-normalized)
    photoTable = await vectordb.createTable("photo_embeddings", [
      { photo_id: 0, vector: new Array(512).fill(0), created_at: Date.now() },
    ]);
    console.log("[AI] Created photo_embeddings table");
  }

  isVectorDBReady = true;
}

export async function deletePhotoVectors(photoIds: number[]): Promise<void> {
  if (!isVectorDBReady || !photoTable || photoIds.length === 0) {
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

// --- Model loading (for search queries, not batch embedding) ---

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

async function loadModel(): Promise<void> {
  if (isModelLoaded && embeddingModel) {
    return;
  }

  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

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
  const processor = await AutoProcessor.from_pretrained(modelId);
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const model = await CLIPModel.from_pretrained(modelId, { quantized: true });

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

// --- Child-process batch embedding ---

const BATCH_SIZE = 20; // Photos per worker process
const WORKER_TIMEOUT = 300_000; // 5 minutes per batch

function findWorkerScript(): string {
  // In dev mode, the .mjs file lives in the project's scripts/ directory
  if (!app.isPackaged) {
    const cwd = process.cwd();
    const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    // Fallback: relative to app path
    const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
    if (fs.existsSync(alt)) {
      return alt;
    }
  } else {
    // Production: scripts are bundled as extraResources
    const bundled = path.join(process.resourcesPath, "scripts", "embed-worker.mjs");
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  throw new Error("embed-worker.mjs not found");
}

interface EmbedResult {
  id: number;
  vector?: number[];
  error?: string;
}

function runEmbedBatch(
  photos: Array<{ id: number; path: string }>,
  modelPath: string,
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    const tmpDir = os.tmpdir();
    const batchId = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const inputFile = path.join(tmpDir, `embed-in-${batchId}.json`);
    const outputFile = path.join(tmpDir, `embed-out-${batchId}.json`);

    fs.writeFileSync(inputFile, JSON.stringify({ modelPath, photos }));

    const workerScript = findWorkerScript();

    console.log(`[AI] Spawning worker for ${photos.length} photos: ${workerScript}`);

    const child = spawn("node", [workerScript, inputFile, outputFile], {
      stdio: ["ignore", "inherit", "pipe"],
      timeout: WORKER_TIMEOUT,
    });

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      // Clean up input file
      try { fs.unlinkSync(inputFile); } catch { /* ok */ }

      if (code !== 0) {
        try { fs.unlinkSync(outputFile); } catch { /* ok */ }
        const errMsg = stderr.slice(-500) || `exit code ${code}`;
        reject(new Error(`Worker crashed: ${errMsg}`));
        return;
      }

      try {
        const data = JSON.parse(fs.readFileSync(outputFile, "utf-8"));
        try { fs.unlinkSync(outputFile); } catch { /* ok */ }
        resolve(data.results as EmbedResult[]);
      } catch (err: any) {
        reject(new Error(`Failed to read worker output: ${err.message}`));
      }
    });

    child.on("error", (err) => {
      try { fs.unlinkSync(inputFile); } catch { /* ok */ }
      try { fs.unlinkSync(outputFile); } catch { /* ok */ }
      reject(err);
    });
  });
}

// --- Batch embedding ---

export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  // Atomically guard against concurrent calls
  if (isEmbedding) {
    console.warn("[AI] embedAllPhotos already running, skipping duplicate call");
    return 0;
  }
  isEmbedding = true;

  const db = getDatabase();

  // Check that the worker script exists before starting
  try {
    const workerScript = findWorkerScript();
    console.log(`[AI] Embed worker found: ${workerScript}`);
  } catch (err: any) {
    isEmbedding = false;
    currentProgress = {
      processed: 0,
      total: 0,
      phase: "error",
      currentFile: "",
      error: `嵌入 Worker 脚本未找到: ${err.message}`,
    };
    onProgress?.(currentProgress);
    return 0;
  }

  currentProgress = {
    processed: 0,
    total: 0,
    phase: "loading",
    currentFile: "",
  };
  onProgress?.(currentProgress);

  // Ensure model path is resolved (worker needs the local model path)
  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

  await initVectorDB();

  if (!photoTable) {
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
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(eq(photos.isAiProcessed, false))
    .all();

  const total = unprocessed.length;
  let processed = 0;

  console.log(`[AI] Starting embedding for ${total} photos (batch size: ${BATCH_SIZE})`);

  // Process in batches, each batch in a fresh child process
  for (let i = 0; i < unprocessed.length; i += BATCH_SIZE) {
    if (!isEmbedding) {
      console.log("[AI] Embedding stopped by user");
      break;
    }

    const batch = unprocessed.slice(i, i + BATCH_SIZE);

    currentProgress = {
      processed,
      total,
      phase: "embedding",
      currentFile: `batch ${Math.floor(i / BATCH_SIZE) + 1}/${Math.ceil(total / BATCH_SIZE)}`,
    };
    onProgress?.(currentProgress);

    try {
      const results = await runEmbedBatch(batch, _localModelPath);

      // Deduplicate: delete existing vectors for this batch before inserting
      const batchIds = results.filter((r) => r.vector).map((r) => r.id);
      if (batchIds.length > 0) {
        try {
          await photoTable.delete(`photo_id IN (${batchIds.join(", ")})`);
        } catch {
          // Best-effort dedup — ignore if delete fails
        }
      }

      // Store successful results
      for (const result of results) {
        if (result.vector && result.vector.length > 0) {
          await photoTable.add([
            { photo_id: result.id, vector: result.vector, created_at: Date.now() },
          ]);

          db.update(photos)
            .set({ isAiProcessed: true, vectorId: `vec_${result.id}` })
            .where(eq(photos.id, result.id))
            .run();

          processed++;
        } else if (result.error) {
          console.warn(`[AI] Photo ${result.id} embedding failed in worker: ${result.error}`);
        }
      }

      console.log(`[AI] Batch complete: ${processed}/${total}`);
    } catch (err: any) {
      // Worker process crashed — log and continue with next batch
      console.error(`[AI] Worker batch failed: ${err.message}`);
      // Individual photos in this batch won't be retried automatically;
      // they'll remain unprocessed for the next run.
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
  if (!query.trim()) {
    return [];
  }

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

  return results.map((r: Record<string, unknown>) => {
    const distance = r._distance as number;
    const similarity = 1 / (1 + distance);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10000) / 10000,
    };
  });
}

export async function searchByImage(
  imagePath: string,
  limit = 20
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!imagePath || !fs.existsSync(imagePath)) {
    console.warn("[AI] searchByImage: image file not found:", imagePath);
    return [];
  }

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

  return results.map((r: Record<string, unknown>) => {
    const distance = r._distance as number;
    const similarity = 1 / (1 + distance);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10000) / 10000,
    };
  });
}

// --- Zero-shot tag suggestion ---

const CANDIDATE_TAGS = [
  // Scenes
  "室内", "户外", "城市", "自然风景", "海滩", "山脉", "森林", "街道", "建筑",
  "花园", "田野", "湖泊", "河流", "天空", "夜景",
  // Subjects
  "人物", "动物", "猫咪", "狗狗", "鸟类", "汽车", "花卉", "食物",
  "树木", "水面", "文字", "屏幕截图", "文档",
  // Time / Lighting
  "白天", "夜晚", "黄昏", "日出", "日落", "逆光",
  // Style
  "黑白", "鲜艳", "暗调", "亮调", "微距", "虚化背景",
  // Colors
  "红色调", "蓝色调", "绿色调", "黄色调", "白色调", "黑色调",
];

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

// Pre-computed text embeddings for candidate tags (computed once after model load)
let cachedTagEmbeddings: Array<{ tag: string; vector: number[] }> | null = null;

export async function suggestTags(
  imagePath: string,
  threshold = 0.22
): Promise<Array<{ tag: string; confidence: number }>> {
  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] suggestTags: model load failed:", err?.message);
    return [];
  }

  if (!embeddingModel) {
    console.warn("[AI] suggestTags: AI not initialized");
    return [];
  }

  // Pre-compute tag embeddings once
  if (!cachedTagEmbeddings) {
    cachedTagEmbeddings = [];
    for (const tag of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(tag);
        cachedTagEmbeddings.push({ tag, vector: textVec });
      } catch {
        // Skip tags that fail to embed
      }
    }
    console.log(`[AI] Pre-computed ${cachedTagEmbeddings.length} tag embeddings`);
  }

  const imageVec = await embeddingModel.embedImage(imagePath);
  const results: Array<{ tag: string; confidence: number }> = [];

  for (const { tag, vector } of cachedTagEmbeddings) {
    const sim = cosineSimilarity(imageVec, vector);
    if (sim >= threshold) {
      results.push({ tag, confidence: Math.round(sim * 100) / 100 });
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 10);
}
