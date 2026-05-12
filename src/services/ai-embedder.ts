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

// --- Constants ---

// Minimum vectors required before creating an IVF_PQ index.
// LanceDB IVF_PQ needs enough data for meaningful partitions; below this
// threshold brute-force flat search is both faster and more accurate.
const MIN_VECTORS_FOR_INDEX = 256;

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
        if (rowCount >= MIN_VECTORS_FOR_INDEX) {
          console.log(`[AI] Creating vector index on ${rowCount} rows...`);
          await photoTable.createIndex("vector", {
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
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error("Image embed worker timed out"));
      }
    }, WORKER_TIMEOUT);

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
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
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Image embed worker exited with code ${code}: ${stderr.slice(-300)}`
          )
        );
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

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
    (status.vectorIndex === "ok" || status.vectorTableRows < MIN_VECTORS_FOR_INDEX) &&
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
  modelPath: string
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
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(
          new Error(
            `Worker timed out after ${WORKER_TIMEOUT}ms: ${stderr.slice(-300)}`
          )
        );
      }
    }, WORKER_TIMEOUT);

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve(msg.results as EmbedResult[]);
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Worker exited unexpectedly (code ${code}): ${stderr.slice(-500) || "no stderr"}`
          )
        );
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

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

  // Process a batch with progressive fallback: if the worker crashes (e.g.,
  // due to a sharp/libvips native assertion on a corrupted image), split the
  // batch and retry each half. Single-photo batches that crash are skipped.
  async function processBatch(
    batch: Array<{ id: number; path: string }>,
  ): Promise<number> {
    if (batch.length === 0) return 0;

    try {
      const results = await runEmbedBatch(batch, _localModelPath!);
      let count = 0;

      const batchIds = results.filter((r) => r.vector).map((r) => r.id);
      if (batchIds.length > 0) {
        try {
          await photoTable.delete(`photo_id IN (${batchIds.join(", ")})`);
        } catch {
          // Best-effort dedup
        }
      }

      for (const result of results) {
        if (result.vector && result.vector.length > 0) {
          try {
            // Write LanceDB first — if this fails, skip SQLite to stay consistent
            await photoTable.add([
              { photo_id: result.id, vector: result.vector, created_at: Date.now() },
            ]);
          } catch (lanceErr: any) {
            console.warn(
              `[AI] Photo ${result.id} LanceDB write failed, skipping SQLite update: ${lanceErr?.message}`
            );
            continue;
          }
          // Only update SQLite after LanceDB write succeeds
          try {
            db.update(photos)
              .set({ isAiProcessed: true, vectorId: `vec_${result.id}` })
              .where(eq(photos.id, result.id))
              .run();
          } catch (dbErr: any) {
            console.warn(
              `[AI] Photo ${result.id} SQLite update failed (vector already written): ${dbErr?.message}`
            );
            // Vector is in LanceDB but SQLite flag failed — repair will reconcile later
          }
          count++;
        } else if (result.error) {
          console.warn(
            `[AI] Photo ${result.id} embedding failed: ${result.error}`
          );
        }
      }
      return count;
    } catch (err: any) {
      // Worker crashed — isolate the problematic photo(s)
      if (batch.length === 1) {
        console.warn(
          `[AI] Skipping photo ${batch[0].id} — worker crash (likely corrupted image): ${err.message}`
        );
        return 0;
      }
      const mid = Math.floor(batch.length / 2);
      const left = await processBatch(batch.slice(0, mid));
      const right = await processBatch(batch.slice(mid));
      return left + right;
    }
  }

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

    const batchCount = await processBatch(batch);
    processed += batchCount;

    if (batchCount < batch.length) {
      console.warn(
        `[AI] Batch: ${batchCount}/${batch.length} succeeded, ${batch.length - batchCount} skipped`
      );
    }
    console.log(`[AI] Batch complete: ${processed}/${total}`);
  }

  // If there were no photos at all, stay in "idle" phase so the UI
  // allows restarting after the user imports photos.
  if (total === 0 && totalPhotos === 0) {
    currentProgress = { processed: 0, total: 0, phase: "idle", currentFile: "" };
  } else {
    // Normalize total to processed so progress shows 100% even with
    // uncorrectable failures (corrupted images, worker crashes, etc.)
    currentProgress = {
      processed,
      total: processed > 0 ? processed : total,
      phase: "complete",
      currentFile: "",
    };
  }
  onProgress?.(currentProgress);
  isEmbedding = false;

  // Create / rebuild vector index now that all data is in place.
  // Without this, vectorSearch() may return 0 results on LanceDB v0.18+.
  if (processed > 0 && photoTable) {
    try {
      const rowCount = await photoTable.countRows();
      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(`[AI] Building vector index on ${rowCount} rows...`);
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index built successfully");
      } else {
        console.log(
          `[AI] Skipping index build: ${rowCount} vectors < ${MIN_VECTORS_FOR_INDEX} threshold`
        );
      }
    } catch (err: any) {
      console.error("[AI] Failed to create vector index:", err?.message);
    }
  }

  return processed;
}

