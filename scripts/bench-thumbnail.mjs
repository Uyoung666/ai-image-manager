// Quick sharp optimization benchmark for Electron
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import sharp from "sharp";

const TEST_DIR = "D:/8806/ai-image-manager测试用例";
const files = fs.readdirSync(TEST_DIR).filter((f) => /\.jpe?g$/i.test(f));
const sample = path.join(TEST_DIR, files[250]);

async function bench(label, fn) {
  // Warmup
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
  console.log("=== sharp optimization benchmarks ===");
  console.log(`Image: ${path.basename(sample)}`);

  // Baseline
  await bench("effort=4 q=85 (baseline)", async () => {
    await sharp(sample)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 4 })
      .toBuffer();
  });

  // effort=1
  await bench("effort=1 q=85          ", async () => {
    await sharp(sample)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 85, effort: 1 })
      .toBuffer();
  });

  // effort=1, quality=80
  await bench("effort=1 q=80          ", async () => {
    await sharp(sample)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .webp({ quality: 80, effort: 1 })
      .toBuffer();
  });

  // JPEG output
  await bench("jpeg  q=80             ", async () => {
    await sharp(sample)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
  });

  // Just decode + resize (no encode)
  await bench("decode+resize only     ", async () => {
    await sharp(sample)
      .resize(512, 512, { fit: "inside", withoutEnlargement: true })
      .raw()
      .toBuffer();
  });

  // Just decode metadata
  await bench("decode metadata only   ", async () => {
    await sharp(sample).metadata();
  });

  console.log("\n=== 结论 ===");
  console.log("JPEG解码(metadata): 显示纯解码开销");
  console.log("decode+resize: 解码+缩放的原始开销");
  console.log("effort=1 vs 4: WebP编码effort的影响");
  console.log("jpeg vs webp: 输出格式的影响");
}

main().catch((e) => console.error(e));
