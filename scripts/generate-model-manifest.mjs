#!/usr/bin/env node
/**
 * Build-time script: computes SHA256 of existing model files and prints JSON.
 *
 * Usage: node scripts/generate-model-manifest.mjs
 *
 * The output can be used to update the sha256 fields in
 * src/services/model-downloader.ts MODEL_MANIFEST.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const modelsDir = path.join(__dirname, "..", "models");

const FILES = [
  "Xenova/siglip-base-patch16-224/onnx/vision_model_quantized.onnx",
  "Xenova/siglip-base-patch16-224/onnx/text_model_quantized.onnx",
  "Xenova/opus-mt-zh-en/config.json",
  "Xenova/opus-mt-zh-en/generation_config.json",
  "Xenova/opus-mt-zh-en/source.spm",
  "Xenova/opus-mt-zh-en/special_tokens_map.json",
  "Xenova/opus-mt-zh-en/target.spm",
  "Xenova/opus-mt-zh-en/tokenizer.json",
  "Xenova/opus-mt-zh-en/tokenizer_config.json",
  "Xenova/opus-mt-zh-en/vocab.json",
  "Xenova/opus-mt-zh-en/onnx/encoder_model_quantized.onnx",
  "Xenova/opus-mt-zh-en/onnx/decoder_model_merged_quantized.onnx",
  "face/w600k_r50.onnx",
  "face/ultraface-320.onnx",
];

async function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function main() {
  const results = {};
  for (const relPath of FILES) {
    const fullPath = path.join(modelsDir, relPath);
    try {
      const sha = await sha256File(fullPath);
      results[relPath] = sha;
      console.log(`${relPath}: ${sha}`);
    } catch (err) {
      console.error(`Failed to hash ${relPath}: ${err.message}`);
    }
  }
  // Also print JSON suitable for the manifest
  console.log("\n--- JSON ---");
  console.log(JSON.stringify(results, null, 2));
}

main();
