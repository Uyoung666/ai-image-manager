import { fork } from "node:child_process";
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
import { eq, sql } from "drizzle-orm";
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
    if (
      value &&
      typeof value === "object" &&
      typeof value.dispose === "function"
    ) {
      try {
        value.dispose();
      } catch {
        /* best-effort */
      }
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
  const VECTOR_DIM = 512;

  const tableNames = await vectordb.tableNames();

  if (tableNames.includes("photo_embeddings")) {
    photoTable = await vectordb.openTable("photo_embeddings");

    // Validate schema: vector column must be FixedSizeList<Float32>[512]
    const schema = await photoTable.schema();
    const vectorField = schema.fields.find((f: any) => f.name === "vector");
    const schemaValid =
      vectorField &&
      vectorField.type !== null &&
      typeof vectorField.type === "object" &&
      (vectorField.type as any).listSize === VECTOR_DIM;

    if (schemaValid) {
      console.log("[AI] Opened existing photo_embeddings table (schema OK)");

      // Ensure vector index exists
      const indices = await photoTable.listIndices();
      const hasVectorIndex = indices.some(
        (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
      );
      if (hasVectorIndex) {
        console.log("[AI] Vector index already exists");
      } else {
        const rowCount = await photoTable.countRows();
        if (rowCount > 1) {
          console.log(`[AI] Creating vector index on ${rowCount} rows...`);
          await photoTable.createIndex("vector", {
            config: lancedb.Index.ivfPq({
              numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount) / 4)),
              distanceType: "cosine",
            }),
          });
          console.log("[AI] Vector index created");
        }
      }

      isVectorDBReady = true;
      return;
    }
    console.log(
      "[AI] Schema mismatch — vector column not FixedSizeList<512>. Recreating..."
    );
    await vectordb.dropTable("photo_embeddings");
    photoTable = null as any;
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

  photoTable = await vectordb.createEmptyTable("photo_embeddings", schema);
  console.log(
    "[AI] Created photo_embeddings table (explicit FixedSizeList<Float32>[512] schema)"
  );

  isVectorDBReady = true;
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

// --- Single-image worker embedding (avoids loading vision model in main process) ---

function embedImageInWorker(
  imagePath: string,
  modelPath: string
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const workerScript = findWorkerScript();

    // fork() inherits Electron's Node.js — no native-module version mismatch
    const child = fork(workerScript, [], {
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      timeout: WORKER_TIMEOUT,
    });

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "result") {
        const result = msg.results?.[0];
        if (result?.vector && result.vector.length > 0) {
          resolve(result.vector);
        } else {
          reject(
            new Error(
              `Image embedding failed: ${result?.error || "empty vector"}`
            )
          );
        }
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(`Image embed worker exited with code ${code}: ${stderr.slice(-300)}`)
        );
      }
    });

    child.on("error", reject);

    child.send({
      type: "embed",
      modelPath,
      photos: [{ id: 1, path: imagePath }],
    });
  });
}

