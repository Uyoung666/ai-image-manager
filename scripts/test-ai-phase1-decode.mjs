/**
 * Phase 1: Decode images with sharp (before ONNX corrupts GLib).
 * Saves raw RGBA pixel data to temp files.
 * Usage: npx electron scripts/test-ai-phase1-decode.mjs
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import sharp from "sharp";

const TEST_IMAGES_DIR = process.argv[2] || "D:/8806/ai-image-manager测试用例";
const DECODE_DIR = path.join(os.tmpdir(), "ai-image-manager-decoded");

if (!fs.existsSync(DECODE_DIR)) fs.mkdirSync(DECODE_DIR, { recursive: true });

const files = fs.readdirSync(TEST_IMAGES_DIR)
  .filter((f) => /\.jpe?g$/i.test(f))
  .filter((f) => {
    try { return fs.statSync(path.join(TEST_IMAGES_DIR, f)).size > 1024; }
    catch { return false; }
  });

const SAMPLE = Math.min(20, files.length);
const sampleFiles = [];
for (let i = 10; sampleFiles.length < SAMPLE && i < files.length; i += Math.max(1, Math.floor(files.length / SAMPLE))) {
  sampleFiles.push(files[i]);
}

console.log(`Decoding ${sampleFiles.length} images...`);
const manifest = [];
for (const f of sampleFiles) {
  const fp = path.join(TEST_IMAGES_DIR, f);
  try {
    const { data, info } = await sharp(fp)
      .resize(224, 224, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const outPath = path.join(DECODE_DIR, f + ".raw");
    // Save: width(4B) + height(4B) + channels(4B) + pixelData
    const header = Buffer.alloc(12);
    header.writeInt32LE(info.width, 0);
    header.writeInt32LE(info.height, 4);
    header.writeInt32LE(info.channels, 8);
    fs.writeFileSync(outPath, Buffer.concat([header, data]));
    manifest.push({ file: f, path: outPath, w: info.width, h: info.height, c: info.channels });
  } catch { /* skip */ }
}

fs.writeFileSync(path.join(DECODE_DIR, "manifest.json"), JSON.stringify(manifest));
console.log(`${manifest.length} images decoded to ${DECODE_DIR}`);
console.log("MANIFEST:" + path.join(DECODE_DIR, "manifest.json"));
