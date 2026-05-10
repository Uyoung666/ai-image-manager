/**
 * Standalone CLIP image embedding worker.
 *
 * Runs as a child process to isolate ONNX WASM memory:
 * each batch gets a fresh process → zero memory accumulation.
 *
 * Usage: node embed-worker.mjs <input.json> <output.json>
 *
 * input.json:  { "modelPath": "...", "photos": [{ "id": 1, "path": "..." }, ...] }
 * output.json: { "results": [{ "id": 1, "vector": [...] }, ...] }
 */

import fs from "node:fs";
import path from "node:path";

// --- Parse args ---
const [inputFile, outputFile] = process.argv.slice(2);

if (!inputFile || !outputFile) {
  console.error("Usage: node embed-worker.mjs <input.json> <output.json>");
  process.exit(1);
}

// --- Read input ---
let input;
try {
  input = JSON.parse(fs.readFileSync(inputFile, "utf-8"));
} catch (err) {
  console.error("Failed to read input file:", err.message);
  process.exit(1);
}

const { modelPath, photos } = input;
if (!modelPath || !photos?.length) {
  fs.writeFileSync(outputFile, JSON.stringify({ results: [] }));
  process.exit(0);
}

// --- Force WASM backend ---
// Must happen BEFORE any @xenova/transformers import.
// Node.js v24+ seals process.release, so we try property write first,
// then Object.defineProperty as fallback.
try {
  process.release.name = "browser";
} catch {
  try {
    Object.defineProperty(process.release, "name", { value: "browser" });
  } catch {
    console.error("[Worker] Cannot override process.release.name — WASM backend may not activate");
  }
}

// Disable ONNX multi-threading BEFORE import — must be set as env
// because onnxruntime-web initializes its WASM backend during import.
process.env.ORT_WASM_NUM_THREADS = "1";

console.error(`[Worker] Loading CLIP model from: ${modelPath}`);

// --- Dynamic import (ESM package in CJS context) ---
const { AutoProcessor, AutoTokenizer, CLIPVisionModelWithProjection, RawImage, env } =
  await import("@xenova/transformers");

env.localModelPath = modelPath;
env.allowRemoteModels = true;
// Belt-and-suspenders: also set via the JS API
env.backends.onnx.wasm.numThreads = 1;
console.error("[Worker] ONNX threads: 1 (single-threaded)");

// Support HF mirror for China network access
const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
if (mirror) {
  env.remoteHost = mirror;
  env.remotePathTemplate = "{model}/resolve/main/";
  console.error(`[Worker] Using HF mirror: ${mirror}`);
}

const MODEL_ID = "Xenova/clip-vit-base-patch32";

const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });

console.error(`[Worker] Model loaded, embedding ${photos.length} photos (vision-only)`);

// --- Embed ---
const results = [];
for (let i = 0; i < photos.length; i++) {
  const photo = photos[i];
  try {
    const image = await RawImage.read(photo.path);
    const inputs = await processor(image);
    const output = await model(inputs);

    const { image_embeds } = output;
    const vec = Array.from(image_embeds.data);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    const vector = vec.map((v) => v / (norm || 1));

    // Free ONNX tensors
    for (const v of Object.values(output)) {
      if (v && typeof v === "object" && typeof v.dispose === "function") {
        v.dispose();
      }
    }

    results.push({ id: photo.id, vector });
    console.error(`[Worker] ${i + 1}/${photos.length} OK: ${path.basename(photo.path)}`);
  } catch (err) {
    console.error(`[Worker] ${i + 1}/${photos.length} FAIL: ${photo.path} — ${err.message}`);
    results.push({ id: photo.id, error: err.message });
  }
}

// --- Write output ---
fs.writeFileSync(outputFile, JSON.stringify({ results }));
console.error(`[Worker] Done: ${results.filter((r) => r.vector).length}/${photos.length} succeeded`);
process.exit(0);
