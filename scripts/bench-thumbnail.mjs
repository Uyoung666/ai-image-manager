// Quick sharp thumbnail benchmark for import-time encoding choices.
// Usage:
//   node scripts/bench-thumbnail.mjs [image-or-directory]

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const IMAGE_EXT_RE = /\.(avif|bmp|gif|heic|heif|jpe?g|png|tiff?|webp)$/i;
const DEFAULT_TEST_DIR = "test-fixtures/photos";
const inputPath = process.argv[2] || DEFAULT_TEST_DIR;

function pickSample(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return targetPath;
  }

  const files = fs
    .readdirSync(targetPath)
    .filter((file) => IMAGE_EXT_RE.test(file))
    .sort();

  if (files.length === 0) {
    throw new Error(`No supported images found in ${targetPath}`);
  }

  return path.join(targetPath, files[Math.floor(files.length / 2)]);
}

async function bench(label, fn) {
  await fn();
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    await fn();
    times.push(performance.now() - t0);
  }
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  console.log(
    `${label}: avg=${avg.toFixed(1)}ms [${times.map((t) => t.toFixed(0)).join(", ")}]`
  );
  return avg;
}

async function main() {
  const sample = pickSample(inputPath);

  console.log("=== sharp thumbnail benchmarks ===");
  console.log(`Image: ${sample}`);

  const baseline = await bench("webp effort=4 q=85 (baseline) ", async () => {
    await sharp(sample)
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  });

  const optimized = await bench("webp effort=1 q=85 (optimized)", async () => {
    await sharp(sample)
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 1 })
      .toBuffer();
  });

  await bench("jpeg q=80                    ", async () => {
    await sharp(sample)
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  });

  await bench("decode+resize only           ", async () => {
    await sharp(sample)
      .rotate()
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer();
  });

  await bench("metadata only                ", async () => {
    await sharp(sample).metadata();
  });

  const improvement = ((1 - optimized / baseline) * 100).toFixed(1);
  console.log("\n=== summary ===");
  console.log(
    `Optimized WebP saved ${improvement}% vs baseline on this sample.`
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