// --- Model loading (text-only for search queries; image embedding uses worker) ---

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
      if (err) {
        reject(err);
      } else {
        resolve();
      }
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
  } catch {
    /* ignore */
  }

  const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import(
    "@xenova/transformers"
  );

  try {
    (process.release as any).name = realReleaseName;
  } catch {
    /* ignore */
  }

  env.localModelPath = _localModelPath;

  const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/resolve/main/";
    console.log(`[AI] Using HF mirror: ${mirror}`);
  }

  env.allowRemoteModels = true;
  // Single-threaded WASM to avoid SharedArrayBuffer issues in Electron main process.
  // Only loading the text model (~64MB quantized ONNX) — vision model is isolated
  // in child processes via embed-worker.mjs to prevent WASM heap exhaustion.
  env.backends.onnx.wasm.numThreads = 1;
  console.log(
    "[AI] Using ONNX Web (WASM) backend — single-threaded, text-model only"
  );

  const modelId = "Xenova/clip-vit-base-patch32";
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const textModel = await CLIPTextModelWithProjection.from_pretrained(modelId, {
    quantized: true,
  });

  embeddingModel = {
    // embedImage is intentionally NOT provided here — image embedding goes
    // through embedImageInWorker() to keep the WASM heap within limits.
    embedImage: async (_imagePath: string) => {
      throw new Error(
        "embedImage not available in main process — use embedImageInWorker()"
      );
    },
    embedText: async (text: string) => {
      const inputs = await tokenizer([text], {
        padding: true,
        truncation: true,
      });
      const output = await textModel(inputs);
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
  console.log(
    "[AI] CLIP text model loaded (vision model isolated in worker processes)"
  );
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

export interface AiHealthStatus {
  lancedb: "ok" | "error";
  lancedbDetail: string;
  overall: "healthy" | "degraded" | "unhealthy";
  textModel: "ok" | "not_loaded" | "error";
  vectorIndex: "ok" | "missing" | "error";
  vectorTable: "ok" | "missing" | "error";
  vectorTableRows: number;
}

export async function checkAiHealth(): Promise<AiHealthStatus> {
  const status: AiHealthStatus = {
    lancedb: "error",
    lancedbDetail: "",
    vectorTable: "error",
    vectorTableRows: 0,
    vectorIndex: "error",
    textModel: "not_loaded",
    overall: "unhealthy",
  };

  // 1. Check LanceDB connection + table
  try {
    if (!vectordb) {
      const userDataPath = app.getPath("userData");
      const vectorPath = path.join(userDataPath, "vectors");
      const lancedb = await import("@lancedb/lancedb");
      vectordb = await lancedb.connect(vectorPath);
    }

    const tableNames = await vectordb.tableNames();
    status.lancedb = "ok";
    status.lancedbDetail = `connected, tables: ${tableNames.join(", ") || "(none)"}`;

    if (tableNames.includes("photo_embeddings")) {
      if (!photoTable) {
        photoTable = await vectordb.openTable("photo_embeddings");
      }

      const rowCount = await photoTable.countRows();
      status.vectorTable = "ok";
      status.vectorTableRows = rowCount;

      // Verify schema: vector column must be FixedSizeList
      try {
        const schema = await photoTable.schema();
        const vectorField = schema.fields.find((f: any) => f.name === "vector");
        if (
          vectorField &&
          typeof vectorField.type === "object" &&
          (vectorField.type as any).listSize > 0
        ) {
          status.lancedbDetail += `, schema: FixedSizeList<${(vectorField.type as any).listSize}>`;
        } else {
          status.lancedbDetail +=
            ", schema: WARNING — vector column not FixedSizeList";
        }
      } catch {
        status.lancedbDetail += ", schema: could not read";
      }

      // Check index
      try {
        const indices = await photoTable.listIndices();
        const hasIndex = indices.some(
          (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
        );
        status.vectorIndex = hasIndex ? "ok" : "missing";
      } catch {
        status.vectorIndex = "error";
      }
    } else {
      status.vectorTable = "missing";
      status.vectorIndex = "missing";
    }
  } catch (err: any) {
    status.lancedb = "error";
    status.lancedbDetail = err?.message || "unknown error";
    status.vectorTable = "error";
    status.vectorIndex = "error";
  }

  // 2. Check text model
  if (isModelLoaded && embeddingModel) {
    status.textModel = "ok";
  } else {
    try {
      await loadModel();
      status.textModel = "ok";
    } catch {
      status.textModel = "error";
    }
  }

  // 3. Determine overall health
  if (
    status.lancedb === "ok" &&
    status.vectorTable === "ok" &&
    status.vectorTableRows > 1 &&
    status.vectorIndex === "ok" &&
    status.textModel === "ok"
  ) {
    status.overall = "healthy";
  } else if (
    status.lancedb === "ok" &&
    status.vectorTable === "ok" &&
    status.vectorTableRows > 0 &&
    status.textModel === "ok"
  ) {
    status.overall = "degraded";
  } else {
    status.overall = "unhealthy";
  }

  console.log(
    `[AI] Health check: ${status.overall} (lancedb=${status.lancedb}, table=${status.vectorTable}(${status.vectorTableRows} rows), index=${status.vectorIndex}, model=${status.textModel})`
  );

  return status;
}

// --- Child-process batch embedding ---

const BATCH_SIZE = 20; // Photos per worker process
const WORKER_TIMEOUT = 300_000; // 5 minutes per batch

function findWorkerScript(): string {
  // In dev mode, the .mjs file lives in the project's scripts/ directory
  if (app.isPackaged) {
    // Production: scripts are bundled as extraResources
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } else {
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
  }
  throw new Error("embed-worker.mjs not found");
}

interface EmbedResult {
  error?: string;
  id: number;
  vector?: number[];
}

function runEmbedBatch(
  photos: Array<{ id: number; path: string }>,
  modelPath: string,
): Promise<EmbedResult[]> {
  return new Promise((resolve, reject) => {
    const workerScript = findWorkerScript();

    console.log(
      `[AI] Forking worker for ${photos.length} photos: ${workerScript}`
    );

    // fork() inherits Electron's Node.js — no native-module version mismatch
    const child = fork(workerScript, [], {
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      timeout: WORKER_TIMEOUT,
    });

    let stderr = "";
    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "result") {
        resolve(msg.results as EmbedResult[]);
      }
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            `Worker crashed: ${stderr.slice(-500) || `exit code ${code}`}`
          )
        );
      }
    });

    child.on("error", reject);

    child.send({ type: "embed", modelPath, photos });
  });
}

