/**
 * Standalone CLIP image embedding worker.
 *
 * Runs as a child process via fork() to share the Electron Node.js runtime,
 * avoiding native-module version mismatches (sharp, etc.).
 *
 * IPC protocol:
 *   Parent sends: { type: "embed", modelPath: "...", photos: [{ id, path }, ...] }
 *   Worker sends: { type: "result", results: [{ id, vector? }] }
 *   Then worker exits with code 0.
 */

import fs from "node:fs";
import path from "node:path";

// --- Force WASM backend ---
// Must happen BEFORE any @xenova/transformers import.
try {
  process.release.name = "browser";
} catch {
  try {
    Object.defineProperty(process.release, "name", { value: "browser" });
  } catch {
    console.error(
      "[Worker] Cannot override process.release.name — WASM backend may not activate"
    );
  }
}

// Disable ONNX multi-threading BEFORE import
process.env.ORT_WASM_NUM_THREADS = "1";

// --- Wait for parent message ---
process.on("message", async (msg) => {
  if (msg.type !== "embed") {
    process.exit(1);
  }

  const { modelPath, photos } = msg;
  if (!(modelPath && photos?.length)) {
    process.send?.({ type: "result", results: [] });
    process.exit(0);
  }

  console.error(`[Worker] Loading CLIP model from: ${modelPath}`);

  try {
    const {
      AutoProcessor,
      CLIPVisionModelWithProjection,
      RawImage,
      env,
    } = await import("@xenova/transformers");

    env.localModelPath = modelPath;
    env.allowRemoteModels = true;
    env.backends.onnx.wasm.numThreads = 1;
    console.error("[Worker] ONNX threads: 1 (single-threaded)");

    const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
    if (mirror) {
      env.remoteHost = mirror;
      env.remotePathTemplate = "{model}/resolve/main/";
      console.error(`[Worker] Using HF mirror: ${mirror}`);
    }

    const MODEL_ID = "Xenova/clip-vit-base-patch32";

    const processor = await AutoProcessor.from_pretrained(MODEL_ID);
    const model = await CLIPVisionModelWithProjection.from_pretrained(
      MODEL_ID,
      { quantized: true }
    );

    console.error(
      `[Worker] Model loaded, embedding ${photos.length} photos (vision-only)`
    );

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
          if (
            v &&
            typeof v === "object" &&
            typeof v.dispose === "function"
          ) {
            v.dispose();
          }
        }

        results.push({ id: photo.id, vector });
        console.error(
          `[Worker] ${i + 1}/${photos.length} OK: ${path.basename(photo.path)}`
        );
      } catch (err) {
        console.error(
          `[Worker] ${i + 1}/${photos.length} FAIL: ${photo.path} — ${err.message}`
        );
        results.push({ id: photo.id, error: err.message });
      }
    }

    process.send?.({ type: "result", results });
    console.error(
      `[Worker] Done: ${results.filter((r) => r.vector).length}/${photos.length} succeeded`
    );
  } catch (err) {
    console.error("[Worker] Fatal error:", err.message);
    process.send?.({
      type: "result",
      results: photos.map((p) => ({ id: p.id, error: err.message })),
    });
  }

  process.exit(0);
});
