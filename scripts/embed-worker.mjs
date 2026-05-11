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
 *
 * Architecture — Manual Tensor Construction:
 *   ONNX WASM backend and sharp/libvips share GLib, which can cause native
 *   assertion failures when both are active in the same process. To resolve
 *   this, image preprocessing (resize, normalize, NCHW layout) is done
 *   entirely via sharp + pure JavaScript. Only the CLIP vision model
 *   inference uses @xenova/transformers (ONNX WASM), and sharp resources
 *   are released before the ONNX session is created.
 *
 *   Pipeline: sharp(read+resize+normalize) → Float32Array(NCHW) → Tensor → ONNX
 */

import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

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

// --- CLIP ViT-B/32 preprocessing constants ---
const CLIP_SIZE = 224;
const CLIP_MEAN = [0.48145466, 0.4578275, 0.40821073];
const CLIP_STD = [0.26862954, 0.26130258, 0.27577711];

/**
 * Preprocess an image file into a CLIP-ready Float32Array tensor (NCHW layout).
 *
 * Uses only sharp for image decoding and resize — no transformers.js
 * RawImage / AutoProcessor, avoiding the ONNX-WASM ↔ libvips GLib conflict.
 *
 * Steps:
 *   1. sharp: resize to 224×224 (center-crop), strip alpha → raw RGB
 *   2. Pure JS: normalize each channel: (pixel/255 − mean) / std
 *   3. Pure JS: rearrange HWC → NCHW (channel-major)
 *
 * Returns Float32Array of length 3 × 224 × 224 = 150528.
 */
async function preprocessCLIP(filePath) {
  // --- Step 1: sharp decode + resize + raw RGB extraction ---
  // failOn:"none" avoids native VIPS assertions on unusual color spaces.
  // removeAlpha() ensures 3-channel RGB output.
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .resize(CLIP_SIZE, CLIP_SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== CLIP_SIZE || height !== CLIP_SIZE) {
    throw new Error(
      `sharp resize mismatch: expected ${CLIP_SIZE}×${CLIP_SIZE}, got ${width}×${height}`
    );
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

  // --- Step 2+3: normalize + HWC→NCHW rearrangement ---
  const pixelsPerChannel = CLIP_SIZE * CLIP_SIZE;
  const floatData = new Float32Array(3 * pixelsPerChannel);

  for (let y = 0; y < CLIP_SIZE; y++) {
    for (let x = 0; x < CLIP_SIZE; x++) {
      const srcIdx = (y * CLIP_SIZE + x) * channels;
      for (let c = 0; c < 3; c++) {
        const pixel = rgb[srcIdx + c] / 255.0;
        const normalized = (pixel - CLIP_MEAN[c]) / CLIP_STD[c];
        // NCHW: channel c, row y, col x
        floatData[c * pixelsPerChannel + y * CLIP_SIZE + x] = normalized;
      }
    }
  }

  return floatData;
}

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
    const { AutoProcessor, CLIPVisionModelWithProjection, env, Tensor } =
      await import("@xenova/transformers");

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

    // Load model only — image preprocessing is done manually via sharp
    // to avoid the ONNX-WASM ↔ libvips GLib conflict.
    const model = await CLIPVisionModelWithProjection.from_pretrained(
      MODEL_ID,
      { quantized: true }
    );

    // Also load processor as fallback for images that fail manual preprocessing
    let processor = null;
    try {
      processor = await AutoProcessor.from_pretrained(MODEL_ID);
    } catch {
      console.error("[Worker] AutoProcessor unavailable — manual-only mode");
    }

    console.error(
      `[Worker] Model loaded, embedding ${photos.length} photos (manual-tensor pipeline)`
    );

    const results = [];
    for (let i = 0; i < photos.length; i++) {
      const photo = photos[i];
      try {
        let output;

        // --- Primary path: manual tensor construction (sharp-only preprocessing) ---
        // This avoids the GLib conflict because sharp resources are released
        // before the ONNX session runs inference.
        try {
          const floatData = await preprocessCLIP(photo.path);
          const pixelValues = new Tensor("float32", floatData, [
            1,
            3,
            CLIP_SIZE,
            CLIP_SIZE,
          ]);
          output = await model({ pixel_values: pixelValues });
        } catch (manualErr) {
          // --- Fallback: transformers.js RawImage + AutoProcessor ---
          // Used when manual preprocessing fails (e.g., unusual image formats
          // that sharp can't handle in raw mode).
          if (!processor) {
            throw manualErr;
          }

          console.error(
            `[Worker] Manual tensor failed for ${path.basename(photo.path)}, trying AutoProcessor: ${manualErr.message}`
          );

          // Re-read image through transformers.js RawImage pipeline
          const { RawImage } = await import("@xenova/transformers");
          let image;
          try {
            const { data: imgData, info: imgInfo } = await sharp(
              photo.path,
              { failOn: "none" }
            )
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });

            image = new RawImage(
              new Uint8ClampedArray(
                imgData.buffer,
                imgData.byteOffset,
                imgData.byteLength
              ),
              imgInfo.width,
              imgInfo.height,
              imgInfo.channels
            );
          } catch {
            // Last resort: PNG conversion normalize
            const pngBuffer = await sharp(photo.path, { failOn: "none" })
              .png()
              .toBuffer();
            const { data: pngData, info: pngInfo } = await sharp(pngBuffer)
              .ensureAlpha()
              .raw()
              .toBuffer({ resolveWithObject: true });
            image = new RawImage(
              new Uint8ClampedArray(
                pngData.buffer,
                pngData.byteOffset,
                pngData.byteLength
              ),
              pngInfo.width,
              pngInfo.height,
              pngInfo.channels
            );
          }

          const inputs = await processor(image);
          output = await model(inputs);
        }

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
