import fs from "node:fs";
import sharp from "sharp";
import {
  applyExifOrientation,
  resolveImageOrientation,
} from "@/services/image-orientation";
import { extractRawPreview, isRawFile } from "@/services/raw-preview";

const IMAGE_SEARCH_PREVIEW_SIZE = 96;
const IMAGE_SEARCH_PREVIEW_QUALITY = 76;

export interface ImageSearchPreviewResult {
  dataUrl: string | null;
  exists: boolean;
}

export async function createImageSearchPreview(
  imagePath: string
): Promise<ImageSearchPreviewResult> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(imagePath);
  } catch {
    return { dataUrl: null, exists: false };
  }
  if (!stat.isFile()) {
    return { dataUrl: null, exists: false };
  }

  try {
    const input = isRawFile(imagePath)
      ? await extractRawPreview(imagePath)
      : imagePath;
    if (!input) {
      return { dataUrl: null, exists: true };
    }
    const metadata = await sharp(input, { failOn: "none" }).metadata();
    const orientation = await resolveImageOrientation(imagePath, metadata);
    const buffer = await applyExifOrientation(
      sharp(input, { failOn: "none" }),
      orientation
    )
      .resize(IMAGE_SEARCH_PREVIEW_SIZE, IMAGE_SEARCH_PREVIEW_SIZE, {
        fit: "cover",
        position: "centre",
        withoutEnlargement: true,
      })
      .jpeg({ quality: IMAGE_SEARCH_PREVIEW_QUALITY })
      .toBuffer();
    return {
      dataUrl: `data:image/jpeg;base64,${buffer.toString("base64")}`,
      exists: true,
    };
  } catch {
    return { dataUrl: null, exists: true };
  }
}
