#!/usr/bin/env node
import { fork } from "node:child_process";
/**
 * Evaluate the application YuNet detector against an Open Images manifest.
 *
 * The manifest contains normalized Human face boxes for positive images and
 * human-verified negative Human face labels for negative images. The worker
 * still runs the application's complete detection path, including its
 * minimum-face-size filter; only the confidence threshold is swept here.
 *
 * Usage:
 *   node scripts/bench-face-detector.mjs <manifest.json>
 *     [--models-dir <dir>] [--report <file>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const DEFAULT_THRESHOLDS = [0.85, 0.9];
const IOU_THRESHOLD = 0.5;
const BATCH_SIZE = 40;
const MAX_RUNTIME_MS = 300_000;
const FACE_MODEL_FILES = [
  "face/face_detection_yunet_2023mar.onnx",
  "face/face_recognition_sface_2021dec.onnx",
];

function usageError(message) {
  return new Error(
    `${message}\nUsage: node scripts/bench-face-detector.mjs <manifest.json> [--models-dir <dir>] [--report <file>]`
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI parsing validates a small fixed option set.
function parseArgs(argv) {
  const args = [...argv];
  const manifestFile = args.shift();
  if (!manifestFile) {
    throw usageError("A manifest JSON path is required.");
  }
  let modelsDir = path.resolve("models");
  let reportFile = null;
  let thresholds = DEFAULT_THRESHOLDS;
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--models-dir") {
      const value = args.shift();
      if (!value) {
        throw usageError("--models-dir requires a directory path.");
      }
      modelsDir = path.resolve(value);
    } else if (flag === "--report") {
      const value = args.shift();
      if (!value) {
        throw usageError("--report requires a file path.");
      }
      reportFile = path.resolve(value);
    } else if (flag === "--thresholds") {
      const value = args.shift();
      if (!value) {
        throw usageError("--thresholds requires comma-separated values.");
      }
      thresholds = value
        .split(",")
        .map(Number)
        .filter((value) => Number.isFinite(value) && value >= 0 && value <= 1)
        .sort((a, b) => a - b);
      if (thresholds.length === 0) {
        throw usageError("--thresholds must contain values between 0 and 1.");
      }
    } else {
      throw usageError(`Unknown argument: ${flag}`);
    }
  }
  return {
    manifestFile: path.resolve(manifestFile),
    modelsDir,
    reportFile,
    thresholds: [...new Set(thresholds)],
  };
}

function readManifest(file) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw usageError(`Unable to read manifest: ${error.message}`);
  }
  if (
    manifest?.schemaVersion !== 1 ||
    !Array.isArray(manifest.images) ||
    manifest.images.length === 0
  ) {
    throw usageError(
      "Manifest must have schemaVersion=1 and a non-empty images array."
    );
  }
  const ids = new Set();
  const images = manifest.images.map((image) => {
    if (
      typeof image?.id !== "string" ||
      typeof image?.fileName !== "string" ||
      !["positive", "negative"].includes(image.label) ||
      !Array.isArray(image.boxes)
    ) {
      throw usageError(
        "Each manifest image needs id, fileName, label, and boxes."
      );
    }
    if (ids.has(image.id)) {
      throw usageError(`Duplicate image id: ${image.id}`);
    }
    ids.add(image.id);
    if (image.label === "negative" && image.boxes.length > 0) {
      throw usageError(`Negative image has ground-truth boxes: ${image.id}`);
    }
    return image;
  });
  if (
    !(
      images.some((image) => image.label === "positive") &&
      images.some((image) => image.label === "negative")
    )
  ) {
    throw usageError("Manifest needs both positive and negative images.");
  }
  return { ...manifest, images };
}

function resolveImagePath(manifestFile, image) {
  const root = path.dirname(manifestFile);
  const absolute = path.resolve(root, "images", image.fileName);
  const prefix = `${path.resolve(root, "images")}${path.sep}`;
  if (!(absolute.startsWith(prefix) && fs.existsSync(absolute))) {
    throw usageError(`Missing image for ${image.id}: ${absolute}`);
  }
  return absolute;
}

function loadImageMetadata(manifestFile, manifest) {
  return Promise.all(
    manifest.images.map(async (image) => {
      const file = resolveImagePath(manifestFile, image);
      const metadata = await sharp(file).metadata();
      if (!(metadata.width && metadata.height)) {
        throw usageError(`Image has no dimensions: ${file}`);
      }
      return {
        ...image,
        path: file,
        width: metadata.width,
        height: metadata.height,
      };
    })
  );
}

function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function normalizedBoxToAbsolute(box, width, height) {
  return {
    x: box.xMin * width,
    y: box.yMin * height,
    width: (box.xMax - box.xMin) * width,
    height: (box.yMax - box.yMin) * height,
  };
}

function intersectionOverUnion(left, right) {
  const leftRight = left.x + left.width;
  const leftBottom = left.y + left.height;
  const rightRight = right.x + right.width;
  const rightBottom = right.y + right.height;
  const intersectionWidth = Math.max(
    0,
    Math.min(leftRight, rightRight) - Math.max(left.x, right.x)
  );
  const intersectionHeight = Math.max(
    0,
    Math.min(leftBottom, rightBottom) - Math.max(left.y, right.y)
  );
  const intersection = intersectionWidth * intersectionHeight;
  const union =
    left.width * left.height + right.width * right.height - intersection;
  return union > 0 ? intersection / union : 0;
}

function roundMetric(value) {
  return value === null ? null : Number(value.toFixed(6));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: detection evaluation combines matching and error accounting in one pass.
function evaluateAtThreshold(images, resultsById, threshold) {
  let truePositives = 0;
  let falsePositives = 0;
  let falseNegatives = 0;
  let positiveImages = 0;
  let positiveImagesWithMatch = 0;
  let negativeImagesWithFalsePositive = 0;
  const falsePositiveExamples = [];

  for (const image of images) {
    const result = resultsById.get(image.photoId) ?? { faces: [] };
    const predictions = result.faces
      .filter((face) => face.confidence >= threshold)
      .sort((a, b) => b.confidence - a.confidence)
      .map((face) => ({
        confidence: face.confidence,
        bbox: face.bbox,
      }));
    const groundTruth = image.boxes.map((box) =>
      normalizedBoxToAbsolute(box, image.width, image.height)
    );
    const matched = new Set();
    let imageMatched = false;
    if (image.label === "positive") {
      positiveImages += 1;
    }
    for (const prediction of predictions) {
      let bestIndex = -1;
      let bestIou = 0;
      for (let index = 0; index < groundTruth.length; index += 1) {
        if (matched.has(index)) {
          continue;
        }
        const iou = intersectionOverUnion(prediction.bbox, groundTruth[index]);
        if (iou > bestIou) {
          bestIou = iou;
          bestIndex = index;
        }
      }
      if (bestIou >= IOU_THRESHOLD) {
        truePositives += 1;
        matched.add(bestIndex);
        imageMatched = true;
      } else {
        falsePositives += 1;
        if (falsePositiveExamples.length < 20) {
          falsePositiveExamples.push({
            id: image.id,
            label: image.label,
            confidence: roundMetric(prediction.confidence),
            bbox: prediction.bbox,
          });
        }
      }
    }
    falseNegatives += groundTruth.length - matched.size;
    if (image.label === "positive" && imageMatched) {
      positiveImagesWithMatch += 1;
    }
    if (image.label === "negative" && predictions.length > 0) {
      negativeImagesWithFalsePositive += 1;
    }
  }

  const precision =
    truePositives + falsePositives > 0
      ? truePositives / (truePositives + falsePositives)
      : 0;
  const recall =
    truePositives + falseNegatives > 0
      ? truePositives / (truePositives + falseNegatives)
      : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  return {
    threshold,
    iouThreshold: IOU_THRESHOLD,
    truePositives,
    falsePositives,
    falseNegatives,
    precision: roundMetric(precision),
    recall: roundMetric(recall),
    f1: roundMetric(f1),
    positiveImageRecall: roundMetric(
      positiveImagesWithMatch / Math.max(1, positiveImages)
    ),
    negativeImageFalsePositiveRate: roundMetric(
      negativeImagesWithFalsePositive /
        Math.max(1, images.length - positiveImages)
    ),
    falsePositiveExamples,
  };
}

function writeReport(file, report) {
  if (!file) {
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temp, file);
  console.error(`[bench-face-detector] report written: ${file}`);
}

async function run(options) {
  const manifest = readManifest(options.manifestFile);
  const images = (await loadImageMetadata(options.manifestFile, manifest)).map(
    (image, index) => ({ ...image, photoId: index + 1 })
  );
  const modelFiles = FACE_MODEL_FILES.map((relative) => {
    const file = path.join(options.modelsDir, relative);
    if (!fs.existsSync(file)) {
      throw usageError(`Missing model file: ${file}`);
    }
    return {
      file: relative,
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    };
  });
  const photos = images.map((image, index) => ({
    id: index + 1,
    path: image.path,
  }));
  const resultsById = new Map();
  const worker = fork(path.resolve("scripts/face-worker.mjs"), [], {
    stdio: "ignore",
  });
  const startedAt = Date.now();
  let queueIndex = 0;
  let finished = false;
  let initialized = false;
  const timeoutId = setTimeout(() => {
    if (!finished) {
      console.error("[bench-face-detector] timeout");
      worker.kill();
      process.exitCode = 1;
    }
  }, MAX_RUNTIME_MS);
  const cleanup = () => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timeoutId);
    try {
      worker.send({ type: "shutdown" });
    } catch {
      // The worker may already have exited.
    }
    worker.kill();
  };
  const sendBatch = () => {
    if (queueIndex >= photos.length) {
      return;
    }
    const batch = photos.slice(queueIndex, queueIndex + BATCH_SIZE);
    queueIndex += batch.length;
    worker.send({ type: "detect", photos: batch });
  };
  const finish = () => {
    const thresholdSweep = options.thresholds.map((threshold) =>
      evaluateAtThreshold(images, resultsById, threshold)
    );
    const bestThreshold = thresholdSweep.reduce((best, current) => {
      if (current.f1 !== best.f1) {
        return current.f1 > best.f1 ? current : best;
      }
      if (
        current.negativeImageFalsePositiveRate !==
        best.negativeImageFalsePositiveRate
      ) {
        return current.negativeImageFalsePositiveRate <
          best.negativeImageFalsePositiveRate
          ? current
          : best;
      }
      return current.threshold > best.threshold ? current : best;
    }, thresholdSweep[0]);
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      modelKind: "yunet-sface",
      modelFiles,
      source: manifest.source,
      dataset: {
        manifest: options.manifestFile,
        images: images.length,
        positiveImages: images.filter((image) => image.label === "positive")
          .length,
        negativeImages: images.filter((image) => image.label === "negative")
          .length,
        positiveBoxes: images.reduce(
          (count, image) => count + image.boxes.length,
          0
        ),
      },
      runtime: {
        photosProcessed: resultsById.size,
        elapsedMs: Date.now() - startedAt,
        iouThreshold: IOU_THRESHOLD,
        minimumFaceSizePx: 40,
        note: "The application worker filters candidates below 0.85; the sweep evaluates thresholds at or above the deployed operating point.",
      },
      detection: {
        detectionThresholdSeed: 0.85,
        bestThreshold,
        thresholdSweep,
      },
    };
    writeReport(options.reportFile, report);
    console.log(JSON.stringify(report, null, 2));
    cleanup();
  };
  worker.on("message", (message) => {
    if (message.type === "ready") {
      if (message.error) {
        console.error(`[bench-face-detector] init failed: ${message.error}`);
        cleanup();
        process.exitCode = 1;
        return;
      }
      if (!initialized) {
        initialized = true;
        sendBatch();
      }
      return;
    }
    if (message.type === "result") {
      for (const result of message.results ?? []) {
        resultsById.set(result.id, result);
      }
      if (queueIndex < photos.length) {
        sendBatch();
      } else if (resultsById.size >= photos.length) {
        finish();
      }
    }
  });
  worker.send({
    type: "init",
    modelsDir: options.modelsDir,
    useGPU: false,
    kind: "yunet-sface",
  });
}

try {
  await run(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[bench-face-detector] ${error.message}`);
  process.exitCode = 1;
}
