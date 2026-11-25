import { readFile } from "node:fs/promises";
import sharp, { type OverlayOptions } from "sharp";
import { resolveHeifInput } from "./heif-input";
import {
  applyExifOrientation,
  getOrientedDimensions,
  resolveImageOrientation,
} from "./image-orientation";
import { extractRawPreview, isRawFile } from "./raw-preview";

interface Watermark {
  anchor: string;
  fontSize: number;
  imagePath?: string;
  imageScale: number;
  margin: number;
  mode: "text" | "image";
  opacity: number;
  text: string;
}

function watermarkPosition(anchor: string, margin: number, available: number) {
  if (anchor === "center") {
    return Math.round(available / 2);
  }
  return Math.max(0, anchor === "start" ? margin : available - margin);
}

async function buildWatermark(
  watermark: Watermark,
  width: number,
  height: number
): Promise<OverlayOptions> {
  const edge = Math.min(width, height);
  const margin = Math.min(
    edge - 1,
    Math.round((edge * watermark.margin) / 100)
  );
  const centerX =
    watermark.anchor.endsWith("Center") || watermark.anchor === "center";
  const centerY = watermark.anchor.startsWith("center");
  const sideX = watermark.anchor.endsWith("Left") ? "start" : "end";
  const sideY = watermark.anchor.startsWith("top") ? "start" : "end";
  const horizontal = centerX ? "center" : sideX;
  const vertical = centerY ? "center" : sideY;
  const opacity = watermark.opacity / 100;

  if (watermark.mode === "image") {
    if (!watermark.imagePath) {
      throw new Error("No watermark image configured");
    }
    const edgeLimit = Math.max(
      1,
      Math.round((edge * watermark.imageScale) / 100)
    );
    const { data, info } = await sharp(await readFile(watermark.imagePath))
      .autoOrient()
      .resize(edgeLimit, edgeLimit, { fit: "inside" })
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    for (let offset = 3; offset < data.length; offset += 4) {
      data[offset] = Math.round(data[offset] * opacity);
    }
    const left = watermarkPosition(horizontal, margin, width - info.width);
    const top = watermarkPosition(vertical, margin, height - info.height);
    return {
      input: data,
      raw: { width: info.width, height: info.height, channels: 4 },
      left: Math.min(left, width - info.width),
      top: Math.min(top, height - info.height),
    };
  }

  const text = watermark.text
    .trim()
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  if (!text) {
    throw new Error("No watermark text configured");
  }
  const fontSize = Math.min(
    watermark.fontSize,
    Math.max(1, height - 2 * margin)
  );
  const x = watermarkPosition(horizontal, margin, width);
  const y = watermarkPosition(vertical, margin, height);
  const align = horizontal === "center" ? "middle" : horizontal;
  const baseline = { start: "hanging", center: "middle", end: "baseline" }[
    vertical
  ];
  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="${opacity}" text-anchor="${align}" dominant-baseline="${baseline}">${text}</text>
</svg>`;
  return { input: Buffer.from(svg), left: 0, top: 0 };
}

export async function openDeliveryImage(source: string) {
  const raw = isRawFile(source);
  const decoded = raw
    ? await extractRawPreview(source)
    : await resolveHeifInput(source);
  if (!decoded) {
    throw new Error("No embedded RAW preview available");
  }
  const input = typeof decoded === "string" ? await readFile(decoded) : decoded;
  const pipeline = sharp(input);
  const metadata = await pipeline.metadata();
  // HEIF decoding already applies orientation. RAW previews may need the container's EXIF.
  const orientation = await resolveImageOrientation(
    raw ? source : input,
    metadata
  );
  return {
    pipeline: applyExifOrientation(pipeline, orientation),
    dimensions: getOrientedDimensions(
      metadata.width,
      metadata.height,
      orientation
    ),
  };
}

export async function renderDeliveryJpeg(
  source: string,
  target: string,
  maxWidth: number | null,
  quality: number,
  watermark?: Watermark
): Promise<{ width: number; height: number }> {
  const { pipeline, dimensions } = await openDeliveryImage(source);
  const width = Math.min(dimensions.width, maxWidth ?? dimensions.width);
  const height = Math.max(
    1,
    Math.round((dimensions.height * width) / dimensions.width)
  );
  if (width < dimensions.width) {
    pipeline.resize({ width, height, fit: "fill", withoutEnlargement: true });
  }
  if (watermark) {
    pipeline.composite([await buildWatermark(watermark, width, height)]);
  }
  const output = await pipeline.jpeg({ quality }).toFile(target);
  if (
    output.format !== "jpeg" ||
    output.width !== width ||
    output.height !== height
  ) {
    throw new Error(
      "Encoded image does not match the requested JPEG dimensions"
    );
  }
  return { width: output.width, height: output.height };
}
