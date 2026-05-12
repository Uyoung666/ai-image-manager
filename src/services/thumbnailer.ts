import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app, screen } from "electron";
import { LRUCache } from "lru-cache";
import sharp from "sharp";

// Base sizes at 1x DPI — actual generation size is multiplied by devicePixelRatio
const THUMBNAIL_BASE_SIZES = {
  sm: 256,
  md: 512,
  lg: 800,
} as const;

type ThumbSize = keyof typeof THUMBNAIL_BASE_SIZES;

let thumbnailDir: string;
let memoryCache: LRUCache<string, Buffer>;
let dprScale = 2; // default to 2x for HiDPI displays

export function initThumbnailer(): void {
  thumbnailDir = path.join(app.getPath("userData"), "thumbnails");
  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    dprScale = Math.min(Math.ceil(primaryDisplay.scaleFactor), 2);
  } catch {
    dprScale = 2;
  }

  memoryCache = new LRUCache<string, Buffer>({
    max: 500,
    maxSize: 250 * 1024 * 1024, // 250MB
    sizeCalculation: (value) => value.byteLength,
  });
}

function getThumbnailSize(size: ThumbSize): number {
  return THUMBNAIL_BASE_SIZES[size] * dprScale;
}

export function getThumbnailPath(imagePath: string, size: ThumbSize): string {
  const hash = crypto
    .createHash("md5")
    .update(`${imagePath}_${size}_v2_${dprScale}`)
    .digest("hex");
  return path.join(thumbnailDir, `${hash}.webp`);
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
    return {
      thumbnailPath: thumbPath,
      width: meta.width || 0,
      height: meta.height || 0,
    };
  }

  if (cached) {
    return {
      thumbnailPath: thumbPath,
      width: getThumbnailSize(size),
      height: getThumbnailSize(size),
    };
  }

  // L3: generate
  const targetSize = getThumbnailSize(size);
  const pipeline = sharp(imagePath, { failOn: "none" })
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80, effort: 1 });
  const { data: thumbBuffer, info } = await pipeline
    .toBuffer({ resolveWithObject: true });

  fs.writeFileSync(thumbPath, thumbBuffer);
  memoryCache?.set(cacheKey, thumbBuffer);

  return {
    thumbnailPath: thumbPath,
    width: info.width,
    height: info.height,
  };
}

export async function getThumbnailBuffer(
  imagePath: string,
  size: ThumbSize = "md"
): Promise<Buffer> {
  const { thumbnailPath: thumbPath } = await generateThumbnail(imagePath, size);
  return fs.readFileSync(thumbPath);
}

export function getThumbnailSizes(): Record<ThumbSize, number> {
  return {
    sm: getThumbnailSize("sm"),
    md: getThumbnailSize("md"),
    lg: getThumbnailSize("lg"),
  };
}

export function clearThumbnailCache(): void {
  memoryCache?.clear();
}

export function clearThumbnailDiskCache(): {
  fileCount: number;
  freedMB: number;
} {
  let fileCount = 0;
  let totalBytes = 0;

  if (thumbnailDir && fs.existsSync(thumbnailDir)) {
    const entries = fs.readdirSync(thumbnailDir);
    for (const entry of entries) {
      const entryPath = path.join(thumbnailDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        totalBytes += stat.size;
        fs.unlinkSync(entryPath);
        fileCount++;
      } catch {
        /* skip locked / inaccessible files */
      }
    }
  }

  memoryCache?.clear();

  return {
    fileCount,
    freedMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
  };
}
