#!/usr/bin/env node
import { fork } from "node:child_process";
/**
 * Face quality benchmark for a labeled face dataset.
 *
 * Dataset layout:
 *   <dir>/<identity>/<images...>
 *
 * The threshold sweep simulates the production incremental centroid
 * assignment used by face-detector.ts. The report is therefore suitable for
 * calibrating clustering.threshold, rather than only comparing pairwise
 * similarities.
 *
 * Usage:
 *   node scripts/bench-face-quality.mjs <dir> [kind]
 *     [--labels <json>] [--report <file>] [--models-dir <dir>]
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const IMAGE_EXTENSIONS = new Set([
  ".bmp",
  ".gif",
  ".jpeg",
  ".jpg",
  ".png",
  ".webp",
]);
const MODEL_FILES = {
  "ultraface-w600k": ["face/ultraface-320.onnx", "face/w600k_r50.onnx"],
  "yunet-sface": [
    "face/face_detection_yunet_2023mar.onnx",
    "face/face_recognition_sface_2021dec.onnx",
  ],
};
const MODEL_CONFIDENCE_FILTER = {
  "ultraface-w600k": 0.88,
  "yunet-sface": 0.85,
};
const LEADING_DOT_SLASH_PATTERN = /^\.\//u;
const BATCH_SIZE = 40;
const MAX_RUNTIME_MS = 300_000;

function usageError(message) {
  return new Error(
    `${message}\nUsage: node scripts/bench-face-quality.mjs <dir> [kind] [--labels <json>] [--report <file>] [--models-dir <dir>]`
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI parsing keeps all benchmark options and validation in one entry point.
function parseArgs(argv) {
  const args = [...argv];
  const dirArg = args.shift();
  if (!dirArg) {
    throw usageError("Dataset directory is required.");
  }

  let kind = "yunet-sface";
  if (args[0] && !args[0].startsWith("-")) {
    kind = args.shift();
  }
  if (!Object.hasOwn(MODEL_FILES, kind)) {
    throw usageError(`Unsupported model kind: ${kind}`);
  }

  let labelsFile = null;
  let reportFile = null;
  let modelsDir = path.resolve("models");
  while (args.length > 0) {
    const flag = args.shift();
    if (flag === "--labels") {
      labelsFile = args.shift();
      if (!labelsFile) {
        throw usageError("--labels requires a JSON file path.");
      }
      continue;
    }
    if (flag === "--report") {
      reportFile = args.shift();
      if (!reportFile) {
        throw usageError("--report requires a file path.");
      }
      continue;
    }
    if (flag === "--models-dir") {
      const value = args.shift();
      if (!value) {
        throw usageError("--models-dir requires a directory path.");
      }
      modelsDir = path.resolve(value);
      continue;
    }
    throw usageError(`Unknown argument: ${flag}`);
  }

  return {
    datasetDir: path.resolve(dirArg),
    kind,
    labelsFile: labelsFile ? path.resolve(labelsFile) : null,
    modelsDir,
    reportFile: reportFile ? path.resolve(reportFile) : null,
  };
}

function isImage(fileName) {
  return IMAGE_EXTENSIONS.has(path.extname(fileName).toLowerCase());
}

function normalizeRelativePath(value) {
  return value.replaceAll("\\", "/").replace(LEADING_DOT_SLASH_PATTERN, "");
}

function readLabelManifest(labelsFile, datasetDir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(labelsFile, "utf8"));
  } catch (error) {
    throw usageError(`Unable to read labels JSON: ${error.message}`);
  }
  const entries = Array.isArray(parsed)
    ? parsed.map((item) => [item?.path, item?.identity])
    : Object.entries(parsed?.labels ?? parsed ?? {});
  const root = path.resolve(datasetDir);
  const rootPrefix = `${root}${path.sep}`;
  const labels = new Map();
  for (const [relativePath, identity] of entries) {
    if (typeof relativePath !== "string" || typeof identity !== "string") {
      throw usageError(
        "Each label must map an image relative path to a non-empty identity string."
      );
    }
    const normalized = normalizeRelativePath(relativePath);
    const absolutePath = path.resolve(root, normalized);
    if (absolutePath !== root && !absolutePath.startsWith(rootPrefix)) {
      throw usageError(
        `Label path escapes the dataset directory: ${relativePath}`
      );
    }
    if (!(isImage(normalized) && identity.trim())) {
      throw usageError(`Invalid label entry: ${relativePath}`);
    }
    if (labels.has(normalized)) {
      throw usageError(`Duplicate label path: ${normalized}`);
    }
    labels.set(normalized, identity.trim());
  }
  if (labels.size === 0) {
    throw usageError("Labels JSON must contain at least one image label.");
  }
  return labels;
}

function collectImagesRecursively(directory) {
  const images = [];
  const entries = fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      images.push(...collectImagesRecursively(absolutePath));
    } else if (entry.isFile() && isImage(entry.name)) {
      images.push(absolutePath);
    }
  }
  return images;
}

function validateDatasetShape(identities, photoMap, pairCounts = null) {
  const samePairs =
    pairCounts?.samePairs ??
    identities.reduce((count, identity) => {
      const photoCount = photoMap.filter(
        (photo) => photo.identity === identity
      ).length;
      return count + (photoCount * (photoCount - 1)) / 2;
    }, 0);
  const crossPairs =
    pairCounts?.crossPairs ??
    photoMap.reduce(
      (count, photo, index) =>
        count +
        photoMap
          .slice(index + 1)
          .filter((other) => other.identity !== photo.identity).length,
      0
    );
  if (identities.length < 2 || samePairs === 0 || crossPairs === 0) {
    throw usageError(
      `Dataset needs at least two identities, one same-person pair, and one cross-person pair; found ${identities.length} identities and ${photoMap.length} photos`
    );
  }
  return { identities, photoMap, samePairs, crossPairs };
}

function collectDataset(datasetDir, labelsFile) {
  if (!(fs.existsSync(datasetDir) && fs.statSync(datasetDir).isDirectory())) {
    throw usageError(`Dataset directory does not exist: ${datasetDir}`);
  }

  if (labelsFile) {
    if (!fs.existsSync(labelsFile)) {
      throw usageError(`Labels file does not exist: ${labelsFile}`);
    }
    const labels = readLabelManifest(labelsFile, datasetDir);
    const imagePaths = collectImagesRecursively(datasetDir);
    const imageMap = new Map(
      imagePaths.map((imagePath) => [
        normalizeRelativePath(path.relative(datasetDir, imagePath)),
        imagePath,
      ])
    );
    const missingFromLabels = imagePaths.filter(
      (imagePath) =>
        !labels.has(normalizeRelativePath(path.relative(datasetDir, imagePath)))
    );
    if (missingFromLabels.length > 0) {
      throw usageError(
        `Labels JSON is missing ${missingFromLabels.length} dataset image(s), starting with ${path.relative(datasetDir, missingFromLabels[0])}`
      );
    }
    const extraLabels = [...labels.keys()].filter(
      (relativePath) => !imageMap.has(relativePath)
    );
    if (extraLabels.length > 0) {
      throw usageError(
        `Labels JSON references ${extraLabels.length} missing image(s), starting with ${extraLabels[0]}`
      );
    }
    const photoMap = [...imageMap.keys()]
      .sort((a, b) => a.localeCompare(b))
      .map((relativePath) => ({
        identity: labels.get(relativePath),
        path: imageMap.get(relativePath),
      }));
    const identities = [
      ...new Set(photoMap.map((photo) => photo.identity)),
    ].sort((a, b) => a.localeCompare(b));
    return validateDatasetShape(identities, photoMap);
  }

  const entries = fs
    .readdirSync(datasetDir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name));
  const rootImages = entries
    .filter((entry) => entry.isFile() && isImage(entry.name))
    .map((entry) => entry.name);
  if (rootImages.length > 0) {
    throw usageError(
      `Dataset must use <identity>/<images> directories; found ${rootImages.length} image(s) directly under ${datasetDir}`
    );
  }

  const photoMap = [];
  const identities = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const identityDir = path.join(datasetDir, entry.name);
    const images = fs
      .readdirSync(identityDir)
      .filter(isImage)
      .sort((a, b) => a.localeCompare(b));
    if (images.length === 0) {
      continue;
    }
    identities.push(entry.name);
    for (const image of images) {
      photoMap.push({
        identity: entry.name,
        path: path.join(identityDir, image),
      });
    }
  }

  const samePairs = identities.reduce((count, identity) => {
    const photoCount = photoMap.filter(
      (photo) => photo.identity === identity
    ).length;
    return count + (photoCount * (photoCount - 1)) / 2;
  }, 0);
  const crossPairs = photoMap.reduce(
    (count, photo, index) =>
      count +
      photoMap
        .slice(index + 1)
        .filter((other) => other.identity !== photo.identity).length,
    0
  );
  return validateDatasetShape(identities, photoMap, { samePairs, crossPairs });
}

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function describeModels(modelsDir, kind) {
  return MODEL_FILES[kind].map((relativePath) => {
    const filePath = path.join(modelsDir, relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`Required benchmark model is missing: ${filePath}`);
    }
    const stat = fs.statSync(filePath);
    return {
      path: relativePath.replaceAll(path.sep, "/"),
      sizeBytes: stat.size,
      sha256: sha256File(filePath),
    };
  });
}

function hashDataset(datasetDir, photoMap) {
  const hash = createHash("sha256");
  for (const photo of photoMap) {
    const relativePath = path
      .relative(datasetDir, photo.path)
      .replaceAll(path.sep, "/");
    hash.update(relativePath);
    hash.update("\0");
    hash.update(photo.identity);
    hash.update("\0");
    hash.update(fs.readFileSync(photo.path));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

function computeCentroid(embeddings) {
  const dimension = embeddings[0]?.length ?? 0;
  const centroid = new Array(dimension).fill(0);
  for (const embedding of embeddings) {
    for (let index = 0; index < dimension; index += 1) {
      centroid[index] += embedding[index];
    }
  }
  const norm = Math.sqrt(
    centroid.reduce((sum, value) => sum + value * value, 0)
  );
  return centroid.map((value) => value / (norm || 1));
}

function clusterByCentroid(vectors, threshold) {
  const clusters = [];
  const assignments = new Map();
  for (const vector of vectors) {
    let bestIndex = -1;
    let bestSimilarity = -1;
    for (let index = 0; index < clusters.length; index += 1) {
      const similarity = cosineSimilarity(
        vector.embedding,
        clusters[index].centroid
      );
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestIndex = index;
      }
    }

    if (bestIndex >= 0 && bestSimilarity >= threshold) {
      const cluster = clusters[bestIndex];
      cluster.embeddings.push(vector.embedding);
      cluster.centroid = computeCentroid(cluster.embeddings);
      assignments.set(vector.photoIndex, bestIndex);
    } else {
      assignments.set(vector.photoIndex, clusters.length);
      clusters.push({
        centroid: vector.embedding,
        embeddings: [vector.embedding],
      });
    }
  }
  return assignments;
}

function distributionStats(values) {
  if (values.length === 0) {
    return { n: 0 };
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mean = sorted.reduce((sum, value) => sum + value, 0) / sorted.length;
  const median =
    sorted.length % 2 === 1
      ? sorted[(sorted.length - 1) / 2]
      : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
  const std = Math.sqrt(
    sorted.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sorted.length
  );
  return {
    n: sorted.length,
    mean,
    median,
    min: sorted[0],
    max: sorted.at(-1),
    std,
  };
}

function evaluateAssignments(vectors, assignments) {
  let truePositive = 0;
  let falsePositive = 0;
  let falseNegative = 0;
  for (let left = 0; left < vectors.length; left += 1) {
    for (let right = left + 1; right < vectors.length; right += 1) {
      const sameIdentity = vectors[left].identity === vectors[right].identity;
      const sameCluster =
        assignments.get(vectors[left].photoIndex) ===
        assignments.get(vectors[right].photoIndex);
      if (sameCluster && sameIdentity) {
        truePositive += 1;
      } else if (sameCluster && !sameIdentity) {
        falsePositive += 1;
      } else if (!sameCluster && sameIdentity) {
        falseNegative += 1;
      }
    }
  }
  const precision =
    truePositive + falsePositive > 0
      ? truePositive / (truePositive + falsePositive)
      : 0;
  const recall =
    truePositive + falseNegative > 0
      ? truePositive / (truePositive + falseNegative)
      : 0;
  const f1 =
    precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : 0;
  return {
    falseNegative,
    falsePositive,
    f1,
    precision,
    recall,
    threshold: null,
    truePositive,
  };
}

function roundMetric(value) {
  return Number.isFinite(value) ? Number(value.toFixed(6)) : null;
}

function sweepThresholds(vectors) {
  const sweep = [];
  for (let threshold = 0.2; threshold <= 0.8; threshold += 0.01) {
    const assignments = clusterByCentroid(vectors, threshold);
    const metrics = evaluateAssignments(vectors, assignments);
    sweep.push({
      ...metrics,
      f1: roundMetric(metrics.f1),
      precision: roundMetric(metrics.precision),
      recall: roundMetric(metrics.recall),
      threshold: Number(threshold.toFixed(2)),
    });
  }
  return sweep;
}

function writeReport(reportFile, report) {
  if (!reportFile) {
    return;
  }
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  const temporaryFile = `${reportFile}.tmp-${process.pid}`;
  fs.writeFileSync(
    temporaryFile,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  fs.renameSync(temporaryFile, reportFile);
  console.error(`[bench-face-quality] report written: ${reportFile}`);
}

function runBenchmark(options) {
  const dataset = collectDataset(options.datasetDir, options.labelsFile);
  const models = describeModels(options.modelsDir, options.kind);
  const datasetSha256 = hashDataset(options.datasetDir, dataset.photoMap);
  const photoQueue = dataset.photoMap.map((photo, index) => ({
    id: index + 1,
    path: photo.path,
  }));
  const worker = fork(path.resolve("scripts/face-worker.mjs"), [], {
    stdio: "ignore",
  });
  const results = [];
  let queueIndex = 0;
  let finished = false;
  const startedAt = Date.now();

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

  const fail = (error) => {
    if (finished) {
      return;
    }
    console.error(`[bench-face-quality] ${error.message}`);
    cleanup();
    process.exitCode = 1;
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: analysis combines detection aggregation, similarity statistics, threshold calibration, and report assembly as one benchmark transaction.
  const analyze = () => {
    if (finished) {
      return;
    }
    const confidenceFilter = MODEL_CONFIDENCE_FILTER[options.kind];
    const representatives = [];
    let totalFaces = 0;
    let photosWithFaces = 0;
    let photosWithUsableFaces = 0;
    for (const result of results) {
      totalFaces += result.faces.length;
      if (result.faces.length > 0) {
        photosWithFaces += 1;
      }
      const usableFaces = result.faces.filter(
        (face) =>
          Array.isArray(face.embedding) &&
          face.embedding.length > 0 &&
          Number.isFinite(face.confidence) &&
          face.confidence >= confidenceFilter
      );
      if (usableFaces.length === 0) {
        continue;
      }
      photosWithUsableFaces += 1;
      const top = usableFaces.reduce((best, face) =>
        (best.confidence ?? 0) >= (face.confidence ?? 0) ? best : face
      );
      const photoIndex = result.id - 1;
      representatives.push({
        confidence: top.confidence,
        embedding: top.embedding,
        identity: dataset.photoMap[photoIndex].identity,
        photoIndex,
      });
    }

    if (representatives.length < 2) {
      throw new Error(
        `Only ${representatives.length} usable face embedding(s) remained after confidence filtering`
      );
    }
    const same = [];
    const cross = [];
    for (let left = 0; left < representatives.length; left += 1) {
      for (let right = left + 1; right < representatives.length; right += 1) {
        const similarity = cosineSimilarity(
          representatives[left].embedding,
          representatives[right].embedding
        );
        if (
          representatives[left].identity === representatives[right].identity
        ) {
          same.push(similarity);
        } else {
          cross.push(similarity);
        }
      }
    }
    const samePerson = distributionStats(same);
    const crossPerson = distributionStats(cross);
    const dPrime =
      samePerson.n > 0 && crossPerson.n > 0
        ? (samePerson.mean - crossPerson.mean) /
          Math.sqrt((samePerson.std ** 2 + crossPerson.std ** 2) / 2 + 1e-9)
        : null;
    const thresholdSweep = sweepThresholds(representatives);
    const bestThreshold = thresholdSweep.reduce(
      (best, current) => (current.f1 > best.f1 ? current : best),
      thresholdSweep[0]
    );
    const report = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      kind: options.kind,
      modelFiles: models,
      dataset: {
        directory: options.datasetDir,
        labelsFile: options.labelsFile,
        sha256: datasetSha256,
        identities: dataset.identities.length,
        photos: dataset.photoMap.length,
        usableEmbeddings: representatives.length,
        samePersonPairs: same.length,
        crossPersonPairs: cross.length,
      },
      detection: {
        totalFaces,
        photosWithFaces,
        photosWithUsableFaces,
        confidenceFilter,
        elapsedMs: Date.now() - startedAt,
      },
      similarity: {
        samePerson,
        crossPerson,
        dPrime: roundMetric(dPrime),
      },
      clustering: {
        method: "incremental-centroid-assignment",
        thresholdRange: [0.2, 0.8],
        bestThreshold,
        thresholdSweep,
      },
    };
    writeReport(options.reportFile, report);
    console.log(JSON.stringify(report, null, 2));
    cleanup();
  };

  const sendBatch = () => {
    if (queueIndex >= photoQueue.length) {
      analyze();
      return;
    }
    const batch = photoQueue.slice(queueIndex, queueIndex + BATCH_SIZE);
    queueIndex += batch.length;
    worker.send({ type: "detect", photos: batch });
  };

  worker.on("error", (error) => {
    fail(error);
  });
  worker.on("message", (message) => {
    try {
      if (message.type === "ready") {
        if (message.error) {
          throw new Error(`Face worker init failed: ${message.error}`);
        }
        sendBatch();
        return;
      }
      if (message.type === "result") {
        results.push(...message.results);
        sendBatch();
      }
    } catch (error) {
      fail(error);
    }
  });
  worker.send({
    type: "init",
    kind: options.kind,
    modelsDir: options.modelsDir,
    useGPU: false,
  });

  const timeoutId = setTimeout(() => {
    fail(new Error("Face quality benchmark timed out"));
  }, MAX_RUNTIME_MS);
}

try {
  runBenchmark(parseArgs(process.argv.slice(2)));
} catch (error) {
  console.error(`[bench-face-quality] ${error.message}`);
  process.exitCode = 1;
}
