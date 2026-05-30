import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { screen } from "electron";
import { LRUCache } from "lru-cache";
import sharp from "sharp";
import { getDataPath } from "@/utils/data-path";
import { extractRawPreview, isRawFile } from "./raw-preview";

// Base sizes at 1x DPI — actual generation size is multiplied by devicePixelRatio
const THUMBNAIL_BASE_SIZES = {
  sm: 256,
  md: 512,
  lg: 800,
} as const;

type ThumbSize = keyof typeof THUMBNAIL_BASE_SIZES;

interface ThumbnailCacheConfig {
  maxMemoryMB: number;
  maxDiskMB: number;
  maxDiskFiles: number;
  cleanupThresholdMB: number;
}

const CACHE_CONFIG: ThumbnailCacheConfig = {
  maxMemoryMB: 250,
  maxDiskMB: 2048, // 2GB
  maxDiskFiles: 10000,
  cleanupThresholdMB: 1800, // 1.8GB 触发清理
};

let thumbnailDir: string;
let memoryCache: LRUCache<string, Buffer>;
let dprScale = 2; // default to 2x for HiDPI displays
const diskAccessLog = new Map<string, number>();

export function initThumbnailer(): void {
  thumbnailDir = path.join(getDataPath(), "thumbnails");
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

export function checkAndCleanDiskCache(): {
  cleaned: boolean;
  freedMB: number;
  filesRemoved: number;
} {
  const usage = getThumbnailDiskUsage();
  const usageMB = usage.bytes / (1024 * 1024);

  if (
    usageMB < CACHE_CONFIG.cleanupThresholdMB &&
    usage.fileCount < CACHE_CONFIG.maxDiskFiles
  ) {
    return { cleaned: false, freedMB: 0, filesRemoved: 0 };
  }

  console.log(
    `[Thumbnailer] Disk cache cleanup triggered: ${usageMB.toFixed(1)}MB, ${usage.fileCount} files`
  );

  const files: Array<{ path: string; atime: number; size: number }> = [];

  if (thumbnailDir && fs.existsSync(thumbnailDir)) {
    const entries = fs.readdirSync(thumbnailDir);
    for (const entry of entries) {
      const entryPath = path.join(thumbnailDir, entry);
      try {
        const stat = fs.statSync(entryPath);
        if (stat.isFile()) {
          const atime = diskAccessLog.get(entry) || stat.atimeMs;
          files.push({ path: entryPath, atime, size: stat.size });
        }
      } catch {
        /* skip */
      }
    }
  }

  // Sort by access time (oldest first)
  files.sort((a, b) => a.atime - b.atime);

  const targetMB = CACHE_CONFIG.maxDiskMB * 0.7;
  let currentMB = usageMB;
  let filesRemoved = 0;
  let freedBytes = 0;

  for (const file of files) {
    if (currentMB <= targetMB && filesRemoved >= usage.fileCount - CACHE_CONFIG.maxDiskFiles) {
      break;
    }

    try {
      fs.unlinkSync(file.path);
      freedBytes += file.size;
      currentMB -= file.size / (1024 * 1024);
      filesRemoved++;
      diskAccessLog.delete(path.basename(file.path));
    } catch {
      /* skip */
    }
  }

  console.log(
    `[Thumbnailer] Cleaned ${filesRemoved} files, freed ${(freedBytes / (1024 * 1024)).toFixed(1)}MB`
  );

  return {
    cleaned: true,
    freedMB: freedBytes / (1024 * 1024),
    filesRemoved,
  };
}

export async function generateThumbnail(
  imagePath: string,
  size: ThumbSize = "md"
): Promise<{ thumbnailPath: string; width: number; height: number }> {
  const cacheKey = `${imagePath}_${size}`;

  // L1: memory
  const cached = memoryCache?.get(cacheKey);
  const thumbPath = getThumbnailPath(imagePath, size);
  const thumbFilename = path.basename(thumbPath);

  // Record access time
  diskAccessLog.set(thumbFilename, Date.now());

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

  // For RAW files, extract the embedded JPEG preview first
  let input: string | Buffer = imagePath;
  if (isRawFile(imagePath)) {
    const preview = await extractRawPreview(imagePath);
    if (preview) {
      input = preview;
    }
  }

  const pipeline = sharp(input, { failOn: "none" })
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 80, effort: 1 });
  const { data: thumbBuffer, info } = await pipeline.toBuffer({
    resolveWithObject: true,
  });

  fs.writeFileSync(thumbPath, thumbBuffer);
  memoryCache?.set(cacheKey, thumbBuffer);

  // Periodically check and clean cache (1% chance per generation)
  if (Math.random() < 0.01) {
    setTimeout(() => checkAndCleanDiskCache(), 0);
  }

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

export function getThumbnailDir(): string {
  return thumbnailDir || "";
}

export function getThumbnailDiskUsage(): {
  dir: string;
  bytes: number;
  fileCount: number;
} {
  const dir = thumbnailDir || "";
  let bytes = 0;
  let fileCount = 0;
  if (dir && fs.existsSync(dir)) {
    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        try {
          const stat = fs.statSync(entryPath);
          if (stat.isFile()) {
            bytes += stat.size;
            fileCount++;
          }
        } catch {
          /* skip inaccessible entries */
        }
      }
    } catch {
      /* directory unreadable */
    }
  }
  return { dir, bytes, fileCount };
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
