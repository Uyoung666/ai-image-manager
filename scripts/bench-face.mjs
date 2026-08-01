#!/usr/bin/env node
/**
 * Face detection/embedding benchmark + smoke test (forks face-worker.mjs).
 *
 * Usage:
 *   node scripts/bench-face.mjs <dir> [maxPhotos]
 *     dir      — directory of images (flat) or subdirs; subdir name = identity
 *     maxPhotos — optional cap on how many photos to process
 *
 * Reports: model init time, per-photo latency, detected-face counts, embedding
 * dimensions. Runs fully outside Electron (onnxruntime-node is N-API).
 */
import fs from "node:fs";
import path from "node:path";
import { fork } from "node:child_process";

const IMG_EXT = new Set([".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"]);

function collectImages(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectImages(full, out);
    } else if (IMG_EXT.has(path.extname(entry.name).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

const [dirArg, maxArg] = process.argv.slice(2);
if (!dirArg || !fs.existsSync(dirArg)) {
  console.error("Usage: node scripts/bench-face.mjs <dir> [maxPhotos]");
  process.exit(1);
}

const allImages = collectImages(dirArg);
const images = maxArg ? allImages.slice(0, Number(maxArg)) : allImages;
console.log(`[bench-face] ${images.length}/${allImages.length} images in ${dirArg}`);

const worker = fork(path.resolve("scripts/face-worker.mjs"), [], { stdio: "ignore" });
const BATCH = 40;
const startedAt = Date.now();
let initAt = 0;
let detectStartedAt = 0;
const results = [];
let pendingResolve = null;
let photoQueue = [];
let idCounter = 0;

function sendBatch() {
  if (!photoQueue.length) {
    // All batches dispatched
    return;
  }
  const batch = photoQueue.splice(0, BATCH);
  worker.send({ type: "detect", photos: batch });
}

worker.on("message", (msg) => {
  if (msg.type === "init-progress" && msg.percent >= 100 && !initAt) {
    initAt = Date.now();
    console.log(`[bench-face] model init: ${initAt - startedAt}ms`);
    detectStartedAt = Date.now();
    sendBatch();
  }
  if (msg.type === "ready") {
    if (msg.error) {
      console.error("[bench-face] init failed:", msg.error);
      process.exit(1);
    }
  }
  if (msg.type === "result") {
    results.push(...msg.results);
    if (photoQueue.length) {
      sendBatch();
    } else {
      finish();
    }
  }
});

function finish() {
  const detectMs = Date.now() - detectStartedAt;
  const totalFaces = results.reduce((s, r) => s + r.faces.length, 0);
  const dims = new Set();
  for (const r of results) {
    for (const f of r.faces) {
      if (f.embedding) dims.add(f.embedding.length);
    }
  }
  const faceCounts = results.map((r) => r.faces.length);
  const withFaces = faceCounts.filter((c) => c > 0).length;

  console.log(`\n[bench-face] results (YuNet+SFace, ${results.length} photos):`);
  console.log(`  detect+embed time: ${detectMs}ms (${(detectMs / Math.max(1, results.length)).toFixed(0)}ms/photo)`);
  console.log(`  total faces: ${totalFaces} (avg ${(totalFaces / Math.max(1, results.length)).toFixed(2)}/photo)`);
  console.log(`  photos with >=1 face: ${withFaces}/${results.length}`);
  console.log(`  face count distribution: max=${faceCounts.length ? Math.max(...faceCounts) : 0} | >1 face: ${faceCounts.filter((c) => c > 1).length}`);
  console.log(`  embedding dims: ${[...dims].join(", ") || "none"}`);
  worker.send({ type: "shutdown" });
  worker.kill();
  process.exit(0);
}

// Init
const photos = images.map((p) => ({ id: ++idCounter, path: p }));
photoQueue = [...photos];
  worker.send({ type: "init", modelsDir: path.resolve("models"), useGPU: false });

setTimeout(() => {
  console.error("[bench-face] TIMEOUT");
  worker.kill();
  process.exit(1);
}, 300_000);
