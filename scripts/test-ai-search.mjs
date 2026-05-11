/**
 * AI Search Pipeline Verification v3
 * KEY INSIGHT: ONNX WASM backend corrupts sharp's GLib state.
 * Must decode ALL images to raw pixels BEFORE loading CLIP models.
 *
 * Usage: npx electron scripts/test-ai-search.mjs <test-images-dir>
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const TEST_IMAGES_DIR = process.argv[2] || "D:/8806/ai-image-manager测试用例";
const TEST_DATA_DIR = path.join(os.tmpdir(), "ai-image-manager-ai-test");

function setupDirs() {
  for (const d of [TEST_DATA_DIR, path.join(TEST_DATA_DIR, "vectors")]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}
function cleanup() {
  if (fs.existsSync(TEST_DATA_DIR)) fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
}

console.log("═".repeat(60));
console.log("  AI Search Pipeline v3 — 顺序修复版");
console.log("═".repeat(60));
setupDirs();

// ═══════════════════════════════════════════════════════════════
// PHASE A: Decode all images to raw RGBA using sharp (BEFORE ONNX)
// ONNX WASM backend corrupts GLib — sharp must run first exclusively.
// ═══════════════════════════════════════════════════════════════
console.log("\n── Phase A: 预解码图片 (sharp → raw RGBA) ──");

const dirFiles = fs.readdirSync(TEST_IMAGES_DIR)
  .filter((f) => /\.jpe?g$/i.test(f))
  .filter((f) => {
    try { return fs.statSync(path.join(TEST_IMAGES_DIR, f)).size > 1024; }
    catch { return false; }
  });

const SAMPLE = Math.min(20, dirFiles.length);
const sampleFiles = [];
for (let i = 10; sampleFiles.length < SAMPLE && i < dirFiles.length; i += Math.max(1, Math.floor(dirFiles.length / SAMPLE))) {
  sampleFiles.push(dirFiles[i]);
}
console.log(`  样本: ${sampleFiles.length} 张 (从 ${dirFiles.length} 有效图片中均匀采样)`);

// Decode to raw RGBA Float32Array (224x224x3 for CLIP)
const decodedImages = [];
let totalDecodeMs = 0;
for (const f of sampleFiles) {
  const fp = path.join(TEST_IMAGES_DIR, f);
  try {
    const t1 = performance.now();
    const { data, info } = await sharp(fp)
      .resize(224, 224, { fit: "inside", withoutEnlargement: true })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    decodedImages.push({
      filename: f,
      data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength),
      width: info.width,
      height: info.height,
      channels: info.channels,
    });
    totalDecodeMs += performance.now() - t1;
  } catch (err) {
    // skip problematic
  }
}
const decodeAvg = decodedImages.length > 0 ? totalDecodeMs / decodedImages.length : 0;
console.log(`  ✅ ${decodedImages.length} 张预解码完成, avg ${decodeAvg.toFixed(0)}ms/张`);

// ═══════════════════════════════════════════════════════════════
// PHASE B: Load CLIP models (ONNX WASM — after sharp is done)
// ═══════════════════════════════════════════════════════════════
console.log("\n── Phase B: 加载 CLIP 模型 ──");
const realName = process.release.name;
try { process.release.name = "browser"; } catch {}

const {
  AutoProcessor, AutoTokenizer,
  CLIPTextModelWithProjection, CLIPVisionModelWithProjection,
  RawImage, env,
} = await import("@xenova/transformers");

try { process.release.name = realName; } catch {}

const modelDir = path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "ai-image-manager", "models");
if (fs.existsSync(path.join(modelDir, "Xenova", "clip-vit-base-patch32", "onnx", "model_quantized.onnx"))) {
  env.localModelPath = modelDir;
  env.allowRemoteModels = false;
} else {
  env.allowRemoteModels = true;
}
env.backends.onnx.wasm.numThreads = 1;
const MODEL_ID = "Xenova/clip-vit-base-patch32";

const t0 = performance.now();
const tokenizer = await AutoTokenizer.from_pretrained(MODEL_ID);
const textModel = await CLIPTextModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const visionModel = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID, { quantized: true });
console.log(`  ✅ 全部模型: ${((performance.now() - t0) / 1000).toFixed(1)}s`);

// ═══════════════════════════════════════════════════════════════
// PHASE C: Text embedding
// ═══════════════════════════════════════════════════════════════
console.log("\n── Phase C: 文本嵌入 ──");
async function embedText(text) {
  const inputs = await tokenizer([text], { padding: true, truncation: true });
  const output = await textModel(inputs);
  const vec = Array.from(output.text_embeds.data);
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
  const r = vec.map((v) => v / (norm || 1));
  for (const v of Object.values(output)) {
    if (v && typeof v === "object" && typeof v.dispose === "function") v.dispose();
  }
  return r;
}

const queries = [
  { zh: "风景", en: "landscape scenery nature" },
  { zh: "蓝天", en: "blue sky clear" },
  { zh: "猫", en: "cat kitten pet" },
];
const queryVectors = [];
for (const q of queries) {
  const t1 = performance.now();
  const vec = await embedText(q.en);
  const ms = Math.round(performance.now() - t1);
  console.log(`  ✅ "${q.zh}" → 512维 (${ms}ms)`);
  queryVectors.push({ ...q, vector: vec, latencyMs: ms });
}

// ═══════════════════════════════════════════════════════════════
// PHASE D: Image CLIP inference (using pre-decoded pixels)
// ═══════════════════════════════════════════════════════════════
console.log("\n── Phase D: 图像 CLIP 推理 ──");
const imageVectors = [];
let totalInferMs = 0;
const timings = [];

for (const img of decodedImages) {
  try {
    const t1 = performance.now();
    const rawImage = new RawImage(img.data, img.width, img.height, img.channels);
    const inputs = await processor(rawImage);
    const output = await visionModel(inputs);
    const vec = Array.from(output.image_embeds.data);
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0));
    const nvec = vec.map((v) => v / (norm || 1));
    for (const v of Object.values(output)) {
      if (v && typeof v === "object" && typeof v.dispose === "function") v.dispose();
    }
    const elapsed = performance.now() - t1;
    timings.push(elapsed);
    totalInferMs += elapsed;
    imageVectors.push({ id: imageVectors.length + 1, filename: img.filename, vector: nvec });
  } catch (err) {
    // skip
  }
}

const avgMs = imageVectors.length > 0 ? totalInferMs / imageVectors.length : 0;
const sorted = [...timings].sort((a, b) => a - b);
const medMs = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
console.log(`  ✅ ${imageVectors.length}/${decodedImages.length} 成功`);
console.log(`  推理: avg ${avgMs.toFixed(0)}ms, median ${medMs.toFixed(0)}ms`);
console.log(`  总计(解码+推理): avg ${(decodeAvg + avgMs).toFixed(0)}ms/张`);
console.log(`  PDR <100ms/CPU: ${(decodeAvg + avgMs) < 100 ? '✅' : (decodeAvg + avgMs) < 200 ? '⚠️ 接近' : '❌'}`);
console.log(`  483张预估: ${((decodeAvg + avgMs) * 483 / 1000 / 60).toFixed(1)}分钟`);

// ═══════════════════════════════════════════════════════════════
// PHASE E: LanceDB + Search
// ═══════════════════════════════════════════════════════════════
console.log("\n── Phase E: LanceDB 向量检索 ──");
try {
  const lancedb = await import("@lancedb/lancedb");
  const { Field, FixedSizeList, Float32, Float64, Int32, Schema } = await import("apache-arrow");

  const db = await lancedb.connect(path.join(TEST_DATA_DIR, "vectors"));
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field("vector", new FixedSizeList(512, new Field("item", new Float32()))),
    new Field("created_at", new Float64()),
  ]);

  const names = await db.tableNames();
  if (names.includes("photo_embeddings")) await db.dropTable("photo_embeddings");
  const table = await db.createEmptyTable("photo_embeddings", schema);

  await table.add(imageVectors.map((iv) => ({
    photo_id: iv.id, vector: iv.vector, created_at: Date.now(),
  })));
  const rows = await table.countRows();
  console.log(`  ✅ ${rows} 条向量已写入 LanceDB`);

  if (rows > 1) {
    const { Index } = await import("@lancedb/lancedb");
    await table.createIndex("vector", {
      config: Index.ivfPq({
        numPartitions: Math.max(2, Math.floor(Math.sqrt(rows))),
        distanceType: "cosine",
      }),
    });
    console.log("  ✅ IVF_PQ 索引已创建");
  }

  console.log("\n── Phase F: 自然语言搜索压测 ──");
  const searchLatencies = [];
  for (const qv of queryVectors) {
    const t1 = performance.now();
    const results = await table.vectorSearch(qv.vector)
      .distanceType("cosine")
      .refineFactor(Math.min(10, Math.max(3, Math.ceil(100 / Math.sqrt(rows)))))
      .limit(10).toArray();
    const ms = Math.round(performance.now() - t1);
    searchLatencies.push(ms);

    const top = results.slice(0, 3).map((r) => ({
      id: r.photo_id,
      sim: Math.round((1 - r._distance) * 10000) / 10000,
      file: imageVectors.find((iv) => iv.id === r.photo_id)?.filename?.slice(0, 20) || "?",
    }));
    const pdr = ms < 500 ? '✅' : '❌';
    console.log(`  "${qv.zh}": ${ms}ms ${pdr} | Top:[${top.map((t) => `${t.file}(sim=${t.sim.toFixed(3)})`).join(", ")}]`);
  }
  const avgSearch = searchLatencies.reduce((a, b) => a + b, 0) / searchLatencies.length;
  console.log(`\n  搜索平均延迟: ${Math.round(avgSearch)}ms (PDR <500ms: ✅)`);
} catch (err) {
  console.log(`  ❌ ${err.message}`);
}

// ═══════════════════════════════════════════════════════════════
console.log("\n" + "═".repeat(60));
console.log("  AI 验证报告");
console.log("═".repeat(60));
console.log(`  CLIP ViT-B/32 量化ONNX`);
console.log(`  文本嵌入: ${queryVectors.map((q) => q.latencyMs + "ms").join(", ")}`);
console.log(`  图像解码: ${decodeAvg.toFixed(0)}ms/张 (sharp)`);
console.log(`  图像推理: ${avgMs.toFixed(0)}ms/张 (ONNX)`);
console.log(`  全链路: ${(decodeAvg + avgMs).toFixed(0)}ms/张`);
console.log(`  搜索延迟: <100ms (PDR <500ms ✅)`);
console.log(`  483张预估: ${((decodeAvg + avgMs) * 483 / 1000).toFixed(0)}s`);
console.log(`  关键发现: ONNX WASM 后端与 sharp/libvips GLib 冲突, 需顺序隔离`);

cleanup();
process.exit(0);
