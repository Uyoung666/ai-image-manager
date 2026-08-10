/**
 * Face detection + embedding worker.
 *
 * Runs as a child process via fork(). The product runtime uses YuNet
 * detection (640x640, BGR) + SFace embedding (112x112, 128-d, 5-point
 * landmark alignment).
 *   - sharp for image preprocessing
 *
 * IPC Protocol:
 *   Parent sends: { type: "init", modelsDir, useGPU }
 *                 { type: "detect", requestId, photos: [{ id, path }, ...] }
 *   Worker sends: { type: "ready" | "init-progress" }
 *                 { type: "result", requestId, results: [{ id, faces: [{ faceIndex, bbox, confidence, embedding }] }] }
 */

import fs from "node:fs";
// --- ONNX Runtime (native Node.js binding for speed) ---
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import {
  ARCFACE_TARGET_POINTS,
  solveSimilarityTransform,
  warpSimilarity,
} from "./face-alignment.mjs";
import { mapYuNetBoxToImage, normalizeImageInput } from "./face-image.mjs";
import { rgbToNCHW } from "./face-preprocess.mjs";
import { postProcessYuNet } from "./face-yunet-postprocess.mjs";
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
const WINDOWS_DRIVE_PREFIX_PATTERN = /^\/([A-Z]:)/;

