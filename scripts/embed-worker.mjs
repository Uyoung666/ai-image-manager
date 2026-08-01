/**
 * Persistent SigLIP image embedding worker.
 *
 * Runs as a child process via fork(). Loads the SigLIP vision ONNX model once
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

import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { extractRawPreview } from "./raw-preview.mjs";

const require = createRequire(import.meta.url);

const sharpThreads = Math.max(
  1,
  Number.parseInt(process.env.AI_EMBED_SHARP_THREADS || "1", 10) || 1
);
sharp.concurrency(sharpThreads);

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

const MODEL_CONFIGS = {
  siglip: {
    directory: "siglip-base-patch16-224",
    displayName: "SigLIP Base Patch16-224",
    imageMean: [0.5, 0.5, 0.5],
    imageOutputName: "pooler_output",
    imageSize: 224,
    imageStd: [0.5, 0.5, 0.5],
    resizeFit: "fill",
  },
};
let activeModel = MODEL_CONFIGS.siglip;

// --- Abort flag for mid-batch cancellation ---
let aborted = false;

// --- Module-level model cache ---
let ortSession = null;
// onnxruntime-node lazy-loaded singleton
let _ort = null;
function loadOrt() {
  if (_ort) {
    return _ort;
  }
  // Use the module-level `require` (line 24) — it already resolves from
  // the script's location and is more reliable than creating a new one.
  try {
    _ort = require("onnxruntime-node");
  } catch (err0) {
    // Fallback: resolve from project root (packaged builds may differ)
    console.error(
      "[Worker] Primary onnxruntime-node load failed:",
      err0.message
    );
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

/**
 * Preprocess image: sharp decode + resize + normalize → Float32Array(NCHW).
 */
async function preprocessSigLIP(filePath) {
  const imageSize = activeModel.imageSize;
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(imageSize, imageSize, {
      fit: activeModel.resizeFit,
      position: "center",
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== imageSize || height !== imageSize) {
    throw new Error(`sharp resize mismatch: ${width}x${height}`);
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixelsPerChannel = imageSize * imageSize;
  const floatData = new Float32Array(3 * pixelsPerChannel);

  for (let y = 0; y < imageSize; y++) {
    for (let x = 0; x < imageSize; x++) {
      const srcIdx = (y * imageSize + x) * channels;
      for (let c = 0; c < 3; c++) {
        const pixel = rgb[srcIdx + c] / 255.0;
        const normalized =
          (pixel - activeModel.imageMean[c]) / activeModel.imageStd[c];
        floatData[c * pixelsPerChannel + y * imageSize + x] = normalized;
      }
    }
  }
  return floatData;
}

// --- Init handler: load SigLIP vision ONNX model directly ---
async function handleInit(msg) {
  const { modelPath } = msg;
  activeModel = MODEL_CONFIGS.siglip;
  const intraOpNumThreads = Math.max(
    1,
    Number.parseInt(
      String(msg.intraOpNumThreads || process.env.AI_EMBED_THREADS || "1"),
      10
    ) || 1
  );
  const onnxPath = path.join(
    modelPath,
    "Xenova",
    activeModel.directory,
    "onnx",
    "vision_model_quantized.onnx"
  );
  console.error(
    `[Worker] Loading ${activeModel.displayName} vision ONNX: ${onnxPath}`
  );

  // Phase 1: load onnxruntime binding (~10%)
  process.send?.({
    type: "init-progress",
    percent: 5,
    stage: "loading-runtime",
  });
  const { InferenceSession } = loadOrt();

  // NOTE: DML crashes on ViT-B/32 (0xFFFF0003) in both onnxruntime 1.26.0
  // and 1.27.0-dev. Keep CPU-only until upstream fixes DML shader compilation
  // for Transformer models (LayerNorm/Gelu/MultiHeadAttention ops).
  const executionProviders = ["cpu"];
  console.error(
    `[Worker] Creating session with: [cpu], intraOpNumThreads=${intraOpNumThreads}, sharpThreads=${sharpThreads}`
  );

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
    executionMode: "sequential",
    interOpNumThreads: 1,
    intraOpNumThreads,
  });
  console.error(
    `[Worker] ${activeModel.displayName} loaded, ready for batches`
  );

  process.send?.({ type: "init-progress", percent: 100, stage: "ready" });
  process.send?.({ type: "ready" });
}

function getImageEmbedding(output) {
  const imageEmbedding = output[activeModel.imageOutputName];
  if (!imageEmbedding) {
    throw new Error(
      `${activeModel.displayName} output "${activeModel.imageOutputName}" missing`
    );
  }
  return imageEmbedding;
}

// --- Embed handler: process a batch ---
async function handleEmbed(msg) {
  const { photos, modelPath } = msg;

  // Auto-init if model not loaded yet
  if (!ortSession && modelPath) {
    await handleInit({ modelPath, modelKind: msg.modelKind });
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

  const ort = loadOrt();
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
      const floatData = await preprocessSigLIP(imageInput);
      const pixelValues = new ort.Tensor("float32", floatData, [
        1,
        3,
        activeModel.imageSize,
        activeModel.imageSize,
      ]);
      const output = await ortSession.run({ pixel_values: pixelValues });

      const imageEmbeds = getImageEmbedding(output);
      const vec = Array.from(imageEmbeds.data);
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
      process.send?.({ type: "init-error", error: err.message });
    }
  }
});
