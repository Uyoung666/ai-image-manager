import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const directory = path.dirname(fileURLToPath(import.meta.url));
const width = 2400;
const height = 1500;
const screenshotWidth = 2160;
const titleBarHeight = 48;
const radius = 24;

for (const language of ["zh", "en"]) {
  const source = path.join(directory, `screenshot-${language}-2026-10-30.png`);
  const metadata = await sharp(source).metadata();
  if (metadata.width !== 2560 || metadata.height !== 1600) {
    throw new Error(`Unexpected screenshot dimensions: ${source}`);
  }
  const screenshotHeight = Math.round(
    ((metadata.height - titleBarHeight) * screenshotWidth) / metadata.width
  );
  const left = (width - screenshotWidth) / 2;
  const top = Math.floor((height - screenshotHeight) / 2);
  const mask = Buffer.from(
    `<svg width="${screenshotWidth}" height="${screenshotHeight}"><rect width="100%" height="100%" rx="${radius}" fill="white"/></svg>`
  );
  const screenshot = await sharp(source)
    .extract({
      left: 0,
      top: titleBarHeight,
      width: metadata.width,
      height: metadata.height - titleBarHeight,
    })
    .resize(screenshotWidth, screenshotHeight)
    .composite([{ input: mask, blend: "dest-in" }])
    .png()
    .toBuffer();
  const shadow = await sharp(
    Buffer.from(
      `<svg width="${width}" height="${height}"><rect x="${left}" y="${top + 18}" width="${screenshotWidth}" height="${screenshotHeight}" rx="${radius}" fill="#362665" fill-opacity="0.18"/></svg>`
    )
  )
    .blur(24)
    .png()
    .toBuffer();
  const composite = await sharp(path.join(directory, "background.png"))
    .resize(width, height, { fit: "cover" })
    .composite([{ input: shadow }, { input: screenshot, left, top }])
    .png()
    .toBuffer();
  const output = path.join(directory, `hero-${language}.webp`);
  await sharp(composite)
    .webp({ quality: 92, effort: 6, smartSubsample: true })
    .toFile(output);
  const { size } = await fs.stat(output);
  console.log(`${path.basename(output)}: ${width}×${height}, ${size} bytes`);
}
