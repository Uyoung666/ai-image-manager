import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const projectRoot = path.resolve(import.meta.dirname, "..");
const sourceIcon = path.join(projectRoot, "assets", "icons", "icon-1024.png");
const outputDirectory = path.join(projectRoot, "assets", "installers");

const dialogPath = path.join(outputDirectory, "wix-dialog.jpg");
const bannerPath = path.join(outputDirectory, "wix-banner.jpg");

const dialogBackground = Buffer.from(`
  <svg width="493" height="312" viewBox="0 0 493 312" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="panel" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#181324"/>
        <stop offset="0.48" stop-color="#5c315f"/>
        <stop offset="1" stop-color="#25284f"/>
      </linearGradient>
      <radialGradient id="glowPink" cx="0" cy="0" r="1" gradientTransform="translate(26 62) rotate(35) scale(155 180)">
        <stop stop-color="#ff8eb5" stop-opacity="0.68"/>
        <stop offset="1" stop-color="#ff8eb5" stop-opacity="0"/>
      </radialGradient>
      <radialGradient id="glowBlue" cx="0" cy="0" r="1" gradientTransform="translate(143 245) rotate(-120) scale(148 180)">
        <stop stop-color="#7878ff" stop-opacity="0.72"/>
        <stop offset="1" stop-color="#7878ff" stop-opacity="0"/>
      </radialGradient>
    </defs>
    <rect width="493" height="312" fill="#fafafd"/>
    <rect width="164" height="312" fill="url(#panel)"/>
    <rect width="164" height="312" fill="url(#glowPink)"/>
    <rect width="164" height="312" fill="url(#glowBlue)"/>
    <rect x="163" width="1" height="312" fill="#dad9e4"/>
  </svg>
`);

const bannerBackground = Buffer.from(`
  <svg width="493" height="58" viewBox="0 0 493 58" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="banner" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#ffffff"/>
        <stop offset="0.72" stop-color="#f7f4fb"/>
        <stop offset="1" stop-color="#eeeefa"/>
      </linearGradient>
    </defs>
    <rect width="493" height="58" fill="url(#banner)"/>
    <rect y="57" width="493" height="1" fill="#d9d7e2"/>
  </svg>
`);

function createRoundedIcon(size) {
  const radius = Math.max(8, Math.round(size * 0.16));
  const mask = Buffer.from(`
    <svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
      <rect width="${size}" height="${size}" rx="${radius}" fill="#fff"/>
    </svg>
  `);
  return sharp(sourceIcon)
    .resize(size, size, { fit: "cover" })
    .composite([{ blend: "dest-in", input: mask }])
    .png()
    .toBuffer();
}

await fs.mkdir(outputDirectory, { recursive: true });

const [dialogIcon, bannerIcon] = await Promise.all([
  createRoundedIcon(112),
  createRoundedIcon(42),
]);

await Promise.all([
  sharp(dialogBackground)
    .composite([{ input: dialogIcon, left: 26, top: 100 }])
    .jpeg({ chromaSubsampling: "4:4:4", quality: 94 })
    .toFile(dialogPath),
  sharp(bannerBackground)
    .composite([{ input: bannerIcon, left: 443, top: 8 }])
    .jpeg({ chromaSubsampling: "4:4:4", quality: 94 })
    .toFile(bannerPath),
]);

console.log(
  `[wix-branding] generated ${path.relative(projectRoot, dialogPath)}`
);
console.log(
  `[wix-branding] generated ${path.relative(projectRoot, bannerPath)}`
);
