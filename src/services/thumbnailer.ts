import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { screen } from "electron";
import { LRUCache } from "lru-cache";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getDataPath } from "@/utils/data-path";
import { extractRawPreview, isRawFile } from "./raw-preview";

// Base sizes at 1x DPI — actual generation size is multiplied by devicePixelRatio
const THUMBNAIL_BASE_SIZES = {
  sm: 256,
  md: 512,
  lg: 800,
} as const;

type ThumbSize = keyof typeof THUMBNAIL_BASE_SIZES;

// ── 对比预览 (Duel Preview) — PK 选片专用高质量预览 ─────────────────

/** 对比预览长边像素（Lightroom Smart Preview 同款 2560px） */
const DUEL_PREVIEW_LONG_EDGE = 2560;

/** 对比预览 JPEG 质量（92 = 接近无损的视觉质量） */
const DUEL_PREVIEW_QUALITY = 92;

/** 浏览器原生支持且不需要转换的格式 */
const BROWSER_NATIVE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".bmp",
  ".gif",
  ".avif",
]);

interface ThumbnailCacheConfig {
  cleanupThresholdMB: number;
  maxDiskFiles: number;
  maxDiskMB: number;
  maxMemoryMB: number;
}

const CACHE_CONFIG: ThumbnailCacheConfig = {
  maxMemoryMB: 250,
  maxDiskMB: 3072, // 3GB（含对比预览 .jpg）
  maxDiskFiles: 15_000,
  cleanupThresholdMB: 2700, // 2.7GB 触发清理
};

let thumbnailDir: string;
let memoryCache: LRUCache<string, Buffer>;
interface ThumbnailResult {
  height: number;
  thumbnailPath: string;
  width: number;
}
let dprScale = 2; // default to 2x for HiDPI displays
const diskAccessLog = new Map<string, number>();
const inFlightRequests = new Map<string, Promise<ThumbnailResult>>();

