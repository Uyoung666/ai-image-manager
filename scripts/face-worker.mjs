/**
 * Face detection + embedding worker.
 *
 * Runs as a child process via fork(). Uses:
 *   - UltraFace ONNX model for face detection (confidence-based)
 *   - ArcFace ONNX model for face embedding (128-d vectors for clustering)
 *   - sharp for image preprocessing
 *
 * IPC Protocol:
 *   Parent sends: { type: "detect", photos: [{ id, path }, ...], modelsDir: "..." }
 *   Worker sends: { type: "result", results: [{ id, faces: [{ faceIndex, bbox, confidence, embedding }] }] }
 *   Then worker exits with code 0.
 */

import fs from "node:fs";
// --- ONNX Runtime (native Node.js binding for speed) ---
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { extractRawPreview } from "./raw-preview.mjs";

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

let ort = null;

async function loadOrt() {
  if (ort) {
    return ort;
  }
  // onnxruntime-node is CJS, use createRequire for reliable import in ESM
  const require = createRequire(import.meta.url);
  try {
    ort = require("onnxruntime-node");
  } catch (err) {
    // Fallback: try from project root node_modules
    const projectRoot = path.resolve(
      path.dirname(
        new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")
      ),
      ".."
    );
    const ortPath = path.join(projectRoot, "node_modules", "onnxruntime-node");
    ort = require(ortPath);
  }
  return ort;
}

// --- Model sessions (loaded once) ---
let detectionSession = null;
let embeddingSession = null;

// --- Abort flag for mid-batch cancellation ---
let aborted = false;

// --- UltraFace constants ---
const DET_INPUT_W = 320;
const DET_INPUT_H = 240;
const CONFIDENCE_THRESHOLD = 0.85;
const IOU_THRESHOLD = 0.3;
const MAX_FACES_PER_IMAGE = 20;
const MIN_FACE_SIZE = 40; // minimum face width/height in pixels

// --- ArcFace constants ---
const EMBED_SIZE = 112; // ArcFace expects 112x112 input

/**
 * Load ONNX models for detection and embedding.
 * Reports init-progress messages so the UI can show real loading progress.
 */
async function initModels(modelsDir, useGPU = false) {
  const { InferenceSession } = await loadOrt();

  const detModelPath = path.join(modelsDir, "face", "ultraface-320.onnx");
  const embModelPath = path.join(modelsDir, "face", "w600k_r50.onnx");

  if (!fs.existsSync(detModelPath)) {
    throw new Error(`Detection model not found: ${detModelPath}`);
  }

  // Phase 1: loading runtime + detection model (~10%)
  process.send?.({
    type: "init-progress",
    percent: 5,
    stage: "loading-runtime",
  });

  // Track whether DirectML is actually active — we can't query the session
  // after creation, so we must remember the probe result.
  let dmlActive = false;

  if (useGPU) {
    // --- Probe DML availability with a DML-only session ---
    // The fallback list ["dml","cpu"] silently drops DML on failure, making
    // it impossible to know whether GPU acceleration is actually in use.
    // By trying DML-only first we get an explicit error when DML is broken.
    try {
      detectionSession = await InferenceSession.create(detModelPath, {
        executionProviders: ["dml"],
        logSeverityLevel: 3,
      });
      console.error("[FaceWorker] ✓ DirectML GPU ACTIVE");
      dmlActive = true;
    } catch (err) {
      console.error(`[FaceWorker] ✗ DirectML unavailable: ${err.message}`);
      console.error("[FaceWorker] Falling back to CPU");

      detectionSession = await InferenceSession.create(detModelPath, {
        executionProviders: ["cpu"],
        logSeverityLevel: 3,
      });
    }
  } else {
    console.error("[FaceWorker] GPU disabled — using CPU");
    detectionSession = await InferenceSession.create(detModelPath, {
      executionProviders: ["cpu"],
      logSeverityLevel: 3,
    });
  }
  console.error(`[FaceWorker] Detection model loaded: ${detModelPath}`);

  // Phase 2: detection model ready, now load embedding model (~45%)
  process.send?.({
    type: "init-progress",
    percent: 45,
    stage: "loading-embedding",
  });

  if (fs.existsSync(embModelPath)) {
    if (dmlActive) {
      try {
        embeddingSession = await InferenceSession.create(embModelPath, {
          executionProviders: ["dml"],
          logSeverityLevel: 3,
        });
        console.error("[FaceWorker] ✓ Embedding model DML ACTIVE");
      } catch (err) {
        console.error(
          `[FaceWorker] Embedding DML failed, CPU fallback: ${err.message}`
        );
        embeddingSession = await InferenceSession.create(embModelPath, {
          executionProviders: ["cpu"],
          logSeverityLevel: 3,
        });
      }
    } else {
      embeddingSession = await InferenceSession.create(embModelPath, {
        executionProviders: ["cpu"],
        logSeverityLevel: 3,
      });
    }
    console.error(`[FaceWorker] Embedding model loaded: ${embModelPath}`);
  } else {
    console.error(
      `[FaceWorker] Embedding model not found, skipping: ${embModelPath}`
    );
  }

  process.send?.({ type: "init-progress", percent: 100, stage: "ready" });
}

