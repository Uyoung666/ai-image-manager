/**
 * Configurable image embedding worker.
 *
 * The parent sends a complete serialized adapter. This worker intentionally
 * has no model-specific dimensions, paths, output names, or preprocessing
 * constants of its own.
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

function validateAdapter(adapter) {
  if (!adapter || adapter.protocolVersion !== 1) {
    throw new Error("Unsupported or missing worker adapter protocol");
  }
  if (
    typeof adapter.adapterId !== "string" ||
    typeof adapter.fingerprint !== "string" ||
    typeof adapter.modelRoot !== "string" ||
    !adapter.image ||
    adapter.normalization !== "l2"
  ) {
    throw new Error("Invalid serialized worker adapter");
  }
  const image = adapter.image;
  if (
    typeof image.modelRelativePath !== "string" ||
    typeof image.inputName !== "string" ||
    typeof image.outputName !== "string" ||
    !Number.isInteger(image.dimensions) ||
    image.dimensions <= 0 ||
    !Number.isInteger(image.imageSize) ||
    image.imageSize <= 0 ||
    !["fill", "contain", "cover"].includes(image.resizeFit) ||
    !Array.isArray(image.mean) ||
    !Array.isArray(image.std) ||
    image.mean.length !== 3 ||
    image.std.length !== 3 ||
    image.mean.some((value) => !Number.isFinite(value)) ||
    image.std.some((value) => !Number.isFinite(value) || value === 0)
  ) {
    throw new Error("Invalid image worker adapter configuration");
  }
  return adapter;
}

function resolveRelativeModelPath(root, relativePath) {
  const rootPath = path.resolve(root);
  const resolved = path.resolve(rootPath, relativePath);
  if (resolved !== rootPath && !resolved.startsWith(`${rootPath}${path.sep}`)) {
    throw new Error("Worker model path escapes model root");
  }
  return resolved;
}

let activeAdapter = null;
let ortSession = null;
let _ort = null;
let aborted = false;
let activeExecutionProvider = "cpu";

function loadOrt() {
  if (_ort) {
    return _ort;
  }
  try {
    _ort = require("onnxruntime-node");
  } catch (error) {
    console.error(
      "[Worker] Primary onnxruntime-node load failed:",
      error.message
    );
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

async function preprocessImage(filePath) {
  const image = activeAdapter.image;
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .rotate()
    .resize(image.imageSize, image.imageSize, {
      fit: image.resizeFit,
      position: "center",
    })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== image.imageSize || height !== image.imageSize || channels < 3) {
    throw new Error(`Image resize mismatch: ${width}x${height}x${channels}`);
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixelsPerChannel = image.imageSize * image.imageSize;
  const floatData = new Float32Array(3 * pixelsPerChannel);
  for (let y = 0; y < image.imageSize; y++) {
    for (let x = 0; x < image.imageSize; x++) {
      const sourceIndex = (y * image.imageSize + x) * channels;
      for (let channel = 0; channel < 3; channel++) {
        const pixel = rgb[sourceIndex + channel] / 255;
        floatData[channel * pixelsPerChannel + y * image.imageSize + x] =
          (pixel - image.mean[channel]) / image.std[channel];
      }
    }
  }
  return floatData;
}

async function handleInit(message) {
  activeAdapter = validateAdapter(message.adapter);
  const execution = message.execution ?? {
    provider: "cpu",
    intraOpNumThreads: 1,
  };
  const intraOpNumThreads = Math.max(
    1,
    Number.parseInt(String(execution.intraOpNumThreads || "1"), 10) || 1
  );
  const onnxPath = resolveRelativeModelPath(
    activeAdapter.modelRoot,
    activeAdapter.image.modelRelativePath
  );

  process.send?.({
    type: "init-progress",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
    percent: 5,
    stage: "loading-runtime",
  });
  const { InferenceSession } = loadOrt();
  const useDirectML = execution.provider === "directml";
  activeExecutionProvider = useDirectML ? "directml" : "cpu";
  const executionProviders = useDirectML ? ["dml"] : ["cpu"];
  process.send?.({
    type: "init-progress",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
    percent: 20,
    stage: "creating-session",
  });
  ortSession = await InferenceSession.create(onnxPath, {
    executionProviders,
    logSeverityLevel: 3,
    graphOptimizationLevel: useDirectML ? "basic" : "all",
    ...(useDirectML
      ? { enableMemPattern: false }
      : { enableCpuMemArena: true }),
    executionMode: "sequential",
    interOpNumThreads: 1,
    intraOpNumThreads: useDirectML ? 1 : intraOpNumThreads,
  });
  process.send?.({
    type: "init-progress",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
    percent: 100,
    stage: "ready",
  });
  process.send?.({
    type: "ready",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
    provider: activeExecutionProvider,
  });
}

function normalizeVector(rawVector) {
  if (
    !Array.isArray(rawVector) ||
    rawVector.length !== activeAdapter.image.dimensions ||
    rawVector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Invalid image vector: expected ${activeAdapter.image.dimensions} finite values`
    );
  }
  const norm = Math.sqrt(
    rawVector.reduce((sum, value) => sum + value * value, 0)
  );
  const vector = rawVector.map((value) => value / (norm || 1));
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new Error("Image vector normalization produced non-finite values");
  }
  return vector;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Embedding keeps provider failure handling and per-photo CPU error handling in one protocol transaction.
async function handleEmbed(message) {
  const photos = Array.isArray(message.photos) ? message.photos : [];
  if (!(ortSession && activeAdapter)) {
    process.send?.({
      type: "result",
      adapterId: activeAdapter?.adapterId,
      fingerprint: activeAdapter?.fingerprint,
      results: photos.map((photo) => ({
        id: photo.id,
        error: "Model not initialized",
      })),
    });
    return;
  }

  const ort = loadOrt();
  const results = [];
  let providerError = null;
  for (const photo of photos) {
    if (aborted) {
      break;
    }
    try {
      let imageInput = photo.path;
      if (isRawFile(photo.path)) {
        imageInput = extractRawPreview(photo.path) || photo.path;
      }
      const floatData = await preprocessImage(imageInput);
      const image = activeAdapter.image;
      const pixelValues = new ort.Tensor("float32", floatData, [
        1,
        3,
        image.imageSize,
        image.imageSize,
      ]);
      const output = await ortSession.run({ [image.inputName]: pixelValues });
      const embedding = output[image.outputName];
      if (!embedding) {
        throw new Error(`Output "${image.outputName}" missing`);
      }
      const vector = normalizeVector(Array.from(embedding.data));
      for (const value of Object.values(output)) {
        value?.dispose?.();
      }
      results.push({ id: photo.id, vector });
    } catch (error) {
      if (activeExecutionProvider === "directml") {
        providerError = error instanceof Error ? error.message : String(error);
        break;
      }
      results.push({
        id: photo.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (providerError) {
    process.send?.({
      type: "provider-error",
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      error: providerError,
      provider: activeExecutionProvider,
    });
    return;
  }

  process.send?.({
    type: "result",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
    results,
  });
}

process.on("message", async (message) => {
  try {
    if (message?.type === "init") {
      await handleInit(message);
    } else if (message?.type === "embed") {
      aborted = false;
      await handleEmbed(message);
    } else if (message?.type === "abort") {
      aborted = true;
    } else if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    if (message?.type === "embed") {
      process.send?.({
        type: "result",
        adapterId: activeAdapter?.adapterId,
        fingerprint: activeAdapter?.fingerprint,
        results: (message.photos || []).map((photo) => ({
          id: photo.id,
          error: messageText,
        })),
      });
    } else if (message?.type === "init") {
      process.send?.({ type: "init-error", error: messageText });
    }
  }
});