// --- Search ---

// Chinese → English search keyword mapping.
// CLIP ViT-B/32 was trained on English image-text pairs, so Chinese queries
// produce poor alignment. We translate known Chinese terms to English before
// embedding to improve search accuracy.
const ZH_TO_EN_SEARCH: Record<string, string> = {
  猫: "cat kitten",
  猫咪: "cat kitten",
  狗: "dog puppy",
  狗狗: "dog puppy",
  人: "person people human",
  人物: "person people human portrait",
  花: "flower blossom",
  花卉: "flower blossom",
  车: "car vehicle automobile",
  汽车: "car vehicle automobile",
  建筑: "building architecture",
  海: "ocean sea beach water",
  海滩: "beach sand ocean",
  山: "mountain hill",
  山脉: "mountain hill",
  树: "tree plant forest",
  树木: "tree plant forest",
  天空: "sky clouds",
  云: "clouds sky",
  日落: "sunset evening dusk",
  日出: "sunrise dawn morning",
  夜景: "night scene dark",
  夜晚: "night dark",
  食物: "food meal dish",
  美食: "food meal dish",
  室内: "indoor room inside",
  户外: "outdoor outside",
  城市: "city urban street",
  黑白: "black and white monochrome",
  雪: "snow winter cold",
  鸟: "bird",
  鸟类: "bird",
  鱼: "fish underwater",
  昆虫: "insect bug",
  桥: "bridge",
  路: "road street path",
  街道: "street road urban",
  门: "door entrance",
  窗: "window",
  桌子: "table desk furniture",
  椅子: "chair furniture",
  书: "book reading",
  书籍: "book reading",
  手机: "phone smartphone cellphone",
  电脑: "computer laptop pc",
  红色: "red color",
  蓝色: "blue color",
  绿色: "green color",
  黄色: "yellow color",
  白色: "white color bright",
  黑色: "black color dark",
  秋天: "autumn fall season",
  春天: "spring season",
  夏天: "summer season",
  冬天: "winter snow season",
  风景: "landscape scenery nature",
  自然风景: "landscape scenery nature",
  人像: "portrait person face",
  微距: "macro close-up detail",
  逆光: "backlight silhouette",
  动物: "animal wildlife",
  文字: "text document writing",
  截图: "screenshot screen ui",
  屏幕截图: "screenshot screen ui",
  水: "water lake river ocean",
  水面: "water surface reflection",
  草地: "grass field meadow green",
  沙滩: "beach sand shore",
  夕阳: "sunset evening dusk",
  森林: "forest woods trees nature",
  花园: "garden flowers park",
  湖: "lake water reflection",
  湖泊: "lake water reflection",
  河: "river stream water",
  河流: "river stream water",
  雾: "fog mist atmosphere",
  飞机: "airplane aircraft sky",
  船: "boat ship water",
  自行车: "bicycle bike",
  摩托车: "motorcycle bike",
  花海: "flower field garden colorful",
  红叶: "red leaf autumn fall",
  雪景: "snow winter landscape white",
  蓝天: "blue sky clear",
  白云: "white clouds sky",
  绿树: "green tree forest",
  大海: "ocean sea blue water",
  高山: "tall mountain peak",
  小溪: "stream creek water",
  瀑布: "waterfall water cascade",
  彩虹: "rainbow sky colorful",
  闪电: "lightning storm sky",
  星空: "starry night sky stars",
  月亮: "moon night sky",
  太阳: "sun bright sky daytime",
  // Extended vocabulary
  草莓: "strawberry",
  水果: "fruit",
  蔬菜: "vegetable",
  蛋糕: "cake dessert",
  面包: "bread",
  咖啡: "coffee",
  饮料: "drink beverage",
  孩子: "child kid baby young person",
  婴儿: "baby infant newborn person",
  老人: "elderly senior old person",
  婚礼: "wedding ceremony bride groom celebration",
  生日: "birthday celebration party cake",
  聚会: "party gathering celebration group people",
  运动: "sports exercise activity game",
  舞蹈: "dance dancing performance person",
  音乐: "music concert performance instrument",
  眼镜: "glasses eyewear spectacles person face",
  帽子: "hat cap headwear person",
  鞋子: "shoes footwear sneakers",
  衣服: "clothing outfit dress garment",
  包: "bag handbag backpack purse",
  灯: "lamp light lighting illumination",
  蜡烛: "candle flame light fire",
  玩具: "toy doll plaything child",
  乐器: "musical instrument guitar piano music",
  吉他: "guitar musical instrument string music",
  钢琴: "piano keyboard musical instrument",
  相机: "camera photography lens equipment",
  叶子: "leaf plant green nature",
  火焰: "fire flame burn hot",
  沙漠: "desert sand dry arid nature",
  极光: "aurora northern lights sky night nature",
  雨天: "rain wet weather umbrella water",
  枫叶: "maple leaf autumn fall red nature",
  樱花: "cherry blossom pink flower spring nature",
  教堂: "church cathedral building architecture",
  寺庙: "temple building architecture religious",
  城堡: "castle building architecture historic",
  塔: "tower tall building structure architecture",
  公园: "park garden green nature outdoor",
  市场: "market shopping bazaar stall people",
  餐厅: "restaurant dining food table indoor",
  厨房: "kitchen cooking room indoor food",
  卧室: "bedroom bed sleeping room indoor",
  办公室: "office desk workspace computer indoor",
  兔子: "rabbit bunny animal pet",
  熊猫: "panda bear animal black white",
  老虎: "tiger animal wild cat predator",
  狮子: "lion animal wild cat predator",
  大象: "elephant animal large wild",
  猴子: "monkey animal primate wild",
  蛇: "snake reptile animal wild",
  蝴蝶: "butterfly insect colorful wings nature",
  马: "horse animal running field",
  牛: "cow cattle animal farm",
  羊: "sheep lamb animal wool farm",
  紫色: "purple violet color",
  橙色: "orange color warm",
  粉色: "pink color soft",
  棕色: "brown color earth",
  鲜艳: "vivid bright colorful saturated",
  柔和: "soft gentle pastel muted color",
  模糊: "blurry bokeh out of focus soft",
  清晰: "sharp clear detailed crisp",
  倒影: "reflection mirror water surface",
  剪影: "silhouette shadow dark outline shape",
  特写: "close-up macro detail zoom",
  广角: "wide angle panorama expansive view",
  节日: "festival celebration holiday decoration",
  烟花: "fireworks celebration night sky colorful",
  路灯: "streetlight lamp post night urban",
  钟楼: "clock tower bell building architecture",
  雕塑: "sculpture statue art monument",
  喷泉: "fountain water spray garden urban",
  涂鸦: "graffiti street art urban wall colorful",
  壁画: "mural wall painting art colorful",
  屋顶: "roof top building architecture",
  窗户: "window glass building architecture",
  阳台: "balcony terrace outdoor building",
  楼梯: "staircase stairs steps indoor architecture",
  走廊: "corridor hallway passage indoor architecture",
  拱门: "arch doorway entrance architecture",
  柱子: "pillar column architecture building",
  栅栏: "fence barrier wood metal outdoor",
  旗帜: "flag banner symbol wind outdoor",
  灯笼: "lantern light decoration red festive",
  气球: "balloon colorful celebration party decoration",
  礼物: "gift present box package celebration",
  彩带: "ribbon streamer decoration colorful celebration",
};

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
      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(
          `[AI] Creating vector index on ${rowCount} rows before search...`
        );
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index created for search");
      } else {
        console.log(
          `[AI] Using brute-force search: ${rowCount} vectors < ${MIN_VECTORS_FOR_INDEX} threshold`
        );
      }
    }
  } catch (err: any) {
    console.warn(
      "[AI] Index check failed, attempting search anyway:",
      err?.message
    );
  }

  // Translate Chinese queries to English for better CLIP alignment.
  // CLIP ViT-B/32 was trained on natural-language image captions, not keyword
  // lists. We wrap translated terms in a CLIP-friendly prompt template and
  // deduplicate repeated words to produce cleaner embeddings.
  let searchText = query.trim();
  const hasChinese = /[一-鿿]/.test(searchText);
  if (hasChinese) {
    let translated = searchText;
    // Sort keys by length descending so longer phrases match first
    const sortedKeys = Object.keys(ZH_TO_EN_SEARCH).sort(
      (a, b) => b.length - a.length
    );
    for (const zh of sortedKeys) {
      if (translated.includes(zh)) {
        translated = translated.replace(
          new RegExp(zh, "g"),
          ZH_TO_EN_SEARCH[zh]
        );
      }
    }
    // Deduplicate repeated keywords from overlapping translations
    const words = translated.split(/\s+/);
    const seen = new Set<string>();
    const unique = words.filter((w) => {
      const lower = w.toLowerCase();
      if (seen.has(lower)) {
        return false;
      }
      seen.add(lower);
      return true;
    });
    // Strip any remaining untranslated CJK characters — CLIP VIT-B/32
    // only understands English, embedding Chinese produces noise.
    const englishOnly = unique.filter(
      (w) => !/[一-鿿㄀-鿿㐀-䶿]/.test(w)
    );
    if (englishOnly.length === 0) {
      // If nothing translated, use the raw query but let CLIP try
      searchText = query.trim();
    } else {
      // CLIP works best with short, natural descriptions
      const keywords = englishOnly.slice(0, 4).join(" ");
      searchText = `a photo of ${keywords}`;
    }
    console.log(`[AI] searchByText: zh→en "${query.trim()}" → "${searchText}"`);
  }

  const queryVector = await embeddingModel.embedText(searchText);
  console.log(
    `[AI] searchByText: query="${searchText}" vecLen=${queryVector.length}`
  );

  let rawResults: Array<Record<string, unknown>> = [];
  const rowCount = await photoTable.countRows();

  try {
    // Cosine distance + adaptive refineFactor for accurate ranking.
    // refineFactor re-ranks candidates with uncompressed vectors to correct
    // IVF_PQ quantization errors. Smaller datasets need MORE refinement
    // because fewer partitions mean coarser quantization.
    const adaptiveRefine = Math.min(
      10,
      Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
    );
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
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
    // First fallback: if Chinese was translated but returned no results,
    // try embedding the original Chinese query directly
    if (hasChinese && searchText !== query.trim()) {
      console.log(
        `[AI] Translated search returned 0, trying original Chinese: "${query.trim()}"`
      );
      try {
        const zhVector = await embeddingModel.embedText(query.trim());
        const zhVq = photoTable
          .vectorSearch(zhVector)
          .distanceType("cosine")
          .refineFactor(
            Math.min(10, Math.max(3, Math.ceil(100 / Math.sqrt(rowCount))))
          )
          .limit(limit);
        rawResults = (await zhVq.toArray()) as Array<Record<string, unknown>>;
        if (rawResults.length > 0) {
          console.log(
            `[AI] Chinese fallback returned ${rawResults.length} results`
          );
        }
      } catch (fallbackErr: any) {
        console.error("[AI] Chinese fallback failed:", fallbackErr?.message);
      }
    }
  }

  // Second fallback: brute-force scan when both translated and Chinese return nothing
  if (rawResults.length === 0) {
    const rowCount2 = await photoTable.countRows();
    if (rowCount2 > 1) {
      console.log(
        `[AI] vectorSearch returned 0, falling back to brute-force scan (${rowCount2} rows)`
      );
      try {
        const allRows = await photoTable.query().toArray();
        const scored = (allRows as Array<Record<string, unknown>>)
          .filter(
            (r) =>
              Array.isArray(r.vector) && r.vector.length === queryVector.length
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
  // Filter out results with cosine distance > 0.55 (similarity < 0.45)
  // CLIP typically returns 0.2-0.4 for good matches, 0.6+ for irrelevant
  const MAX_COSINE_DISTANCE = 0.55;
  const filtered = rawResults.filter(
    (r: Record<string, unknown>) => (r._distance as number) <= MAX_COSINE_DISTANCE
  );

  if (filtered.length === 0 && rawResults.length > 0) {
    // If all results are above threshold, return top 5 with best distances
    // so user gets some feedback rather than empty results
    const top5 = rawResults.slice(0, 5);
    console.log(
      `[AI] searchByText: all ${rawResults.length} results above threshold ${MAX_COSINE_DISTANCE}, returning top 5`
    );
    return top5.map((r: Record<string, unknown>) => {
      const cosDist = r._distance as number;
      const similarity = Math.max(0, 1 - cosDist);
      return {
        photoId: r.photo_id as number,
        similarity: Math.round(similarity * 10_000) / 10_000,
      };
    });
  }

  return filtered.map((r: Record<string, unknown>) => {
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

  const rowCount = await photoTable.countRows();
  const adaptiveRefine = Math.min(
    10,
    Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
  );
  const vq = photoTable
    .vectorSearch(queryVector)
    .distanceType("cosine")
    .refineFactor(adaptiveRefine)
    .limit(limit);
  let rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;

  // Brute-force fallback when vector index search returns empty
  if (rawResults.length === 0) {
    console.log("[AI] searchByImage: index search empty, trying brute-force...");
    try {
      const allRows = await photoTable.query().toArray();
      const allData = allRows.map((r: any) => ({
        photo_id: r.photo_id as number,
        vector: Array.from(r.vector as Float32Array),
      }));
      const scored = allData.map((r: { photo_id: number; vector: number[] }) => {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryVector.length; i++) {
          dot += queryVector[i] * r.vector[i];
          normA += queryVector[i] * queryVector[i];
          normB += r.vector[i] * r.vector[i];
        }
        const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
        return { photo_id: r.photo_id, _distance: 1 - sim };
      });
      scored.sort((a: { _distance: number }, b: { _distance: number }) => a._distance - b._distance);
      rawResults = scored.slice(0, limit) as any;
    } catch (bfErr: any) {
      console.warn("[AI] searchByImage: brute-force fallback failed:", bfErr?.message);
    }
  }

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

// In-memory LRU cache for recently queried image vectors (tag suggestion).
// Avoids repeated LanceDB lookups or worker embedding for the same photo.
const imageVecCache = new Map<number, number[]>();
const IMAGE_VEC_CACHE_MAX = 100;

export async function suggestTags(
  imagePath: string,
  threshold = 0.28,
  photoId?: number
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
        console.error(`[AI] Tag embedding failed for "${en}":`, err?.message);
      }
    }
    if (fresh.length > 0) {
      cachedTagEmbeddings = fresh;
    }
    console.log(
      `[AI] Pre-computed ${fresh.length}/${CANDIDATE_TAGS.length} tag embeddings (English text)`
    );
  }

  // Resolve image vector: check in-memory cache → LanceDB → worker embedding
  let imageVec: number[] | null = null;

  if (photoId != null) {
    // 1) In-memory LRU cache
    const cached = imageVecCache.get(photoId);
    if (cached) {
      imageVec = cached;
    }
  }

  if (!imageVec && photoId != null) {
    // 2) LanceDB lookup (already-computed embedding from embedAllPhotos)
    try {
      await initVectorDB();
      const vectors = await getPhotoVectors([photoId]);
      const vec = vectors.get(photoId);
      if (vec) {
        imageVec = vec;
        // Promote to in-memory cache
        if (imageVecCache.size >= IMAGE_VEC_CACHE_MAX) {
          const firstKey = imageVecCache.keys().next().value;
          if (firstKey !== undefined) {
            imageVecCache.delete(firstKey);
          }
        }
        imageVecCache.set(photoId, vec);
      }
    } catch {
      // LanceDB unavailable — fall through to worker
    }
  }

  if (!imageVec) {
    // 3) Worker embedding (no cached vector available)
    try {
      imageVec = await embedImageInWorker(imagePath, _localModelPath);
      if (photoId != null && imageVec) {
        if (imageVecCache.size >= IMAGE_VEC_CACHE_MAX) {
          const firstKey = imageVecCache.keys().next().value;
          if (firstKey !== undefined) {
            imageVecCache.delete(firstKey);
          }
        }
        imageVecCache.set(photoId, imageVec);
      }
    } catch (err: any) {
      console.error("[AI] suggestTags: image embedding failed:", err?.message);
      return [];
    }
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

  // If no results above threshold, return top 5 with highest similarity
  if (results.length === 0 && cachedTagEmbeddings) {
    const allScores = cachedTagEmbeddings.map(({ displayName, vector }) => ({
      tag: displayName,
      confidence: Math.round(cosineSimilarity(imageVec!, vector) * 100) / 100,
    }));
    allScores.sort((a, b) => b.confidence - a.confidence);
    return allScores.slice(0, 5).filter((s) => s.confidence > 0.15);
  }

  return results.slice(0, 10);
}