/**
 * Preprocess image for UltraFace detection.
 * Input: 320x240 RGB, normalized to [0,1], NCHW layout.
 */
async function preprocessForDetection(input) {
  const { data, info } = await sharp(input, { failOn: "none" })
    .rotate()
    .resize(DET_INPUT_W, DET_INPUT_H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixels = DET_INPUT_W * DET_INPUT_H;
  const floatData = new Float32Array(3 * pixels);

  // NCHW layout, normalize to [0, 1] with mean subtraction
  const mean = [127.0, 127.0, 127.0];
  const div = 128.0;
  for (let i = 0; i < pixels; i++) {
    floatData[i] = (rgb[i * 3] - mean[0]) / div;
    floatData[pixels + i] = (rgb[i * 3 + 1] - mean[1]) / div;
    floatData[2 * pixels + i] = (rgb[i * 3 + 2] - mean[2]) / div;
  }

  return floatData;
}

/**
 * Non-Maximum Suppression to remove overlapping detections.
 */
function nms(boxes, scores, iouThreshold) {
  const indices = scores.map((s, i) => i).sort((a, b) => scores[b] - scores[a]);

  const kept = [];
  const suppressed = new Set();

  for (let pos = 0; pos < indices.length; pos++) {
    const i = indices[pos];
    if (suppressed.has(i)) {
      continue;
    }
    kept.push(i);

    for (let pos2 = pos + 1; pos2 < indices.length; pos2++) {
      const j = indices[pos2];
      if (suppressed.has(j)) {
        continue;
      }
      const iou = computeIoU(boxes[i], boxes[j]);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }
  return kept;
}

function computeIoU(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = (a[2] - a[0]) * (a[3] - a[1]);
  const areaB = (b[2] - b[0]) * (b[3] - b[1]);
  return inter / (areaA + areaB - inter + 1e-6);
}

/**
 * Run UltraFace detection on a single image.
 * Returns array of { bbox: {x, y, width, height}, confidence }.
 */
async function detectFacesInImage(input) {
  const { Tensor } = await loadOrt();

  const meta = await sharp(input, { failOn: "none" }).rotate().metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (imgW < 32 || imgH < 32) {
    return [];
  }

  const inputData = await preprocessForDetection(input);
  const inputTensor = new Tensor("float32", inputData, [
    1,
    3,
    DET_INPUT_H,
    DET_INPUT_W,
  ]);

  const feeds = {};
  const inputNames = detectionSession.inputNames;
  feeds[inputNames[0]] = inputTensor;

  const output = await detectionSession.run(feeds);
  const outputNames = detectionSession.outputNames;

  // UltraFace outputs: scores [1, N, 2] and boxes [1, N, 4]
  const scoresData = output[outputNames[0]].data;
  const boxesData = output[outputNames[1]].data;
  const numAnchors = scoresData.length / 2;

  const candidateBoxes = [];
  const candidateScores = [];

  for (let i = 0; i < numAnchors; i++) {
    const confidence = scoresData[i * 2 + 1]; // face confidence
    if (confidence < CONFIDENCE_THRESHOLD) {
      continue;
    }

    // Boxes are in [x1, y1, x2, y2] normalized format
    const x1 = boxesData[i * 4];
    const y1 = boxesData[i * 4 + 1];
    const x2 = boxesData[i * 4 + 2];
    const y2 = boxesData[i * 4 + 3];

    candidateBoxes.push([x1, y1, x2, y2]);
    candidateScores.push(confidence);
  }

  if (candidateBoxes.length === 0) {
    return [];
  }

  // Apply NMS
  const kept = nms(candidateBoxes, candidateScores, IOU_THRESHOLD);

  return kept
    .slice(0, MAX_FACES_PER_IMAGE)
    .map((idx) => {
      const [x1, y1, x2, y2] = candidateBoxes[idx];
      return {
        bbox: {
          x: Math.max(0, Math.round(x1 * imgW)),
          y: Math.max(0, Math.round(y1 * imgH)),
          width: Math.round((x2 - x1) * imgW),
          height: Math.round((y2 - y1) * imgH),
        },
        confidence: candidateScores[idx],
      };
    })
    .filter(
      (f) => f.bbox.width >= MIN_FACE_SIZE && f.bbox.height >= MIN_FACE_SIZE
    );
}

/**
 * Generate face embedding using ArcFace model.
 * Crops the face region, resizes to 112x112, normalizes, and runs inference.
 */
async function generateEmbedding(input, bbox) {
  if (!embeddingSession) {
    return null;
  }

  const { Tensor } = await loadOrt();

  // Expand bbox by 20% for better face coverage
  const expand = 0.2;
  const meta = await sharp(input, { failOn: "none" }).rotate().metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;

  const expandW = bbox.width * expand;
  const expandH = bbox.height * expand;
  const left = Math.max(0, Math.round(bbox.x - expandW));
  const top = Math.max(0, Math.round(bbox.y - expandH));
  const width = Math.min(imgW - left, Math.round(bbox.width + expandW * 2));
  const height = Math.min(imgH - top, Math.round(bbox.height + expandH * 2));

  if (width < 20 || height < 20) {
    return null;
  }

  const { data } = await sharp(input, { failOn: "none" })
    .rotate()
    .extract({ left, top, width, height })
    .resize(EMBED_SIZE, EMBED_SIZE, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixels = EMBED_SIZE * EMBED_SIZE;
  const floatData = new Float32Array(3 * pixels);

  // ArcFace normalization: (pixel - 127.5) / 127.5
  for (let i = 0; i < pixels; i++) {
    floatData[i] = (rgb[i * 3] - 127.5) / 127.5;
    floatData[pixels + i] = (rgb[i * 3 + 1] - 127.5) / 127.5;
    floatData[2 * pixels + i] = (rgb[i * 3 + 2] - 127.5) / 127.5;
  }

  const inputTensor = new Tensor("float32", floatData, [
    1,
    3,
    EMBED_SIZE,
    EMBED_SIZE,
  ]);
  const feeds = {};
  feeds[embeddingSession.inputNames[0]] = inputTensor;

  const output = await embeddingSession.run(feeds);
  const embeddingData = output[embeddingSession.outputNames[0]].data;

  // L2 normalize
  const vec = Array.from(embeddingData);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}

/**
 * Process a single photo: detect faces + generate embeddings.
 */
async function processPhoto(photo) {
  // Resolve input: for RAW files, extract embedded JPEG preview
  let imageInput = photo.path;
  if (isRawFile(photo.path)) {
    const preview = extractRawPreview(photo.path);
    if (preview) {
      imageInput = preview;
    }
  }

  const faces = await detectFacesInImage(imageInput);
  if (faces.length === 0) {
    return { id: photo.id, faces: [] };
  }

  const results = [];
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    let embedding = null;
    try {
      embedding = await generateEmbedding(imageInput, face.bbox);
    } catch (err) {
      console.error(
        `[FaceWorker] Embedding failed for face ${i}: ${err.message}`
      );
    }
    results.push({
      faceIndex: i,
      bbox: face.bbox,
      confidence: face.confidence,
      embedding,
    });
  }

  return { id: photo.id, faces: results };
}

// --- Persistent IPC handler ---
// Model is loaded once per worker lifecycle via "init" message.
// Multiple "detect" batches are processed without reloading models.
// Worker stays alive until "shutdown" is received.
const WORKER_TIMEOUT_MS = 300_000; // 5 minutes max per batch
let modelsDir = null;
let modelsReady = false;

process.on("message", async (msg) => {
  try {
    if (msg.type === "init") {
      const { modelsDir: md, useGPU } = msg;
      modelsDir = md || path.join(process.cwd(), "models");
      try {
        await initModels(modelsDir, useGPU);
        modelsReady = true;
        process.send?.({ type: "ready" });
      } catch (err) {
        console.error(`[FaceWorker] Model init failed: ${err.message}`);
        process.send?.({ type: "ready", error: err.message });
      }
      return;
    }

    if (msg.type === "abort") {
      aborted = true;
      console.error("[FaceWorker] Abort signal received");
      return;
    }

    if (msg.type === "shutdown") {
      console.error("[FaceWorker] Shutting down");
      process.exit(0);
    }

    if (msg.type !== "detect") {
      return;
    }

    if (!modelsReady) {
      process.send?.({
        type: "result",
        results: msg.photos.map((p) => ({ id: p.id, faces: [] })),
        error: "Models not initialized",
      });
      return;
    }

    const { photos } = msg;
    if (!photos?.length) {
      process.send?.({ type: "result", results: [] });
      return;
    }

    const batchTimeout = setTimeout(() => {
      console.error("[FaceWorker] Batch timeout reached");
      process.send?.({
        type: "result",
        results: photos.map((p) => ({ id: p.id, faces: [] })),
        error: "Batch timeout",
      });
    }, WORKER_TIMEOUT_MS);

    console.error(`[FaceWorker] Processing ${photos.length} photos`);
    const batchStartMs = Date.now();

    const PER_PHOTO_TIMEOUT_MS = 60_000;
    const results = [];

    // Reset abort flag for new batch
    aborted = false;

    for (let i = 0; i < photos.length; i++) {
      // Check for abort signal before processing each photo
      if (aborted) {
        console.error(`[FaceWorker] Aborted at photo ${i}/${photos.length}`);
        break;
      }
      const photo = photos[i];
      try {
        const result = await Promise.race([
          processPhoto(photo),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error("per-photo timeout")),
              PER_PHOTO_TIMEOUT_MS
            )
          ),
        ]);
        results.push(result);
        if (result.faces.length > 0) {
          console.error(
            `[FaceWorker] ${i + 1}/${photos.length}: ${path.basename(photo.path)} — ${result.faces.length} face(s)`
          );
        }
      } catch (err) {
        console.error(
          `[FaceWorker] ${i + 1}/${photos.length} FAIL: ${photo.path} — ${err.message}`
        );
        results.push({ id: photo.id, faces: [] });
      }
    }

    const totalFaces = results.reduce((s, r) => s + r.faces.length, 0);
    const batchMs = Date.now() - batchStartMs;
    console.error(
      `[FaceWorker] Done: ${totalFaces} faces in ${results.length} photos | ${batchMs}ms (${Math.round(batchMs / results.length)}ms/photo)`
    );

    clearTimeout(batchTimeout);
    process.send?.({ type: "result", results });
  } catch (err) {
    console.error(
      `[FaceWorker] Fatal error handling "${msg.type}":`,
      err.message
    );
    if (msg.type === "detect") {
      process.send?.({
        type: "result",
        results: (msg.photos || []).map((p) => ({ id: p.id, faces: [] })),
        error: err.message,
      });
    } else if (msg.type === "init") {
      process.send?.({ type: "ready", error: err.message });
    }
  }
});
