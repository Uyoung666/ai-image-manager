// Quick SigLIP image embedding benchmark using the production embed-worker.
//
// Usage:
//   node scripts/bench-embedding.mjs [image-or-directory] [count]

import { fork } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp"]);

const repoRoot = path.resolve(import.meta.dirname, "..");
const workerScript = path.join(repoRoot, "scripts", "embed-worker.mjs");
const modelPath = path.join(repoRoot, "models");
const defaultInput = "D:\\8806\\ai-image-manager测试用例";
const inputPath = path.resolve(process.argv[2] || defaultInput);
const count = Math.max(1, Number.parseInt(process.argv[3] || "12", 10) || 12);

function listImages(targetPath) {
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) {
    return [targetPath];
  }
  return fs
    .readdirSync(targetPath, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(targetPath, entry.name))
    .filter((filePath) =>
      IMAGE_EXTENSIONS.has(path.extname(filePath).toLowerCase())
    )
    .slice(0, count);
}

function splitEvenly(items, parts) {
  return Array.from({ length: parts }, (_, index) =>
    items.filter((_, itemIndex) => itemIndex % parts === index)
  ).filter((chunk) => chunk.length > 0);
}

function runWorker(photos, intraOpNumThreads) {
  return new Promise((resolve, reject) => {
    const child = fork(workerScript, [], {
      stdio: ["ignore", "ignore", "pipe", "ipc"],
      env: {
        ...process.env,
        AI_EMBED_SHARP_THREADS: "1",
      },
    });

    let stderrTail = "";
    const initStartedAt = performance.now();
    let embedStartedAt = 0;
    let initMs = 0;

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`worker timed out: ${stderrTail.slice(-800)}`));
    }, 300_000);

    child.stderr?.on("data", (chunk) => {
      stderrTail = `${stderrTail}${chunk.toString()}`.slice(-4000);
    });

    child.on("message", (msg) => {
      if (msg.type === "ready") {
        initMs = performance.now() - initStartedAt;
        embedStartedAt = performance.now();
        child.send({ type: "embed", modelPath, modelKind: "siglip", photos });
        return;
      }
      if (msg.type === "init-error") {
        clearTimeout(timeout);
        child.kill();
        reject(new Error(msg.error || "worker init failed"));
        return;
      }
      if (msg.type === "result") {
        clearTimeout(timeout);
        child.kill();
        const embedMs = performance.now() - embedStartedAt;
        const results = msg.results || [];
        resolve({
          embedMs,
          errors: results.filter((r) => r.error).length,
          initMs,
          ok: results.filter((r) => r.vector?.length > 0).length,
          photos: photos.length,
        });
      }
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("exit", (code) => {
      if (code !== 0 && embedStartedAt === 0) {
        clearTimeout(timeout);
        reject(
          new Error(
            `worker exited before ready (${code}): ${stderrTail.slice(-800)}`
          )
        );
      }
    });

    child.send({
      type: "init",
      modelKind: "siglip",
      modelPath,
      intraOpNumThreads,
      useGPU: false,
    });
  });
}

async function runProfile(label, photos, workers, intraOpNumThreads) {
  const chunks = splitEvenly(photos, workers);
  const startedAt = performance.now();
  const results = await Promise.all(
    chunks.map((chunk) =>
      runWorker(
        chunk.map((filePath, index) => ({ id: index, path: filePath })),
        intraOpNumThreads
      )
    )
  );
  const wallMs = performance.now() - startedAt;
  const ok = results.reduce((sum, r) => sum + r.ok, 0);
  const errors = results.reduce((sum, r) => sum + r.errors, 0);
  const maxInitMs = Math.max(...results.map((r) => r.initMs));
  const maxEmbedMs = Math.max(...results.map((r) => r.embedMs));

  return {
    avgMsPerPhoto: maxEmbedMs / ok,
    errors,
    label,
    maxEmbedMs,
    maxInitMs,
    ok,
    photos: photos.length,
    wallMs,
    workers: chunks.length,
  };
}

const photos = listImages(inputPath);
if (photos.length === 0) {
  throw new Error(`No benchmark images found: ${inputPath}`);
}

const cpuCount = os.cpus().length;
const defaultWorkers = cpuCount >= 12 ? 2 : 1;
const defaultThreads = Math.max(
  1,
  Math.min(4, Math.floor(Math.max(1, cpuCount - 1) / defaultWorkers))
);

console.log("=== SIGLIP embedding benchmark ===");
console.log(`CPU: ${cpuCount} logical cores`);
console.log(`Images: ${photos.length}`);
console.log(`Model: ${modelPath}`);
console.log("");

const profiles = [
  ["current-default", defaultWorkers, defaultThreads],
  ["low-impact", 1, 1],
  ["throughput-opt-in", Math.min(3, Math.max(1, cpuCount - 1)), 1],
];

for (const [label, workers, threads] of profiles) {
  const result = await runProfile(label, photos, workers, threads);
  console.log(
    `${result.label}: workers=${result.workers}, threads=${threads}, ok=${result.ok}/${result.photos}, errors=${result.errors}`
  );
  console.log(
    `  init(max): ${(result.maxInitMs / 1000).toFixed(2)}s, embed(max): ${(result.maxEmbedMs / 1000).toFixed(2)}s, wall: ${(result.wallMs / 1000).toFixed(2)}s`
  );
  console.log(`  steady avg: ${result.avgMsPerPhoto.toFixed(0)}ms/photo`);
}