export function initThumbnailer(): void {
  thumbnailDir = path.join(getDataPath(), "thumbnails");
  if (!fs.existsSync(thumbnailDir)) {
    fs.mkdirSync(thumbnailDir, { recursive: true });
  }

  try {
    const primaryDisplay = screen.getPrimaryDisplay();
    dprScale = Math.min(Math.ceil(primaryDisplay.scaleFactor), 3);
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
    .update(`${imagePath}_${size}_v3_${dprScale}`)
    .digest("hex");
  return path.join(thumbnailDir, `${hash}.webp`);
}

// ── 对比预览路径与生成 ──────────────────────────────────────────────

/**
 * 返回对比预览的预期磁盘路径。
 * 哈希输入包含 imagePath + "duel_v1"，换版本号即可全局失效缓存。
 */
export function getDuelPreviewPath(imagePath: string): string {
  const hash = crypto
    .createHash("md5")
    .update(`${imagePath}_duel_v1`)
    .digest("hex");
  return path.join(thumbnailDir, `${hash}.jpg`);
}

/**
 * 判断是否需要为某张照片生成对比预览。
 * - 长边 ≤ 2560px 的浏览器原生格式 → 直接用原图即可
 * - RAW / HEIC / TIFF / 超大 JPEG → 需要生成预览
 */
export function getDuelPreviewStrategy(
  _imagePath: string,
  width: number,
  height: number,
  format: string
): "use_original" | "generate" {
  const longEdge = Math.max(width, height);
  const ext = format.toLowerCase();

  // 浏览器原生格式且尺寸较小 → 直接用原图
  if (
    longEdge <= DUEL_PREVIEW_LONG_EDGE &&
    BROWSER_NATIVE_EXTENSIONS.has(`.${ext}`)
  ) {
    return "use_original";
  }

  return "generate";
}

/**
 * 生成对比预览（2560px 长边 JPEG Q92）。
 * - RAW: 先提取内嵌 JPEG 预览，再 resize
 * - JPEG/PNG/WebP 等: 直接 sharp resize
 * - withoutEnlargement: true 保证不放大比 2560px 还小的原图
 * - 返回 null 表示生成失败（调用方回退到原图）
 */
export async function generateDuelPreview(
  imagePath: string
): Promise<{ previewPath: string; width: number; height: number } | null> {
  const cacheKey = `${imagePath}_duel`;
  const previewPath = getDuelPreviewPath(imagePath);

  // L2: 磁盘
  try {
    await fs.promises.access(previewPath);
    try {
      const meta = await sharp(previewPath).metadata();
      return {
        previewPath,
        width: meta.width || 0,
        height: meta.height || 0,
      };
    } catch {
      // 文件损坏 → 删除并重新生成
      try {
        await fs.promises.unlink(previewPath);
      } catch {
        /* skip */
      }
    }
  } catch {
    // 文件不存在，继续生成
  }

  // L3: 生成（inflight 去重，同 generateThumbnail 模式）
  const existing = inFlightRequests.get(cacheKey);
  if (existing) {
    // 复用进行中的 Promise（类型不同但模式相同）
    return existing as unknown as Promise<{
      previewPath: string;
      width: number;
      height: number;
    } | null>;
  }

  const promise = doGenerateDuelPreview(imagePath, previewPath, cacheKey);
  inFlightRequests.set(
    cacheKey,
    promise as unknown as Promise<ThumbnailResult>
  );

  try {
    return await promise;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

async function doGenerateDuelPreview(
  imagePath: string,
  previewPath: string,
  _cacheKey: string
): Promise<{ previewPath: string; width: number; height: number } | null> {
  let input: string | Buffer = imagePath;
  if (isRawFile(imagePath)) {
    const preview = await extractRawPreview(imagePath);
    if (!preview) {
      return null;
    }
    input = preview;
  }

  const pipeline = sharp(input, { failOn: "none" })
    .rotate()
    .resize(DUEL_PREVIEW_LONG_EDGE, DUEL_PREVIEW_LONG_EDGE, {
      fit: "inside",
      withoutEnlargement: true,
    })
    .jpeg({ quality: DUEL_PREVIEW_QUALITY });

  const { data, info } = await pipeline.toBuffer({ resolveWithObject: true });
  await fs.promises.writeFile(previewPath, data);

  return {
    previewPath,
    width: info.width,
    height: info.height,
  };
}

/**
 * 删除单张照片的对比预览文件。
 */
export async function deleteDuelPreview(imagePath: string): Promise<void> {
  if (!thumbnailDir) {
    return;
  }
  const previewPath = getDuelPreviewPath(imagePath);
  try {
    await fs.promises.access(previewPath);
    await fs.promises.unlink(previewPath).catch(() => {
      /* ignore */
    });
  } catch {
    /* best-effort */
  }
}

export async function checkAndCleanDiskCache(): Promise<{
  cleaned: boolean;
  freedMB: number;
  filesRemoved: number;
}> {
  const usage = await getThumbnailDiskUsage();
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

  if (thumbnailDir) {
    try {
      await fs.promises.access(thumbnailDir);
      const entries = await fs.promises.readdir(thumbnailDir);
      for (const entry of entries) {
        const entryPath = path.join(thumbnailDir, entry);
        try {
          const stat = await fs.promises.stat(entryPath);
          if (stat.isFile()) {
            const atime = diskAccessLog.get(entry) || stat.atimeMs;
            files.push({ path: entryPath, atime, size: stat.size });
          }
        } catch {
          /* skip */
        }
      }
    } catch {
      /* directory inaccessible */
    }
  }

  // Sort by access time (oldest first)
  files.sort((a, b) => a.atime - b.atime);

  const targetMB = CACHE_CONFIG.maxDiskMB * 0.7;
  let currentMB = usageMB;
  let filesRemoved = 0;
  let freedBytes = 0;

  for (const file of files) {
    if (
      currentMB <= targetMB &&
      filesRemoved >= usage.fileCount - CACHE_CONFIG.maxDiskFiles
    ) {
      break;
    }

    try {
      await fs.promises.unlink(file.path);
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
): Promise<ThumbnailResult> {
  const cacheKey = `${imagePath}_${size}`;

  // L1: memory
  const cached = memoryCache?.get(cacheKey);
  const thumbPath = getThumbnailPath(imagePath, size);
  const thumbFilename = path.basename(thumbPath);

  // Record access time
  diskAccessLog.set(thumbFilename, Date.now());

  if (cached) {
    return {
      thumbnailPath: thumbPath,
      width: getThumbnailSize(size),
      height: getThumbnailSize(size),
    };
  }

  // L2: disk
  try {
    await fs.promises.access(thumbPath);
    const diskData = await fs.promises.readFile(thumbPath);
    memoryCache?.set(cacheKey, diskData);
    const meta = await sharp(thumbPath).metadata();
    return {
      thumbnailPath: thumbPath,
      width: meta.width || 0,
      height: meta.height || 0,
    };
  } catch {
    // 不在磁盘上，继续生成
  }

  // ── 请求去重：正在生成中的缩略图直接 await 同一个 Promise ──
  const existing = inFlightRequests.get(cacheKey);
  if (existing) {
    return existing;
  }

  // L3: generate（去重守护）
  const promise = doGenerate(imagePath, size, thumbPath, cacheKey);
  inFlightRequests.set(cacheKey, promise);

  try {
    return await promise;
  } finally {
    inFlightRequests.delete(cacheKey);
  }
}

async function doGenerate(
  imagePath: string,
  size: ThumbSize,
  thumbPath: string,
  cacheKey: string
): Promise<ThumbnailResult> {
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
    .rotate()
    .resize(targetSize, targetSize, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85, effort: 4 });
  const { data: thumbBuffer, info } = await pipeline.toBuffer({
    resolveWithObject: true,
  });

  await fs.promises.writeFile(thumbPath, thumbBuffer);
  memoryCache?.set(cacheKey, thumbBuffer);

  // Periodically check and clean cache (1% chance per generation)
  if (Math.random() < 0.01) {
    setTimeout(() => {
      checkAndCleanDiskCache().catch(() => {
        /* ignore */
      });
    }, 0);
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
  return await fs.promises.readFile(thumbPath);
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

export async function getThumbnailDiskUsage(): Promise<{
  dir: string;
  bytes: number;
  fileCount: number;
}> {
  const dir = thumbnailDir || "";
  let bytes = 0;
  let fileCount = 0;
  if (dir) {
    try {
      await fs.promises.access(dir);
      const entries = await fs.promises.readdir(dir);
      for (const entry of entries) {
        const entryPath = path.join(dir, entry);
        try {
          const stat = await fs.promises.stat(entryPath);
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

/**
 * Delete all thumbnail variants for a single photo from disk and memory cache.
 * Safe to call even if the photo has no thumbnails — errors are silently caught.
 */
export async function deletePhotoThumbnails(imagePath: string): Promise<void> {
  if (!thumbnailDir) {
    return;
  }

  for (const size of ["sm", "md", "lg"] as ThumbSize[]) {
    const thumbPath = getThumbnailPath(imagePath, size);
    try {
      await fs.promises.access(thumbPath);
      await fs.promises.unlink(thumbPath).catch(() => {
        /* ignore */
      });
    } catch {
      // best-effort: permission errors or locked files are not fatal
    }
    memoryCache?.delete(`${imagePath}_${size}`);
  }

  // 同时清理对比预览
  await deleteDuelPreview(imagePath);
}

export async function clearThumbnailDiskCache(): Promise<{
  fileCount: number;
  freedMB: number;
}> {
  let fileCount = 0;
  let totalBytes = 0;

  if (thumbnailDir) {
    try {
      await fs.promises.access(thumbnailDir);
      const entries = await fs.promises.readdir(thumbnailDir);
      for (const entry of entries) {
        const entryPath = path.join(thumbnailDir, entry);
        try {
          const stat = await fs.promises.stat(entryPath);
          totalBytes += stat.size;
          await fs.promises.unlink(entryPath);
          fileCount++;
        } catch {
          /* skip locked / inaccessible files */
        }
      }
    } catch {
      /* directory inaccessible */
    }
  }

  memoryCache?.clear();

  return {
    fileCount,
    freedMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
  };
}

/** Build the set of expected thumbnail filenames from DB photo records. */
function buildExpectedThumbnailSet(): Set<string> | null {
  try {
    const db = getDatabase();
    const records = db
      .select({
        path: photos.path,
        thumbnailPath: photos.thumbnailPath,
        duelPreviewPath: photos.duelPreviewPath,
      })
      .from(photos)
      .all();

    const expected = new Set<string>();
    for (const r of records) {
      if (r.thumbnailPath) {
        expected.add(path.basename(r.thumbnailPath));
      }
      if (r.duelPreviewPath) {
        expected.add(path.basename(r.duelPreviewPath));
      }
      if (r.path) {
        for (const size of ["sm", "md", "lg"] as ThumbSize[]) {
          expected.add(path.basename(getThumbnailPath(r.path, size)));
        }
        // 对比预览的确定性路径也加入预期集
        expected.add(path.basename(getDuelPreviewPath(r.path)));
      }
    }
    return expected;
  } catch {
    return null; // Database not ready
  }
}

/** Scan cache dir for orphan files with no corresponding photo record. */
export async function scanOrphanThumbnails(): Promise<{
  orphanCount: number;
  orphanSizeBytes: number;
  totalFiles: number;
}> {
  if (!thumbnailDir) {
    return { orphanCount: 0, orphanSizeBytes: 0, totalFiles: 0 };
  }
  try {
    await fs.promises.access(thumbnailDir);
  } catch {
    return { orphanCount: 0, orphanSizeBytes: 0, totalFiles: 0 };
  }

  const expectedFiles = buildExpectedThumbnailSet();
  if (!expectedFiles) {
    return { orphanCount: 0, orphanSizeBytes: 0, totalFiles: 0 };
  }

  let totalFiles = 0;
  let orphanCount = 0;
  let orphanSizeBytes = 0;

  const entries = await fs.promises.readdir(thumbnailDir);
  for (const entry of entries) {
    const isManaged = entry.endsWith(".webp") || entry.endsWith(".jpg");
    if (!isManaged) {
      continue;
    }
    totalFiles++;
    if (!expectedFiles.has(entry)) {
      try {
        orphanSizeBytes += (
          await fs.promises.stat(path.join(thumbnailDir, entry))
        ).size;
      } catch {
        /* skip inaccessible */
      }
      orphanCount++;
    }
  }

  return { orphanCount, orphanSizeBytes, totalFiles };
}

/** Delete orphan thumbnail files. Only touches confirmed orphans. */
export async function cleanOrphanThumbnails(): Promise<{
  removed: number;
  freedMB: number;
}> {
  if (!thumbnailDir) {
    return { removed: 0, freedMB: 0 };
  }
  try {
    await fs.promises.access(thumbnailDir);
  } catch {
    return { removed: 0, freedMB: 0 };
  }

  const expectedFiles = buildExpectedThumbnailSet();
  if (!expectedFiles) {
    return { removed: 0, freedMB: 0 };
  }

  let removed = 0;
  let freedBytes = 0;

  const entries = await fs.promises.readdir(thumbnailDir);
  for (const entry of entries) {
    const isManaged = entry.endsWith(".webp") || entry.endsWith(".jpg");
    if (!isManaged) {
      continue;
    }
    if (!expectedFiles.has(entry)) {
      const entryPath = path.join(thumbnailDir, entry);
      let fileSize = 0;
      try {
        fileSize = (await fs.promises.stat(entryPath)).size;
      } catch {
        continue;
      }

      try {
        await fs.promises.unlink(entryPath);
        freedBytes += fileSize;
        removed++;
      } catch (err: any) {
        console.error(
          `[Thumbnailer] Failed to delete orphan: ${entry} (code: ${err?.code || "unknown"})`
        );
      }
    }
  }

  return {
    removed,
    freedMB: Math.round((freedBytes / (1024 * 1024)) * 10) / 10,
  };
}