// --- Batch embedding ---

export async function embedAllPhotos(
  onProgress?: EmbedProgressCallback
): Promise<number> {
  // Atomically guard against concurrent calls
  if (isEmbedding) {
    console.warn(
      "[AI] embedAllPhotos already running, skipping duplicate call"
    );
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

  // Repair: detect orphaned isAiProcessed flags from previous worker crashes.
  // Compare SQLite processed count vs LanceDB vector count; if they diverge
  // significantly, reset all flags to force a clean re-embed.
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

  const unprocessed = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(eq(photos.isAiProcessed, false))
    .all();

  const total = unprocessed.length;
  let processed = 0;

  console.log(
    `[AI] Starting embedding for ${total} photos (batch size: ${BATCH_SIZE})`
  );

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
            {
              photo_id: result.id,
              vector: result.vector,
              created_at: Date.now(),
            },
          ]);

          db.update(photos)
            .set({ isAiProcessed: true, vectorId: `vec_${result.id}` })
            .where(eq(photos.id, result.id))
            .run();

          processed++;
        } else if (result.error) {
          console.warn(
            `[AI] Photo ${result.id} embedding failed in worker: ${result.error}`
          );
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

  // Create / rebuild vector index now that all data is in place.
  // Without this, vectorSearch() may return 0 results on LanceDB v0.18+.
  if (processed > 0 && photoTable) {
    try {
      const rowCount = await photoTable.countRows();
      if (rowCount > 1) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(`[AI] Building vector index on ${rowCount} rows...`);
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount) / 4)),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index built successfully");
      }
    } catch (err: any) {
      console.error("[AI] Failed to create vector index:", err?.message);
    }
  }

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

  // Ensure vector index exists before searching
  try {
    const indices = await photoTable.listIndices();
    const hasIndex = indices.some(
      (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
    );
    if (!hasIndex) {
      const rowCount = await photoTable.countRows();
      if (rowCount > 1) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(
          `[AI] Creating vector index on ${rowCount} rows before search...`
        );
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount) / 4)),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index created for search");
      }
    }
  } catch (err: any) {
    console.warn(
      "[AI] Index check failed, attempting search anyway:",
      err?.message
    );
  }

  const queryVector = await embeddingModel.embedText(query);
  console.log(
    `[AI] searchByText: query="${query}" vecLen=${queryVector.length}`
  );

  let rawResults: Array<Record<string, unknown>> = [];

  try {
    // Cosine distance + refineFactor for accurate ranking.
    // refineFactor(5) fetches 5× candidates, then re-ranks with uncompressed
    // vectors to correct IVF_PQ quantization errors. For small datasets we
    // skip the index and use exact flat search.
    const rowCount = await photoTable.countRows();
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(rowCount < 1000 ? 0 : 5)
      .limit(limit);
    rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;
  } catch (err: any) {
    console.error("[AI] vectorSearch failed:", err?.message);
  }

  if (rawResults.length > 0) {
    const top5 = rawResults
      .slice(0, 5)
      .map((r) => Math.round((r._distance as number) * 10_000) / 10_000);
    console.log(
      `[AI] searchByText: LanceDB returned ${rawResults.length} results` +
        `, top-5 cosine-distances=[${top5.join(", ")}]`
    );
  }

  // Fallback: brute-force scan when vectorSearch returns nothing
  if (rawResults.length === 0) {
    const rowCount = await photoTable.countRows();
    if (rowCount > 1) {
      console.log(
        `[AI] vectorSearch returned 0, falling back to brute-force scan (${rowCount} rows)`
      );
      try {
        const allRows = await photoTable.query().toArray();
        const scored = (allRows as Array<Record<string, unknown>>)
          .filter(
            (r) =>
              Array.isArray(r.vector) &&
              r.vector.length === queryVector.length
          )
          .map((r) => {
            const vec = r.vector as number[];
            // Normalized vectors: dot = cosine similarity, 1-dot = cosine distance
            let dot = 0;
            for (let i = 0; i < vec.length; i++) {
              dot += vec[i] * queryVector[i];
            }
            return { ...r, _distance: 1 - dot };
          })
          .sort((a, b) => (a._distance as number) - (b._distance as number))
          .slice(0, limit);
        rawResults = scored;
        console.log(
          `[AI] Brute-force fallback returned ${rawResults.length} results`
        );
      } catch (fallbackErr: any) {
        console.error(
          "[AI] Brute-force fallback also failed:",
          fallbackErr?.message
        );
      }
    }
  }

  if (rawResults.length === 0) {
    return [];
  }

  // cosine distance ∈ [0, 2]: 0 = identical, 1 = orthogonal, 2 = opposite.
  // Cosine similarity = 1 - cosine_distance
  return rawResults.map((r: Record<string, unknown>) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
}

