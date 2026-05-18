/**
 * Persistent CLIP image embedding worker.
 *
 * Runs as a child process via fork(). Loads the CLIP vision model once, then
 * processes batches as they arrive — no model reload per batch.
 *
 * IPC protocol:
 *   Parent sends: { type: "init", modelPath: "..." }
 *   Worker sends: { type: "ready" }
 *   Parent sends: { type: "embed", modelPath: "...", photos: [{ id, path }, ...] }
 *   Worker sends: { type: "result", results: [{ id, vector?, error? }] }
 *   Parent sends: { type: "shutdown" } — worker exits.
 *
 * Architecture — Manual Tensor Construction:
 *   Image preprocessing (resize, normalize, NCHW layout) uses sharp + pure
 *   JS only. CLIP vision inference runs through @xenova/transformers, which
 *   delegates to onnxruntime-node (native CPU) inside this forked child
 *   process. The historical GLib conflict only applied to ONNX WASM in the
 *   main process; the native ORT backend has no GLib dependency.
 */

import path from "node:path";
import sharp from "sharp";

process.env.ORT_WASM_NUM_THREADS = "1";

// --- CLIP ViT-B/32 preprocessing constants ---
const CLIP_SIZE = 224;
const CLIP_MEAN = [0.481_454_66, 0.457_827_5, 0.408_210_73];
const CLIP_STD = [0.268_629_54, 0.261_302_58, 0.275_777_11];

// --- Module-level model cache ---
let cachedModel = null;
let cachedProcessor = null;
let Tensor = null;

/**
 * Preprocess image: sharp decode + resize + normalize → Float32Array(NCHW).
 */
async function preprocessCLIP(filePath) {
  const { data, info } = await sharp(filePath, { failOn: "none" })
    .resize(CLIP_SIZE, CLIP_SIZE, { fit: "cover", position: "center" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  if (width !== CLIP_SIZE || height !== CLIP_SIZE) {
    throw new Error(`sharp resize mismatch: ${width}x${height}`);
  }

  const rgb = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  const pixelsPerChannel = CLIP_SIZE * CLIP_SIZE;
  const floatData = new Float32Array(3 * pixelsPerChannel);

  for (let y = 0; y < CLIP_SIZE; y++) {
    for (let x = 0; x < CLIP_SIZE; x++) {
      const srcIdx = (y * CLIP_SIZE + x) * channels;
      for (let c = 0; c < 3; c++) {
        const pixel = rgb[srcIdx + c] / 255.0;
        const normalized = (pixel - CLIP_MEAN[c]) / CLIP_STD[c];
        floatData[c * pixelsPerChannel + y * CLIP_SIZE + x] = normalized;
      }
    }
  }
  return floatData;
}

// --- Init handler: load model once ---
async function handleInit(msg) {
  const { modelPath } = msg;
  console.error(`[Worker] Loading CLIP model from: ${modelPath}`);

  const { AutoProcessor, CLIPVisionModelWithProjection, env } = await import(
    "@xenova/transformers"
  );
  const tfMod = await import("@xenova/transformers");
  Tensor = tfMod.Tensor;

  env.localModelPath = modelPath;
  env.allowRemoteModels = true;
  env.backends.onnx.wasm.numThreads = 1;

  const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/resolve/main/";
  }

  const MODEL_ID = "Xenova/clip-vit-base-patch32";

  cachedModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, {
    quantized: true,
  });

  try {
    cachedProcessor = await AutoProcessor.from_pretrained(MODEL_ID);
  } catch {
    console.error("[Worker] AutoProcessor unavailable — manual-only mode");
  }

  process.send?.({ type: "ready" });
  console.error("[Worker] Model loaded, ready for batches");
}

// --- Embed handler: process a batch ---
async function handleEmbed(msg) {
  const { photos, modelPath } = msg;

  // Auto-init if model not loaded yet (single-shot mode from embedImageInWorker)
  if (!cachedModel && modelPath) {
    await handleInit({ modelPath });
  }
  if (!(cachedModel && Tensor)) {
    process.send?.({
      type: "result",
      results: (photos || []).map((p) => ({
        id: p.id,
        error: "Model not initialized",
      })),
    });
    return;
  }

  const results = [];

  for (let i = 0; i < photos.length; i++) {
    const photo = photos[i];
    try {
      let output;

      // Primary: manual tensor construction (avoids GLib conflict)
      try {
        const floatData = await preprocessCLIP(photo.path);
        const pixelValues = new Tensor("float32", floatData, [
          1,
          3,
          CLIP_SIZE,
          CLIP_SIZE,
        ]);
        output = await cachedModel({ pixel_values: pixelValues });
      } catch (manualErr) {
        if (!cachedProcessor) {
          throw manualErr;
        }

        console.error(
          `[Worker] Manual tensor failed for ${path.basename(photo.path)}, trying AutoProcessor: ${manualErr.message}`
        );

        // Fallback: RawImage pipeline
        const { RawImage } = await import("@xenova/transformers");
        let image;
        try {
          const { data: imgData, info: imgInfo } = await sharp(photo.path, {
            failOn: "none",
          })
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

        const inputs = await cachedProcessor(image);
        output = await cachedModel(inputs);
      }

      const { image_embeds } = output;
      const vec = Array.from(image_embeds.data);
      const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
      const vector = vec.map((v) => v / (norm || 1));

      // Free tensors
      for (const v of Object.values(output)) {
        if (v && typeof v === "object" && typeof v.dispose === "function") {
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
}

// --- Message loop ---
process.on("message", async (msg) => {
  try {
    if (msg.type === "init") {
      await handleInit(msg);
    } else if (msg.type === "embed") {
      await handleEmbed(msg);
    } else if (msg.type === "shutdown") {
      console.error("[Worker] Shutting down");
      process.exit(0);
    }
  } catch (err) {
    console.error(`[Worker] Fatal error handling "${msg.type}":`, err.message);
    if (msg.type === "embed") {
      process.send?.({
        type: "result",
        results: (msg.photos || []).map((p) => ({
          id: p.id,
          error: err.message,
        })),
      });
    } else if (msg.type === "init") {
      process.send?.({ type: "ready" }); // Send anyway so pool doesn't hang
    }
  }
});
