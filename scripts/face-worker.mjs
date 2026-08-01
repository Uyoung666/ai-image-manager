/**
 * Face detection + embedding worker.
 *
 * Runs as a child process via fork(). Two model kinds (set by the `kind`
 * field of the "init" message):
 *   - "yunet-sface"   (default): YuNet detection (640x640, BGR) + SFace
 *                      embedding (112x112, 128-d, 5-point landmark alignment)
 *   - "ultraface-w600k" (legacy): UltraFace detection + w600k_r50 ArcFace
 *                      embedding (512-d, bbox-center crop)
 *   - sharp for image preprocessing
 *
 * IPC Protocol:
 *   Parent sends: { type: "init", modelsDir, useGPU, kind }
 *                 { type: "detect", photos: [{ id, path }, ...] }
 *   Worker sends: { type: "ready" | "init-progress" }
 *                 { type: "result", results: [{ id, faces: [{ faceIndex, bbox, confidence, embedding }] }] }
 */

import fs from "node:fs";
// --- ONNX Runtime (native Node.js binding for speed) ---
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { extractRawPreview } from "./raw-preview.mjs";
import {
  solveSimilarityTransform,
  warpSimilarity,
  ARCFACE_TARGET_POINTS,
} from "./face-alignment.mjs";
import { postProcessYuNet } from "./face-yunet-postprocess.mjs";
import { rgbToNCHW } from "./face-preprocess.mjs";

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

// --- Model kind (set by init message; matches src/services/ai/face-model-config.ts) ---
let activeKind = "yunet-sface"; // "yunet-sface" | "ultraface-w600k"

// --- UltraFace + w600k (legacy kind) constants ---
const ULTRAFACE_INPUT_W = 320;
const ULTRAFACE_INPUT_H = 240;
const ULTRAFACE_CONFIDENCE = 0.85;
const ULTRAFACE_IOU = 0.3;

// --- YuNet + SFace (new kind) constants ---
// YuNet 2023mar has a FIXED 640x640 input (verified via onnxruntime).
// SFace expects 0-255 RGB; normalization is inside the graph.
const YUNET_INPUT_SIZE = 640;
// Open Images validation showed that 0.5 creates too many non-face detections
// in photo archives. 0.85 is the precision-first application operating point.
const YUNET_CONFIDENCE = 0.85;
const YUNET_IOU = 0.3;

// --- Shared constants ---
const MAX_FACES_PER_IMAGE = 20;
const MIN_FACE_SIZE = 40; // minimum face width/height in pixels
const EMBED_SIZE = 112; // SFace / ArcFace both expect 112x112 input

/**
 * Load ONNX models for detection and embedding.
 * Reports init-progress messages so the UI can show real loading progress.
 */
async function initModels(modelsDir, useGPU = false, kind = "yunet-sface") {
  activeKind = kind === "ultraface-w600k" ? kind : "yunet-sface";
  const { InferenceSession } = await loadOrt();

  const isNew = activeKind !== "ultraface-w600k";
  const detModelPath = path.join(
    modelsDir,
    "face",
    isNew ? "face_detection_yunet_2023mar.onnx" : "ultraface-320.onnx"
  );
  const embModelPath = path.join(
    modelsDir,
    "face",
    isNew ? "face_recognition_sface_2021dec.onnx" : "w600k_r50.onnx"
  );

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
    .resize(ULTRAFACE_INPUT_W, ULTRAFACE_INPUT_H, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixels = ULTRAFACE_INPUT_W * ULTRAFACE_INPUT_H;
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
 * Run UltraFace detection on a single image (legacy kind).
 * Returns array of { bbox: {x, y, width, height}, confidence }.
 */
async function detectFacesUltraFace(input) {
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
    ULTRAFACE_INPUT_H,
    ULTRAFACE_INPUT_W,
  ]);

  const feeds = {};
  feeds[detectionSession.inputNames[0]] = inputTensor;

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
    if (confidence < ULTRAFACE_CONFIDENCE) {
      continue;
    }

    // Boxes are in [x1, y1, x2, y2] normalized format
    candidateBoxes.push([
      boxesData[i * 4],
      boxesData[i * 4 + 1],
      boxesData[i * 4 + 2],
      boxesData[i * 4 + 3],
    ]);
    candidateScores.push(confidence);
  }

  if (candidateBoxes.length === 0) {
    return [];
  }

  // Apply NMS
  const kept = nms(candidateBoxes, candidateScores, ULTRAFACE_IOU);

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
 * Run YuNet detection on a single image (new kind).
 * Resizes to the fixed 640x640 input (BGR 0-255), decodes the FPN outputs
 * (cls/obj/bbox/kps at strides 8/16/32) and applies NMS. Coordinates are
 * mapped back to the original image.
 * Returns array of { bbox, confidence, landmarks } (landmarks: 5x2, [右眼,左眼,鼻尖,右嘴角,左嘴角]).
 */