export async function searchByImage(
  imagePath: string,
  limit = 20
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(imagePath && fs.existsSync(imagePath))) {
    console.warn("[AI] searchByImage: image file not found:", imagePath);
    return [];
  }

  await initVectorDB();

  if (!photoTable) {
    console.warn("[AI] searchByImage: AI not initialized");
    return [];
  }

  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

  // Image embedding via worker process to keep WASM heap within limits
  let queryVector: number[];
  try {
    queryVector = await embedImageInWorker(imagePath, _localModelPath);
  } catch (err: any) {
    console.error("[AI] searchByImage: image embedding failed:", err?.message);
    return [];
  }

  const vq = photoTable
    .vectorSearch(queryVector)
    .distanceType("cosine")
    .limit(limit);
  const rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;

  if (rawResults.length === 0) {
    return [];
  }

  return rawResults.map((r: Record<string, unknown>) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
}

// --- Zero-shot tag suggestion ---
//
// CLIP ViT-B/32 was trained on English image-text pairs. English tags
// produce far better alignment with image embeddings than Chinese tags.
// We embed English text but display Chinese labels to the user.

const CANDIDATE_TAGS: Array<{ en: string; zh: string }> = [
  // Scenes
  { en: "indoor room", zh: "室内" },
  { en: "outdoor outside", zh: "户外" },
  { en: "city urban", zh: "城市" },
  { en: "nature landscape scenery", zh: "自然风景" },
  { en: "beach ocean sea", zh: "海滩" },
  { en: "mountain hill", zh: "山脉" },
  { en: "forest woods trees", zh: "森林" },
  { en: "street road", zh: "街道" },
  { en: "architecture building", zh: "建筑" },
  { en: "garden flowers", zh: "花园" },
  { en: "field meadow grass", zh: "田野" },
  { en: "lake water", zh: "湖泊" },
  { en: "river stream", zh: "河流" },
  { en: "sky clouds", zh: "天空" },
  { en: "night scene dark", zh: "夜景" },
  // Subjects
  { en: "person people human", zh: "人物" },
  { en: "animal wildlife", zh: "动物" },
  { en: "cat kitten", zh: "猫咪" },
  { en: "dog puppy", zh: "狗狗" },
  { en: "bird", zh: "鸟类" },
  { en: "car vehicle automobile", zh: "汽车" },
  { en: "flower blossom", zh: "花卉" },
  { en: "food meal dish", zh: "食物" },
  { en: "tree plant", zh: "树木" },
  { en: "water surface reflection", zh: "水面" },
  { en: "text document writing", zh: "文字" },
  { en: "screenshot screen ui", zh: "屏幕截图" },
  { en: "document paper", zh: "文档" },
  // Objects
  { en: "cup glass mug drink beverage", zh: "杯具饮品" },
  { en: "phone smartphone cellphone", zh: "手机" },
  { en: "computer laptop pc", zh: "电脑" },
  { en: "book reading", zh: "书籍" },
  { en: "chair table furniture", zh: "家具" },
  // Time / Lighting
  { en: "daytime sunny bright", zh: "白天" },
  { en: "night dark", zh: "夜晚" },
  { en: "sunset dusk evening", zh: "黄昏" },
  { en: "sunrise dawn morning", zh: "日出" },
  { en: "sunset evening", zh: "日落" },
  { en: "backlight silhouette", zh: "逆光" },
  // Style
  { en: "black and white monochrome", zh: "黑白" },
  { en: "vivid colorful saturated", zh: "鲜艳" },
  { en: "dark moody low key", zh: "暗调" },
  { en: "bright high key", zh: "亮调" },
  { en: "macro close-up detail", zh: "微距" },
  { en: "blurred background bokeh depth of field", zh: "虚化背景" },
  // Colors
  { en: "red color", zh: "红色调" },
  { en: "blue color", zh: "蓝色调" },
  { en: "green color", zh: "绿色调" },
  { en: "yellow color", zh: "黄色调" },
  { en: "white color", zh: "白色调" },
  { en: "black color", zh: "黑色调" },
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
let cachedTagEmbeddings: Array<{
  tag: string;
  displayName: string;
  vector: number[];
}> | null = null;

export async function suggestTags(
  imagePath: string,
  threshold = 0.25
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

  if (!_localModelPath) {
    _localModelPath = await ensureLocalModel();
  }

  // Pre-compute tag text embeddings once (main process, text model only).
  // Embed English text for CLIP compatibility; display Chinese to the user.
  if (cachedTagEmbeddings === null) {
    const fresh: Array<{
      tag: string;
      displayName: string;
      vector: number[];
    }> = [];
    for (const { en, zh } of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(en);
        fresh.push({ tag: en, displayName: zh, vector: textVec });
      } catch (err: any) {
        console.error(
          `[AI] Tag embedding failed for "${en}":`,
          err?.message
        );
      }
    }
    if (fresh.length > 0) {
      cachedTagEmbeddings = fresh;
    }
    console.log(
      `[AI] Pre-computed ${fresh.length}/${CANDIDATE_TAGS.length} tag embeddings (English text)`
    );
  }

  // Image embedding via worker process — keeps WASM heap within limits
  // by isolating the vision model (~89MB ONNX) in a child process.
  let imageVec: number[];
  try {
    imageVec = await embedImageInWorker(imagePath, _localModelPath);
  } catch (err: any) {
    console.error("[AI] suggestTags: image embedding failed:", err?.message);
    return [];
  }

  const results: Array<{ tag: string; confidence: number }> = [];

  if (cachedTagEmbeddings) {
    for (const { displayName, vector } of cachedTagEmbeddings) {
      const sim = cosineSimilarity(imageVec, vector);
      if (sim >= threshold) {
        results.push({
          tag: displayName,
          confidence: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  return results.slice(0, 10);
}
