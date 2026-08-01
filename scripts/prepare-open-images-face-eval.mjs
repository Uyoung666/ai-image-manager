#!/usr/bin/env node
/**
 * Prepare a small, reproducible Open Images face-detection evaluation set.
 *
 * The CSV files are downloaded separately from the official Open Images
 * storage bucket. This script only selects samples and writes metadata; it
 * never changes application data or release assets.
 *
 * Usage:
 *   node scripts/prepare-open-images-face-eval.mjs [root] [sampleCount]
 */
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(
  process.argv[2] ?? ".face-dev/evaluation/open-images"
);
const sampleCount = Math.max(1, Number(process.argv[3] ?? 100));
const NEWLINE_PATTERN = /\r?\n/u;
const bboxFile = path.join(root, "validation-annotations-bbox.csv");
const labelFile = path.join(
  root,
  "validation-annotations-human-imagelabels-boxable.csv"
);
const faceLabel = "/m/0dzct";

function fail(message) {
  throw new Error(`${message}\nExpected Open Images CSV files under ${root}`);
}

function readCsv(file) {
  if (!fs.existsSync(file)) {
    fail(`Missing ${path.basename(file)}.`);
  }
  const lines = fs.readFileSync(file, "utf8").trim().split(NEWLINE_PATTERN);
  if (lines.length < 2) {
    fail(`CSV is empty: ${file}`);
  }
  const headers = lines[0].split(",");
  return lines.slice(1).map((line) => {
    const values = line.split(",");
    return Object.fromEntries(
      headers.map((header, index) => [header, values[index] ?? ""])
    );
  });
}

function toBox(row) {
  return {
    xMin: Number(row.XMin),
    xMax: Number(row.XMax),
    yMin: Number(row.YMin),
    yMax: Number(row.YMax),
    isDepiction: row.IsDepiction === "1",
    isGroupOf: row.IsGroupOf === "1",
    isOccluded: row.IsOccluded === "1",
    isTruncated: row.IsTruncated === "1",
  };
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function main() {
  const boxes = readCsv(bboxFile).filter((row) => row.LabelName === faceLabel);
  const positiveById = new Map();
  for (const row of boxes) {
    const current = positiveById.get(row.ImageID) ?? [];
    current.push(toBox(row));
    positiveById.set(row.ImageID, current);
  }

  const positiveIds = [...positiveById.keys()]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, sampleCount);
  const positiveSet = new Set(positiveIds);

  const labels = readCsv(labelFile);
  const negativeIds = [
    ...new Set(
      labels
        .filter(
          (row) =>
            row.LabelName === faceLabel &&
            row.Confidence === "0" &&
            !positiveSet.has(row.ImageID)
        )
        .map((row) => row.ImageID)
    ),
  ]
    .sort((a, b) => a.localeCompare(b))
    .slice(0, sampleCount);

  if (positiveIds.length < sampleCount || negativeIds.length < sampleCount) {
    fail(
      `Not enough samples: positive=${positiveIds.length}, negative=${negativeIds.length}, requested=${sampleCount}`
    );
  }

  const images = [
    ...positiveIds.map((id) => ({
      id,
      split: "validation",
      fileName: `${id}.jpg`,
      label: "positive",
      boxes: positiveById.get(id),
    })),
    ...negativeIds.map((id) => ({
      id,
      split: "validation",
      fileName: `${id}.jpg`,
      label: "negative",
      boxes: [],
    })),
  ];

  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "images"), { recursive: true });
  writeJson(path.join(root, "sample-manifest.json"), {
    schemaVersion: 1,
    source: {
      dataset: "Open Images V5 validation",
      annotationFiles: [path.basename(bboxFile), path.basename(labelFile)],
      humanFaceLabel: faceLabel,
      annotationLicense: "CC BY 4.0",
      imageLicense:
        "Image-level licenses must be verified per image before redistribution",
    },
    selection: {
      positiveImages: sampleCount,
      negativeImages: sampleCount,
      rule: "positive=Human face bounding box; negative=human-verified Human face label with Confidence=0",
    },
    images,
  });
  fs.writeFileSync(
    path.join(root, "sample-images.list"),
    `${images.map((image) => `${image.split}/${image.id}`).join("\n")}\n`,
    "utf8"
  );
  console.log(
    JSON.stringify(
      {
        root,
        positiveImages: positiveIds.length,
        negativeImages: negativeIds.length,
        totalImages: images.length,
        manifest: path.join(root, "sample-manifest.json"),
        imageList: path.join(root, "sample-images.list"),
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (error) {
  console.error(`[prepare-open-images-face-eval] ${error.message}`);
  process.exitCode = 1;
}
