/**
 * Persistent CLIP image embedding worker (DirectML GPU accelerated).
 *
 * Runs as a child process via fork(). Loads the CLIP vision ONNX model once
 * via onnxruntime-node (native, supports DirectML), then processes batches
 * as they arrive — no model reload per batch.
 *
 * IPC protocol:
 *   Parent → { type: "init",   modelPath, useGPU }
 *   Worker → { type: "ready" }
 *   Parent → { type: "embed",  photos: [{ id, path }, ...] }
 *   Worker → { type: "result", results: [{ id, vector?, error? }] }
 *   Parent → { type: "shutdown" } — worker exits.
 */

import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const exiftoolPath = require("exiftool-vendored.exe");

const RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
  ".pef",
  ".rwl",
  ".3fr",
  ".raw",
]);

function isRawFile(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

function extractRawPreview(filePath) {
  try {
    const buf = execFileSync(exiftoolPath, ["-b", "-JpgFromRaw", filePath], {
      timeout: 15_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (buf && buf.length > 0) {
      return buf;
    }
  } catch {}
  try {
    const buf = execFileSync(exiftoolPath, ["-b", "-PreviewImage", filePath], {
      timeout: 15_000,
      maxBuffer: 50 * 1024 * 1024,
    });
    if (buf && buf.length > 0) {
      return buf;
    }
  } catch {}
  return null;
}

// --- CLIP ViT-B/32 preprocessing constants ---
const CLIP_SIZE = 224;
const CLIP_MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD = [0.268_629_54, 0.261_302_58, 0.275_777_11];

// --- Abort flag for mid-batch cancellation ---
let aborted = false;

// --- Module-level model cache ---
let ortSession = null;
// onnxruntime-node lazy-loaded singleton
let _ort = null;
async function loadOrt() {
  if (_ort) {
    return _ort;
  }
  // Use the module-level `require` (line 24) — it already resolves from
  // the script's location and is more reliable than creating a new one.
  try {
    _ort = require("onnxruntime-node");
  } catch (err0) {
    // Fallback: resolve from project root (packaged builds may differ)
    console.error("[Worker] Primary onnxruntime-node load failed:", err0.message);
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

/**
 * Preprocess image: sharp decode + resize + normalize → Float32Array(NCHW).
 */
async function preprocessCLIP(filePath) {
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(CLIP_SIZE, CLIP_SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== CLIP_SIZE || height !== CLIP_SIZE) {
    throw new Error(`sharp resize mismatch: ${width}x${height}`);
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixelsPerChannel = CLIP_SIZE * CLIP_SIZE;
  const floatData = new Float32Array(3 * pixelsPerChannel);

  for (let y = 0; y < CLIP_SIZE; y++) {
    for (let x = 0; x < CLIP_SIZE; x++) {
      const srcIdx = (y * CLIP_SIZE + x) * channels;
      for (let c = 0; c < 3; c++) {
        const pixel = rgb[srcIdx + c] / 255.0;
        const normalized = (pixel - CLIP_MEAN[c]) / CLIP_STD[c];
        floatData[c * pixelsPerChannel + y * CLIP_SIZE + x] = normalized;
      }
    }
  }
  return floatData;
}

// --- Init handler: load CLIP vision ONNX model directly ---
async function handleInit(msg) {
  const { modelPath, useGPU } = msg;
  const onnxPath = path.join(
    modelPath,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "vision_model_quantized.onnx"
  );
  console.error(`[Worker] Loading CLIP vision ONNX: ${onnxPath}`);

  // Phase 1: load onnxruntime binding (~10%)
  process.send?.({
    type: "init-progress",
    percent: 5,
    stage: "loading-runtime",
  });
  const { InferenceSession } = await loadOrt();

  // NOTE: DML crashes on ViT-B/32 (0xFFFF0003) in both onnxruntime 1.26.0
  // and 1.27.0-dev. Keep CPU-only until upstream fixes DML shader compilation
  // for Transformer models (LayerNorm/Gelu/MultiHeadAttention ops).
  const executionProviders = ["cpu"];
  console.error("[Worker] Creating session with: [cpu]");

  // Phase 2: creating ONNX session — the heavy part (~20% → ~95%)
  process.send?.({
    type: "init-progress",
    percent: 20,
    stage: "creating-session",
  });
  ortSession = await InferenceSession.create(onnxPath, {
    executionProviders,
    logSeverityLevel: 3,
    graphOptimizationLevel: "all",
    enableCpuMemArena: true,
  });
  console.error("[Worker] CLIP model loaded, ready for batches");

  process.send?.({ type: "init-progress", percent: 100, stage: "ready" });
  process.send?.({ type: "ready" });
}

// --- Embed handler: process a batch ---
async function handleEmbed(msg) {
  const { photos, modelPath } = msg;

  // Auto-init if model not loaded yet
  if (!ortSession && modelPath) {
    await handleInit({ modelPath });
  }
  if (!ortSession) {
    process.send?.({
      type: "result",
      results: (photos || []).map((p) => ({
        id: p.id,
        error: "Model not initialized",
      })),
    });
    return;
  }

  const ort = await loadOrt();
  const batchStartMs = Date.now();
  const results = [];

  for (let i = 0; i < photos.length; i++) {
    // Check for abort signal before processing each photo
    if (aborted) {
      console.error(`[Worker] Aborted at photo ${i}/${photos.length}`);
      break;
    }
    const photo = photos[i];
    try {
      // Resolve input: for RAW files, extract embedded JPEG preview
      let imageInput = photo.path;
      if (isRawFile(photo.path)) {
        const preview = extractRawPreview(photo.path);
        if (preview) {
          imageInput = preview;
        }
      }

      // Preprocess + run ONNX inference directly (no transformers overhead)
      const floatData = await preprocessCLIP(imageInput);
      const pixelValues = new ort.Tensor("float32", floatData, [
        1,
        3,
        CLIP_SIZE,
        CLIP_SIZE,
      ]);
      const output = await ortSession.run({ pixel_values: pixelValues });

      const { image_embeds } = output;
      const vec = Array.from(image_embeds.data);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      const vector = vec.map((v) => v / (norm || 1));

      // Free tensors
      for (const v of Object.values(output)) {
        if (v && typeof v === "object" && typeof v.dispose === "function") {
          v.dispose();
        }
      }

      results.push({ id: photo.id, vector });
      console.error(
        `[Worker] ${i + 1}/${photos.length} OK: ${path.basename(photo.path)}`
      );
    } catch (err) {
      console.error(
        `[Worker] ${i + 1}/${photos.length} FAIL: ${photo.path} — ${err.message}`
      );
      results.push({ id: photo.id, error: err.message });
    }
  }

  const batchMs = Date.now() - batchStartMs;
  console.error(
    `[Worker] Batch done: ${results.length} photos in ${batchMs}ms (${Math.round(batchMs / results.length)}ms/photo)`
  );

  process.send?.({ type: "result", results });
}

// --- Message loop ---
process.on("message", async (msg) => {
  try {
    if (msg.type === "init") {
      await handleInit(msg);
    } else if (msg.type === "embed") {
      aborted = false; // Reset abort flag for new batch
      await handleEmbed(msg);
    } else if (msg.type === "abort") {
      aborted = true;
      console.error("[Worker] Abort signal received");
    } else if (msg.type === "shutdown") {
      console.error("[Worker] Shutting down");
      process.exit(0);
    }
  } catch (err) {
    console.error(`[Worker] Fatal error handling "${msg.type}":`, err.message);
    if (msg.type === "embed") {
      process.send?.({
        type: "result",
        results: (msg.photos || []).map((p) => ({
          id: p.id,
          error: err.message,
        })),
      });
    } else if (msg.type === "init") {
      process.send?.({ type: "ready" }); // Send anyway so pool doesn't hang
    }
  }
});
