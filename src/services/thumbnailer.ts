import sharp from "sharp";
import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import { app } from "electron";

const THUMBNAIL_SIZES = {
  sm: 160,
  md: 320,
  lg: 640,
} as const;

type ThumbSize = keyof typeof THUMBNAIL_SIZES;

let thumbnailDir: string;
let memoryCache: LRUCache<string, Buffer>;

export function initThumbnailer(): void {
  thumbnailDir = path.join(app.getPath("userData"), "thumbnails");
  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  memoryCache = new LRUCache<string, Buffer>({
    max: 200,
    maxSize: 100 * 1024 * 1024, // 100MB
    sizeCalculation: (value) => value.byteLength,
  });
}

function getThumbnailPath(imagePath: string, size: ThumbSize): string {
  const hash = crypto.createHash("md5").update(`${imagePath}_${size}`).digest("hex");
  return path.join(thumbnailDir, `${hash}.jpg`);
}

export async function generateThumbnail(
  imagePath: string,
  size: ThumbSize = "md"
): Promise<{ thumbnailPath: string; width: number; height: number }> {
  const cacheKey = `${imagePath}_${size}`;

  // L1: memory
  const cached = memoryCache?.get(cacheKey);
  const thumbPath = getThumbnailPath(imagePath, size);

  // L2: disk
  if (!cached && fs.existsSync(thumbPath)) {
    const diskData = fs.readFileSync(thumbPath);
    memoryCache?.set(cacheKey, diskData);
    const meta = await sharp(thumbPath).metadata();
    return { thumbnailPath: thumbPath, width: meta.width || 0, height: meta.height || 0 };
  }

  if (cached) {
    return { thumbnailPath: thumbPath, width: THUMBNAIL_SIZES[size], height: THUMBNAIL_SIZES[size] };
  }

  // L3: generate
  const targetSize = THUMBNAIL_SIZES[size];
  const thumbBuffer = await sharp(imagePath)
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 75, mozjpeg: true })
    .toBuffer();

  fs.writeFileSync(thumbPath, thumbBuffer);
  memoryCache?.set(cacheKey, thumbBuffer);

  const meta = await sharp(thumbPath).metadata();
  return { thumbnailPath: thumbPath, width: meta.width || 0, height: meta.height || 0 };
}

export async function getThumbnailBuffer(
  imagePath: string,
  size: ThumbSize = "md"
): Promise<Buffer> {
  const { thumbnailPath: thumbPath } = await generateThumbnail(imagePath, size);
  return fs.readFileSync(thumbPath);
}

export function clearThumbnailCache(): void {
  memoryCache?.clear();
}