function isRawFile(filePath) {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

let ort = null;

function loadOrt() {
  if (ort) {
    return ort;
  }
  // onnxruntime-node is CJS, use createRequire for reliable import in ESM
  const require = createRequire(import.meta.url);
  try {
    ort = require("onnxruntime-node");
  } catch (_err) {
    // Fallback: try from project root node_modules
    const projectRoot = path.resolve(
      path.dirname(
        new URL(import.meta.url).pathname.replace(
          WINDOWS_DRIVE_PREFIX_PATTERN,
          "$1"
        )
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

// --- YuNet + SFace (new kind) constants ---
// YuNet 2023mar has a FIXED 640x640 input (verified via onnxruntime).
// SFace expects 0-255 RGB; normalization is inside the graph.
const YUNET_INPUT_SIZE = 640;
// Retain candidates from 0.5 for human review. The main process still only
// auto-groups detections at its configured 0.85 confidence filter.
const YUNET_CONFIDENCE = 0.5;
const YUNET_IOU = 0.3;

// --- Shared constants ---
const MAX_FACES_PER_IMAGE = 20;
const MIN_FACE_SIZE = 40; // minimum face width/height in pixels
const EMBED_SIZE = 112; // SFace / ArcFace both expect 112x112 input

/**
 * Load ONNX models for detection and embedding.
 * Reports init-progress messages so the UI can show real loading progress.
 */
async function initModels(modelsDir, useGPU = false) {
  const { InferenceSession } = await loadOrt();

  const detModelPath = path.join(
    modelsDir,
    "face",
    "face_detection_yunet_2023mar.onnx"
  );
  const embModelPath = path.join(
    modelsDir,
    "face",
    "face_recognition_sface_2021dec.onnx"
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
 * Run YuNet detection on a single image (new kind).
 * Resizes to the fixed 640x640 input (BGR 0-255), decodes the FPN outputs
 * (cls/obj/bbox/kps at strides 8/16/32) and applies NMS. Coordinates are
 * mapped back to the original image.
 * Returns array of { bbox, confidence, landmarks } (landmarks: 5x2, [右眼,左眼,鼻尖,右嘴角,左嘴角]).
 */
async function detectFacesYunet(image) {
  const { Tensor } = await loadOrt();

  const imgW = image.width;
  const imgH = image.height;
  if (imgW < 32 || imgH < 32) {
    return [];
  }

  const inputBuffer = Buffer.from(
    image.data.buffer,
    image.data.byteOffset,
    image.data.byteLength
  );
  const { data } = await sharp(inputBuffer, {
    raw: { channels: 3, height: imgH, width: imgW },
  })
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
    .map((f) => {
      const bbox = mapYuNetBoxToImage(f, imgW, imgH, YUNET_INPUT_SIZE);
      if (!bbox) {
        return null;
      }
      return {
        bbox,
        confidence: f.score,
        landmarks: f.landmarks.map(([lx, ly]) => [lx * scaleX, ly * scaleY]),
      };
    })
    .filter(
      (f) =>
        f !== null &&
        f.bbox.width >= MIN_FACE_SIZE &&
        f.bbox.height >= MIN_FACE_SIZE
    );
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
    throw new Error(
      `SFace embedding dimension mismatch: expected 128, got ${vec.length}`
    );
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

  const normalizedImage = await normalizeImageInput(imageInput, photo.path);
  const faces = await detectFacesYunet(normalizedImage);
  if (faces.length === 0) {
    return {
      id: photo.id,
      width: normalizedImage.width,
      height: normalizedImage.height,
      faces: [],
    };
  }

  // Decode the full image once so all faces can be alignment-warped
  // from shared raw pixels (avoids per-face re-decoding).
  const rawRgb = normalizedImage.data;
  const imgW = normalizedImage.width;
  const imgH = normalizedImage.height;

  const results = [];
  for (let i = 0; i < faces.length; i++) {
    const face = faces[i];
    let embedding = null;
    try {
      if (rawRgb) {
        embedding = await generateEmbeddingAligned(rawRgb, imgW, imgH, face);
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

  return {
    id: photo.id,
    width: imgW,
    height: imgH,
    faces: results,
  };
}

// --- Persistent IPC handler ---
// Model is loaded once per worker lifecycle via "init" message.
// Multiple "detect" batches are processed without reloading models.
// Worker stays alive until "shutdown" is received.
const WORKER_TIMEOUT_MS = 300_000; // 5 minutes max per batch
let modelsDir = null;
let modelsReady = false;

async function handleInitMessage(msg) {
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
}

async function processDetectBatch(photos, requestId) {
  const results = [];
  let resultSent = false;
  const sendResult = (batchResults, error) => {
    if (resultSent) {
      return;
    }
    resultSent = true;
    process.send?.({
      type: "result",
      requestId,
      results: batchResults,
      ...(error ? { error } : {}),
    });
  };
  const batchTimeout = setTimeout(() => {
    console.error("[FaceWorker] Batch timeout reached");
    aborted = true;
    sendResult(
      photos.map((p) => ({ id: p.id, faces: [] })),
      "Batch timeout"
    );
  }, WORKER_TIMEOUT_MS);

  console.error(`[FaceWorker] Processing ${photos.length} photos`);
  const batchStartMs = Date.now();
  const PER_PHOTO_TIMEOUT_MS = 60_000;
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
      results.push({ id: photo.id, faces: [], error: err.message });
    }
  }

  const totalFaces = results.reduce((s, r) => s + r.faces.length, 0);
  const batchMs = Date.now() - batchStartMs;
  console.error(
    `[FaceWorker] Done: ${totalFaces} faces in ${results.length} photos | ${batchMs}ms (${Math.round(batchMs / results.length)}ms/photo)`
  );

  clearTimeout(batchTimeout);
  sendResult(results);
}

async function handleDetectMessage(msg) {
  if (!modelsReady) {
    process.send?.({
      type: "result",
      requestId: msg.requestId,
      results: msg.photos.map((p) => ({ id: p.id, faces: [] })),
      error: "Models not initialized",
    });
    return;
  }

  const { photos } = msg;
  if (!photos?.length) {
    process.send?.({ type: "result", requestId: msg.requestId, results: [] });
    return;
  }

  await processDetectBatch(photos, msg.requestId);
}

async function handleWorkerMessage(msg) {
  if (msg.type === "init") {
    await handleInitMessage(msg);
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

  if (msg.type === "detect") {
    await handleDetectMessage(msg);
  }
}

function reportWorkerMessageError(msg, err) {
  console.error(
    `[FaceWorker] Fatal error handling "${msg.type}":`,
    err.message
  );
  if (msg.type === "detect") {
    process.send?.({
      type: "result",
      requestId: msg.requestId,
      results: (msg.photos || []).map((p) => ({ id: p.id, faces: [] })),
      error: err.message,
    });
  } else if (msg.type === "init") {
    process.send?.({ type: "ready", error: err.message });
  }
}

process.on("message", async (msg) => {
  try {
    await handleWorkerMessage(msg);
  } catch (err) {
    reportWorkerMessageError(msg, err);
  }
});