async function detectFacesYunet(input) {
  const { Tensor } = await loadOrt();

  const meta = await sharp(input, { failOn: "none" }).rotate().metadata();
  const imgW = meta.width || 0;
  const imgH = meta.height || 0;
  if (imgW < 32 || imgH < 32) {
    return [];
  }

  const { data } = await sharp(input, { failOn: "none" })
    .rotate()
    .removeAlpha()
    .resize(YUNET_INPUT_SIZE, YUNET_INPUT_SIZE, { fit: "fill" })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  // YuNet expects BGR (OpenCV blobFromImage default swapRB=false)
  const floatData = rgbToNCHW(rgb, YUNET_INPUT_SIZE, YUNET_INPUT_SIZE, {
    swapRB: true,
  });

  const output = await detectionSession.run({
    [detectionSession.inputNames[0]]: new Tensor("float32", floatData, [
      1,
      3,
      YUNET_INPUT_SIZE,
      YUNET_INPUT_SIZE,
    ]),
  });

  const faces = postProcessYuNet(output, YUNET_INPUT_SIZE, {
    scoreThreshold: YUNET_CONFIDENCE,
    nmsThreshold: YUNET_IOU,
    topK: MAX_FACES_PER_IMAGE,
  });

  const scaleX = imgW / YUNET_INPUT_SIZE;
  const scaleY = imgH / YUNET_INPUT_SIZE;

  return faces
    .map((f) => ({
      bbox: {
        x: Math.max(0, Math.round(f.x1 * scaleX)),
        y: Math.max(0, Math.round(f.y1 * scaleY)),
        width: Math.round(f.w * scaleX),
        height: Math.round(f.h * scaleY),
      },
      confidence: f.score,
      landmarks: f.landmarks.map(([lx, ly]) => [lx * scaleX, ly * scaleY]),
    }))
    .filter(
      (f) => f.bbox.width >= MIN_FACE_SIZE && f.bbox.height >= MIN_FACE_SIZE
    );
}

/**
 * Dispatch to the active model kind.
 * Returns array of { bbox, confidence, landmarks? }.
 */
async function detectFacesInImage(input) {
  if (activeKind !== "ultraface-w600k") {
    return detectFacesYunet(input);
  }
  return detectFacesUltraFace(input);
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
  if (vec.length !== 512) {
    throw new Error(`Legacy embedding dimension mismatch: expected 512, got ${vec.length}`);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}

/**
 * Crop a bbox region from a full-frame raw RGB buffer and resize to EMBED_SIZE.
 * Returns EMBED_SIZE x EMBED_SIZE interleaved RGB Uint8Array, or null on a
 * degenerate crop.
 */
async function cropBboxFromRaw(rawRgb, imgW, imgH, bbox) {
  const expand = 0.2;
  const expandW = bbox.width * expand;
  const expandH = bbox.height * expand;
  const left = Math.max(0, Math.round(bbox.x - expandW));
  const top = Math.max(0, Math.round(bbox.y - expandH));
  const width = Math.min(imgW - left, Math.round(bbox.width + expandW * 2));
  const height = Math.min(imgH - top, Math.round(bbox.height + expandH * 2));
  if (width < 20 || height < 20) {
    return null;
  }

  const crop = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    const srcStart = (top + y) * imgW * 3 + left * 3;
    crop.set(rawRgb.subarray(srcStart, srcStart + width * 3), y * width * 3);
  }

  const resized = await sharp(
    Buffer.from(crop.buffer, crop.byteOffset, crop.byteLength),
    { raw: { width, height, channels: 3 } }
  )
    .resize(EMBED_SIZE, EMBED_SIZE, { fit: "fill" })
    .raw()
    .toBuffer();
  return new Uint8Array(resized.buffer, resized.byteOffset, resized.byteLength);
}

