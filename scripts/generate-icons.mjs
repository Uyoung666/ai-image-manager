import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import pngToIco from "png-to-ico";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const assetsDir = path.join(repoRoot, "assets");
const source = path.join(assetsDir, "icon.png");

if (!fs.existsSync(source)) {
  console.error(`[icons] source missing: ${source}`);
  process.exit(1);
}

const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
const generatedDir = path.join(assetsDir, "icons");
fs.mkdirSync(generatedDir, { recursive: true });

const pngPaths = [];
for (const size of sizes) {
  const out = path.join(generatedDir, `icon-${size}.png`);
  await sharp(source).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(out);
  pngPaths.push(out);
  console.log(`[icons] ${size}x${size} → ${path.relative(repoRoot, out)}`);
}

const icoSizes = [16, 24, 32, 48, 64, 128];
const icoInputs = icoSizes.map((s) => path.join(generatedDir, `icon-${s}.png`));
const icoBuf = await pngToIco(icoInputs);
const icoOut = path.join(assetsDir, "icon.ico");
fs.writeFileSync(icoOut, icoBuf);
console.log(`[icons] icon.ico (${icoSizes.length} sizes) → ${path.relative(repoRoot, icoOut)} (${(icoBuf.length / 1024).toFixed(1)} KB)`);