/**
 * Run SFace embedding on a 112x112 interleaved RGB crop.
 * SFace expects 0-255 RGB with normalization inside the graph; output is 128-d
 * and L2-normalized here (matching OpenCV match()'s normalize step).
 */
async function generateEmbeddingSFace(alignedRgb) {
  if (!embeddingSession) {
    return null;
  }
  const { Tensor } = await loadOrt();
  const floatData = rgbToNCHW(alignedRgb, EMBED_SIZE, EMBED_SIZE); // RGB, no swap
  const tensor = new Tensor("float32", floatData, [
    1,
    3,
    EMBED_SIZE,
    EMBED_SIZE,
  ]);
  const out = await embeddingSession.run({
    [embeddingSession.inputNames[0]]: tensor,
  });
  const vec = Array.from(out[embeddingSession.outputNames[0]].data);
  if (vec.length !== 128) {
    throw new Error(`SFace embedding dimension mismatch: expected 128, got ${vec.length}`);
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  return vec.map((v) => v / (norm || 1));
}

/**
 * Embed a detected face using 5-point landmark alignment + SFace (new kind).
 * Falls back to a bbox-center crop when landmarks are unavailable/invalid.
 */
async function generateEmbeddingAligned(rawRgb, imgW, imgH, face) {
  const { landmarks, bbox } = face;
  let aligned = null;

  if (landmarks && landmarks.length === 5) {
    try {
      const T = solveSimilarityTransform(landmarks, ARCFACE_TARGET_POINTS);
      if (Number.isFinite(T.a) && Math.abs(T.a * T.d - T.b * T.c) > 1e-9) {
        aligned = warpSimilarity(rawRgb, imgW, imgH, T, EMBED_SIZE);
      }
    } catch {
      aligned = null;
    }
  }
  if (!aligned) {
    aligned = await cropBboxFromRaw(rawRgb, imgW, imgH, bbox);
  }
  if (!aligned) {
    return null;
  }
  return generateEmbeddingSFace(aligned);
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

  const isNew = activeKind !== "ultraface-w600k";

  const faces = await detectFacesInImage(imageInput);
  if (faces.length === 0) {
    return { id: photo.id, faces: [] };
  }

  // New kind: decode the full image once so all faces can be alignment-warped
  // from shared raw pixels (avoids per-face re-decoding).
  let rawRgb = null;
  let imgW = 0;
  let imgH = 0;
  if (isNew) {
    try {
      const { data, info } = await sharp(imageInput, { failOn: "none" })
        .rotate()
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      rawRgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      imgW = info.width;
      imgH = info.height;
    } catch (err) {
      console.error(`[FaceWorker] Full-decode failed: ${err.message}`);
    }
  }

  const results = [];
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    let embedding = null;
    try {
      if (isNew && rawRgb) {
        embedding = await generateEmbeddingAligned(rawRgb, imgW, imgH, face);
      } else {
        embedding = await generateEmbedding(imageInput, face.bbox);
      }
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
      const { modelsDir: md, useGPU, kind } = msg;
      modelsDir = md || path.join(process.cwd(), "models");
      try {
        await initModels(modelsDir, useGPU, kind);
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
