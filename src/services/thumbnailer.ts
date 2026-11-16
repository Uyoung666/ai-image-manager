import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { eq, or } from "drizzle-orm";
import { screen } from "electron";
import { LRUCache } from "lru-cache";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { getDataPath } from "@/utils/data-path";
import {
  GALLERY_CONFIG,
  GALLERY_THUMBNAIL_EDGES,
  type GalleryThumbnailEdge,
} from "@/utils/gallery-config";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";
import { createLogger } from "@/utils/logger";
import { resolveSafePath } from "@/utils/path-security";
import { PrioritySemaphore } from "@/utils/priority-semaphore";
import { isHeifInput } from "../../scripts/heif-decoder.mjs";
import {
  HEIF_MODEL_CACHE_PATTERN,
  heifSourcePrefix,
  invalidateHeifModelCache,
} from "../../scripts/heif-model-cache.mjs";
import { resolveHeifInput } from "./heif-input";
import {
  applyExifOrientation,
  type ExifOrientation,
  resolveImageOrientation,
} from "./image-orientation";
import { extractRawPreview, isRawFile } from "./raw-preview";
import { thumbnailSourceIdentity } from "./thumbnail-identity";
import {
  clearThumbnailValidation,
  readValidatedThumbnail,
} from "./thumbnail-validation";

const WEBP_SUFFIX = /\.webp$/;
const REPAIRED_PREVIEW_SUFFIX = /-r-[a-f0-9]{16}\.webp$/i;
const log = createLogger("thumbnailer");
const MANAGED_THUMBNAIL_EXTENSION =
  /^(?:[a-f0-9]{32}\.(?:webp|jpg)|g-[a-f0-9]{32}-[a-f0-9]{32}-(?:(?:r-[a-f0-9]{16}-)?(?:256|512|1024|2048)|v5-(?:sm|md|lg)-[1-3](?:-r-[a-f0-9]{16})?)\.webp)$/i;
const HEIF_FILE_EXTENSION = /\.hei[cf]$/i;
const HEIF_SOURCE_PREFIX = /^h-[a-f0-9]{32}-/;
const GALLERY_SOURCE_PREFIX = /^g-[a-f0-9]{32}-/;

async function removeCachedThumbnail(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath);
  memoryCache?.delete(filePath);
  const name = path.basename(filePath);
  const prefix = GALLERY_SOURCE_PREFIX.exec(name)?.[0];
  if (prefix) {
    const names = galleryVariantNames.get(prefix);
    names?.delete(name);
    if (names?.size === 0) {
      galleryVariantNames.delete(prefix);
    }
  }
  diskAccessLog.delete(name);
  knownDiskBytes -= knownDiskFiles.get(name) ?? 0;
  knownDiskFiles.delete(name);
}

// Base sizes at 1x DPI — actual generation size is multiplied by devicePixelRatio
const THUMBNAIL_BASE_SIZES = {
  sm: 256,
  md: 512,
  lg: 800,
} as const;

export type ThumbSize = keyof typeof THUMBNAIL_BASE_SIZES;

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
  maxDiskMB: 20_480, // 20GB（含对比预览 .jpg）
  maxDiskFiles: GALLERY_CONFIG.maxDiskFiles,
  cleanupThresholdMB: 18_432, // ~90% of max, triggers cleanup at 18GB
};

let thumbnailDir: string;
let memoryCache: LRUCache<string, ThumbnailResult & { buffer: Buffer }>;
interface ThumbnailResult {
  buffer?: Buffer;
  height: number;
  sourceIdentity?: string;
  stat?: fs.Stats;
  thumbnailPath: string;
  width: number;
}
interface ThumbnailOptions {
  expectedIdentity?: string;
  force?: boolean;
  input?: string | Buffer;
  orientation?: ExifOrientation;
  prepared?: boolean;
}
export interface LegacyThumbnailEvidence {
  contentRevision: number;
  metadataRevision: number;
  sourceCtimeMs: number | null;
  sourceMtimeMs: number | null;
  sourceSize: number | null;
  thumbnailPath: string | null;
}
interface DuelPreviewResult {
  height: number;
  previewPath: string;
  width: number;
}
let dprScale = 2; // default to 2x for HiDPI displays
const diskAccessLog = new Map<string, number>();
const knownDiskFiles = new Map<string, number>();
const galleryVariantNames = new Map<string, Set<string>>();
let variantDirectoryReady = false;
let variantDirectoryRead: Promise<void> | null = null;
let knownDiskBytes = 0;
let diskUsageCheckedAt = 0;
const inFlightThumbnails = new Map<string, Promise<ThumbnailResult>>();
const galleryJobs = new Map<
  string,
  {
    controller: AbortController;
    consumers: number;
    promise: Promise<ThumbnailResult>;
  }
>();
const inFlightDuelPreviews = new Map<
  string,
  Promise<DuelPreviewResult | null>
>();
let cacheClearPromise: Promise<void> | null = null;

async function waitForCacheClear(): Promise<void> {
  if (cacheClearPromise) {
    await cacheClearPromise;
  }
}

async function waitForActiveGenerations(): Promise<void> {
  await Promise.allSettled([
    ...inFlightThumbnails.values(),
    ...inFlightDuelPreviews.values(),
    ...[...galleryJobs.values()].map((job) => job.promise),
  ]);
}

// ── 生成并发控制 ────────────────────────────────────────────────────────
// 防止大量导入时 sharp 实例爆炸，限制同时执行的生成任务数。
// 复用 http-server.ts 中 ConversionSemaphore 的同款模式。

export const thumbnailGenerationSlots = new PrioritySemaphore(
  GALLERY_CONFIG.generationConcurrency
);
const genSemaphore = thumbnailGenerationSlots;

// ── 清理触发计数器（替代 1% 概率）───────────────────────────────────────
let generationCount = 0;
const CLEANUP_CHECK_INTERVAL = 50;
let lastDiskCheck = 0;
let diskCheck: Promise<{
  cleaned: boolean;
  freedMB: number;
  filesRemoved: number;
}> | null = null;
let diskCheckTimer: ReturnType<typeof setTimeout> | undefined;
let stopping = false;
let thumbnailScope = 0;

export function scheduleThumbnailMaintenance(delayMs = 0): void {
  if (
    stopping ||
    diskCheckTimer ||
    diskCheck ||
    Date.now() - lastDiskCheck < GALLERY_CONFIG.diskCheckIntervalMs
  ) {
    return;
  }
  if (delayMs > 0) {
    diskCheckTimer = setTimeout(() => {
      diskCheckTimer = undefined;
      scheduleThumbnailMaintenance();
    }, delayMs);
    diskCheckTimer.unref();
    return;
  }
  lastDiskCheck = Date.now();
  diskCheck = checkAndCleanDiskCache().finally(() => {
    diskCheck = null;
  });
  diskCheck.catch((error) =>
    log.warn({ err: error }, "Thumbnail cache maintenance failed")
  );
}

function cancelThumbnailBackgroundWork(): void {
  thumbnailScope++;
  stopping = true;
  clearTimeout(diskCheckTimer);
  diskCheckTimer = undefined;
  for (const job of galleryJobs.values()) {
    job.controller.abort();
  }
  memoryCache?.clear();
  clearThumbnailValidation();
}
registerGalleryCleanup(cancelThumbnailBackgroundWork);

export async function stopThumbnailer(): Promise<void> {
  cancelThumbnailBackgroundWork();
  await Promise.allSettled([
    waitForActiveGenerations(),
    diskCheck,
    cacheClearPromise,
    variantDirectoryRead,
  ]);
}

export function initThumbnailer(): void {
  thumbnailScope++;
  clearTimeout(diskCheckTimer);
  diskCheckTimer = undefined;
  stopping = false;
  clearThumbnailValidation();
  lastDiskCheck = 0;
  knownDiskFiles.clear();
  galleryVariantNames.clear();
  variantDirectoryReady = false;
  variantDirectoryRead = null;
  diskAccessLog.clear();
  knownDiskBytes = 0;
  diskUsageCheckedAt = 0;
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

  memoryCache = new LRUCache<string, ThumbnailResult & { buffer: Buffer }>({
    max: 500,
    maxSize: 250 * 1024 * 1024, // 250MB
    sizeCalculation: (value) => value.buffer.byteLength,
  });

  reconcileThumbnailCachePaths();
  scheduleThumbnailMaintenance(GALLERY_CONFIG.initialDiskAuditDelayMs);
}

/**
 * A stored reference belongs to the photo, even if its source path moved.
 * Never replace it with a different file solely because its name is current.
 */
function reconcileThumbnailCachePaths(): void {
  try {
    const db = getDatabase();
    const records = db
      .select({
        id: photos.id,
        thumbnailPath: photos.thumbnailPath,
        duelPreviewPath: photos.duelPreviewPath,
      })
      .from(photos)
      .all();

    let updated = 0;
    db.transaction((tx) => {
      for (const record of records) {
        const expectedThumbnailPath = reconcileThumbnailReference(
          record.thumbnailPath
        );
        const thumbnailChanged = record.thumbnailPath !== expectedThumbnailPath;
        const expectedDuelPath = reconcileThumbnailReference(
          record.duelPreviewPath
        );
        const duelChanged = record.duelPreviewPath !== expectedDuelPath;
        if (!(thumbnailChanged || duelChanged)) {
          continue;
        }

        tx.update(photos)
          .set({
            thumbnailPath: expectedThumbnailPath,
            duelPreviewPath: expectedDuelPath,
          })
          .where(eq(photos.id, record.id))
          .run();
        updated++;
      }
    });

    if (updated > 0) {
      log.info(
        `[Thumbnailer] Reconciled ${updated} managed photo cache reference(s)`
      );
    }
  } catch (err) {
    log.warn(
      `[Thumbnailer] Cache reference upgrade skipped: ${(err as Error)?.message ?? String(err)}`
    );
  }
}

function isStoredThumbnailName(filePath: string): boolean {
  if (
    !(thumbnailDir && MANAGED_THUMBNAIL_EXTENSION.test(path.basename(filePath)))
  ) {
    return false;
  }
  const dir = path.resolve(path.dirname(filePath));
  const managed = path.resolve(thumbnailDir);
  return process.platform === "win32"
    ? dir.toLowerCase() === managed.toLowerCase()
    : dir === managed;
}

function reconcileThumbnailReference(filePath: string | null): string | null {
  if (filePath && isStoredThumbnailName(filePath)) {
    return filePath;
  }
  if (
    filePath &&
    path.basename(path.dirname(filePath)).toLowerCase() === "thumbnails" &&
    MANAGED_THUMBNAIL_EXTENSION.test(path.basename(filePath))
  ) {
    // Data directory migration copies the cache with the same file names.
    const copied = path.join(thumbnailDir, path.basename(filePath));
    const safe = resolveSafePath(copied, [thumbnailDir]);
    if (safe && fs.existsSync(safe)) {
      return copied;
    }
  }
  return null;
}

export function getThumbnailSize(size: ThumbSize): number {
  return THUMBNAIL_BASE_SIZES[size] * dprScale;
}

export function getThumbnailPath(imagePath: string, size: ThumbSize): string {
  const hash = crypto
    .createHash("md5")
    .update(`${imagePath}_${size}_v4_${dprScale}`)
    .digest("hex");
  return path.join(thumbnailDir, `${hash}.webp`);
}

export function getVersionedThumbnailPath(
  imagePath: string,
  size: ThumbSize,
  identity: string
): string {
  return path.join(
    thumbnailDir,
    `${gallerySourcePrefix(imagePath)}${identity}-v5-${size}-${dprScale}.webp`
  );
}

async function writeFileAtomic(
  targetPath: string,
  data: Buffer
): Promise<void> {
  const tempPath = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, data);
    await fs.promises.rename(tempPath, targetPath);
    const filename = path.basename(targetPath);
    knownDiskBytes += data.byteLength - (knownDiskFiles.get(filename) ?? 0);
    knownDiskFiles.set(filename, data.byteLength);
    indexGalleryVariant(filename);
    diskAccessLog.set(filename, Date.now());
  } catch (err) {
    await removeCachedThumbnail(tempPath).catch(() => {
      /* ignore */
    });
    throw err;
  }
}

// ── 对比预览路径与生成 ──────────────────────────────────────────────

/**
 * 返回对比预览的预期磁盘路径。
 * 哈希输入包含 imagePath + "duel_v1"，换版本号即可全局失效缓存。
 */
export function getDuelPreviewPath(
  imagePath: string,
  identity?: string
): string {
  const hash = crypto
    .createHash("md5")
    .update(
      identity ? `${imagePath}_duel_v3_${identity}` : `${imagePath}_duel_v2`
    )
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
  imagePath: string,
  expectedIdentity?: string
): Promise<DuelPreviewResult | null> {
  if (stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  await waitForCacheClear();
  const scope = thumbnailScope;
  const source = await fs.promises.stat(imagePath);
  const identity = thumbnailSourceIdentity(source);
  assertThumbnailSource(source, scope, expectedIdentity ?? identity);
  const previewPath = getDuelPreviewPath(imagePath, identity);

  // L2: 磁盘
  const cached = await sharp(previewPath)
    .metadata()
    .catch(() => undefined);
  if (cached?.width && cached.height) {
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    return { previewPath, width: cached.width, height: cached.height };
  }

  // L3: 生成（inflight 去重，同 generateThumbnail 模式）
  if (stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  const existing = inFlightDuelPreviews.get(previewPath);
  if (existing) {
    // 复用进行中的 Promise（类型不同但模式相同）
    return existing;
  }

  const promise = doGenerateDuelPreview(
    imagePath,
    previewPath,
    identity,
    scope
  );
  inFlightDuelPreviews.set(previewPath, promise);

  try {
    return await promise;
  } finally {
    inFlightDuelPreviews.delete(previewPath);
  }
}

async function doGenerateDuelPreview(
  imagePath: string,
  previewPath: string,
  identity: string,
  scope: number
): Promise<DuelPreviewResult | null> {
  await genSemaphore.acquire();
  let written = false;
  try {
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    // 生成前检查：如果存在损坏文件，先删除
    try {
      await fs.promises.access(previewPath);
      try {
        await sharp(previewPath).metadata();
      } catch {
        // 文件存在但损坏 → 删除
        await removeCachedThumbnail(previewPath).catch(() => {
          /* ignore */
        });
      }
    } catch {
      // 文件不存在，正常继续
    }

    let input: string | Buffer = imagePath;
    if (isRawFile(imagePath)) {
      const preview = await extractRawPreview(imagePath);
      if (!preview) {
        return null;
      }
      input = preview;
    }

    input = await resolveHeifInput(input);
    if (typeof input === "string") {
      input = await fs.promises.readFile(input);
    }
    const inputMetadata = await sharp(input, { failOn: "none" }).metadata();
    const orientation = await resolveImageOrientation(imagePath, inputMetadata);
    const pipeline = applyExifOrientation(
      sharp(input, { failOn: "none" }),
      orientation
    )
      .resize(DUEL_PREVIEW_LONG_EDGE, DUEL_PREVIEW_LONG_EDGE, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: DUEL_PREVIEW_QUALITY });

    const { data, info } = await pipeline.toBuffer({
      resolveWithObject: true,
    });
    if (!(info.width && info.height)) {
      return null;
    }
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    await writeFileAtomic(previewPath, data);
    written = true;
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);

    // 计入生成计数器（与缩略图共享清理触发）
    generationCount++;
    if (generationCount >= CLEANUP_CHECK_INTERVAL) {
      generationCount = 0;
      setTimeout(() => {
        scheduleThumbnailMaintenance();
      }, 0);
    }

    return {
      previewPath,
      width: info.width,
      height: info.height,
    };
  } catch (error) {
    if (written) {
      await deleteUnreferencedThumbnail(previewPath);
    }
    throw error;
  } finally {
    genSemaphore.release();
  }
}

/**
 * 删除单张照片的对比预览文件。
 */
export async function deleteDuelPreview(imagePath: string): Promise<void> {
  if (!thumbnailDir) {
    return;
  }
  const previewPath = getDuelPreviewPath(imagePath);
  if (!inFlightDuelPreviews.has(previewPath)) {
    await deleteUnreferencedThumbnail(previewPath);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded cache cleanup tolerates per-file races while preserving managed-file-only deletion.
export async function checkAndCleanDiskCache(): Promise<{
  cleaned: boolean;
  freedMB: number;
  filesRemoved: number;
}> {
  const scope = thumbnailScope;
  const usage = await getThumbnailDiskUsage();
  if (scope !== thumbnailScope) {
    return { cleaned: false, freedMB: 0, filesRemoved: 0 };
  }
  const usageMB = usage.bytes / (1024 * 1024);

  if (
    usageMB < CACHE_CONFIG.cleanupThresholdMB &&
    usage.fileCount < CACHE_CONFIG.maxDiskFiles
  ) {
    return { cleaned: false, freedMB: 0, filesRemoved: 0 };
  }

  log.info(
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
          if (
            stat.isFile() &&
            (MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
              HEIF_MODEL_CACHE_PATTERN.test(entry))
          ) {
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
    if (scope !== thumbnailScope) {
      break;
    }
    if (
      currentMB <= targetMB &&
      filesRemoved >= usage.fileCount - CACHE_CONFIG.maxDiskFiles
    ) {
      break;
    }

    try {
      await removeCachedThumbnail(file.path);
      freedBytes += file.size;
      currentMB -= file.size / (1024 * 1024);
      filesRemoved++;
      diskAccessLog.delete(path.basename(file.path));
    } catch {
      /* skip */
    }
  }

  log.info(
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
  size: ThumbSize = "md",
  options: ThumbnailOptions = {}
): Promise<ThumbnailResult> {
  if (stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  await waitForCacheClear();
  const scope = thumbnailScope;
  const source = await fs.promises.stat(imagePath);
  const identity = thumbnailSourceIdentity(source);
  assertThumbnailSource(source, scope, options.expectedIdentity ?? identity);
  const basePath = getVersionedThumbnailPath(imagePath, size, identity);
  const thumbPath = options.force
    ? basePath.replace(
        WEBP_SUFFIX,
        `-r-${crypto.randomBytes(8).toString("hex")}.webp`
      )
    : basePath;
  const cached = options.force ? undefined : memoryCache?.get(thumbPath);
  if (cached) {
    diskAccessLog.set(path.basename(thumbPath), Date.now());
    return cached;
  }

  const existing = inFlightThumbnails.get(thumbPath);
  if (existing) {
    if (!options.force) {
      return existing;
    }
    await existing.catch(() => undefined);
  }
  const promise = readOrGenerateThumbnail(
    imagePath,
    size,
    thumbPath,
    identity,
    scope,
    options
  );
  inFlightThumbnails.set(thumbPath, promise);
  try {
    const result = await promise;
    return result;
  } finally {
    if (inFlightThumbnails.get(thumbPath) === promise) {
      inFlightThumbnails.delete(thumbPath);
    }
  }
}

function assertThumbnailSource(
  stat: fs.Stats,
  scope: number,
  identity: string
): void {
  if (scope !== thumbnailScope || stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  if (!(stat.isFile() && thumbnailSourceIdentity(stat) === identity)) {
    throw new Error("Source changed during thumbnail generation");
  }
}

async function readOrGenerateThumbnail(
  imagePath: string,
  size: ThumbSize,
  thumbPath: string,
  identity: string,
  scope: number,
  options: ThumbnailOptions
): Promise<ThumbnailResult> {
  const cached = options.force
    ? null
    : await readGalleryVariant(thumbPath, identity);
  if (!cached) {
    return doGenerate(imagePath, size, thumbPath, identity, scope, options);
  }
  const buffer = cached.buffer ?? (await fs.promises.readFile(thumbPath));
  assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
  const result = { ...cached, buffer };
  memoryCache?.set(thumbPath, result);
  return result;
}

async function doGenerate(
  imagePath: string,
  size: ThumbSize,
  thumbPath: string,
  identity: string,
  scope: number,
  options: ThumbnailOptions
): Promise<ThumbnailResult> {
  const targetSize = getThumbnailSize(size);
  await genSemaphore.acquire();
  let written = false;
  try {
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    // For RAW files, extract the embedded JPEG preview first
    let input: string | Buffer = options.input ?? imagePath;
    if (!options.input && isRawFile(imagePath)) {
      const preview = await extractRawPreview(imagePath);
      if (preview) {
        input = preview;
      }
    }

    input = await resolveHeifInput(input);
    if (typeof input === "string") {
      input = await fs.promises.readFile(input);
    }
    const inputMetadata = await sharp(input, { failOn: "none" }).metadata();
    const orientation =
      options.orientation ??
      (await resolveImageOrientation(imagePath, inputMetadata));
    const pipeline = applyExifOrientation(
      sharp(input, { failOn: "none" }),
      orientation
    )
      .resize(targetSize, targetSize, {
        fit: "inside",
        withoutEnlargement: true,
      })
      .webp({ quality: 85, effort: 1 });
    const { data: thumbBuffer, info } =
      options.prepared && Buffer.isBuffer(input)
        ? {
            data: input,
            info: { width: inputMetadata.width, height: inputMetadata.height },
          }
        : await pipeline.toBuffer({ resolveWithObject: true });

    if (!(info.width && info.height)) {
      throw new Error("Generated thumbnail is invalid (zero dimensions)");
    }
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    await writeFileAtomic(thumbPath, thumbBuffer);
    written = true;
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);

    // 每生成 50 个缩略图触发一次磁盘缓存清理检查
    generationCount++;
    if (generationCount >= CLEANUP_CHECK_INTERVAL) {
      generationCount = 0;
      setTimeout(() => {
        scheduleThumbnailMaintenance();
      }, 0);
    }

    const result = {
      buffer: thumbBuffer,
      thumbnailPath: thumbPath,
      width: info.width,
      height: info.height,
      sourceIdentity: identity,
    };
    memoryCache?.set(thumbPath, result);
    return result;
  } catch (error) {
    if (written) {
      await removeCachedThumbnail(thumbPath).catch(() => undefined);
    }
    throw error;
  } finally {
    genSemaphore.release();
  }
}

function gallerySourcePrefix(imagePath: string): string {
  return `g-${crypto.createHash("md5").update(imagePath).digest("hex")}-`;
}

function indexGalleryVariant(name: string): void {
  const prefix = GALLERY_SOURCE_PREFIX.exec(name)?.[0];
  if (!(prefix && MANAGED_THUMBNAIL_EXTENSION.test(name))) {
    return;
  }
  const names = galleryVariantNames.get(prefix) ?? new Set<string>();
  names.add(name);
  galleryVariantNames.set(prefix, names);
}

async function ensureGalleryVariantIndex(): Promise<void> {
  if (variantDirectoryReady) {
    return;
  }
  if (!variantDirectoryRead) {
    const scope = thumbnailScope;
    const pending = fs.promises
      .readdir(thumbnailDir)
      .then((names) => {
        if (scope !== thumbnailScope) {
          return;
        }
        for (const name of names) {
          indexGalleryVariant(name);
        }
        variantDirectoryReady = true;
      })
      .finally(() => {
        if (variantDirectoryRead === pending) {
          variantDirectoryRead = null;
        }
      });
    variantDirectoryRead = pending;
  }
  await variantDirectoryRead;
}

async function readGalleryVariant(
  target: string,
  identity: string,
  signal?: AbortSignal
): Promise<ThumbnailResult | null> {
  try {
    const stats = await fs.promises.stat(target);
    const { metadata, buffer } = await readValidatedThumbnail(target, stats);
    if (metadata.format !== "webp") {
      return null;
    }
    signal?.throwIfAborted();
    diskAccessLog.set(path.basename(target), Date.now());
    recordGalleryMediaStat("thumbnailHit");
    return {
      thumbnailPath: target,
      width: metadata.width ?? 0,
      height: metadata.height ?? 0,
      stat: stats,
      sourceIdentity: identity,
      buffer,
    };
  } catch {
    signal?.throwIfAborted();
    // A concurrent repair may already have replaced the unreadable file.
    return null;
  }
}

async function encodeGalleryVariant(
  imagePath: string,
  resource: string | Buffer,
  edge: GalleryThumbnailEdge,
  knownOrientation?: ExifOrientation
) {
  let preview =
    resource === imagePath && isRawFile(imagePath)
      ? ((await extractRawPreview(imagePath)) ?? imagePath)
      : resource;
  preview = await resolveHeifInput(preview);
  // The managed preview was already validated and has corrected orientation.
  // Read it once; repeated sharp(path).metadata()/encode opens contend with IO.
  let orientation = knownOrientation;
  if (typeof preview === "string") {
    preview = await fs.promises.readFile(preview);
  }
  if (!orientation) {
    const metadata = await sharp(preview, { failOn: "none" }).metadata();
    orientation = await resolveImageOrientation(imagePath, metadata);
  }
  return applyExifOrientation(sharp(preview, { failOn: "none" }), orientation)
    .resize(edge, edge, { fit: "inside", withoutEnlargement: true })
    .webp({ quality: 85, effort: 1 })
    .toBuffer({ resolveWithObject: true });
}

async function encodeFromGalleryPreview(
  imagePath: string,
  edge: GalleryThumbnailEdge,
  preview: ThumbnailResult | undefined,
  scope: number,
  identity: string
) {
  if (!preview) {
    return encodeGalleryVariant(imagePath, imagePath, edge);
  }
  try {
    return await encodeGalleryVariant(
      imagePath,
      preview.buffer ?? preview.thumbnailPath,
      edge,
      1
    );
  } catch {
    // Metadata can remain readable in an otherwise undecodable preview.
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    return encodeGalleryVariant(imagePath, imagePath, edge);
  }
}

function ownedLegacyPreviewPath(
  imagePath: string,
  source: fs.Stats,
  evidence?: LegacyThumbnailEvidence
): string | undefined {
  const repaired = repairedPreviewPath(
    imagePath,
    thumbnailSourceIdentity(source),
    evidence?.thumbnailPath
  );
  if (
    repaired &&
    evidence?.metadataRevision === evidence?.contentRevision &&
    evidence?.sourceSize === source.size &&
    evidence?.sourceMtimeMs === source.mtimeMs &&
    evidence?.sourceCtimeMs === source.ctimeMs
  ) {
    return repaired;
  }
  const legacy = getThumbnailPath(imagePath, "md");
  if (
    evidence?.thumbnailPath === legacy &&
    evidence.metadataRevision === evidence.contentRevision &&
    (evidence.sourceSize === null || evidence.sourceSize === source.size) &&
    (evidence.sourceMtimeMs === null ||
      evidence.sourceMtimeMs === source.mtimeMs) &&
    (evidence.sourceCtimeMs === null ||
      evidence.sourceCtimeMs === source.ctimeMs)
  ) {
    return legacy;
  }
  return undefined;
}

function repairedPreviewPath(
  imagePath: string,
  identity: string,
  candidate?: string | null
) {
  const base = getVersionedThumbnailPath(imagePath, "md", identity).slice(
    0,
    -5
  );
  return candidate &&
    isStoredThumbnailName(candidate) &&
    candidate.startsWith(`${base}-r-`) &&
    REPAIRED_PREVIEW_SUFFIX.test(candidate)
    ? candidate
    : undefined;
}

function galleryRepairSuffix(preview?: string): string {
  return preview && REPAIRED_PREVIEW_SUFFIX.test(preview)
    ? preview.slice(-24, -5)
    : "";
}

/** Retire older variants only after the new preview is committed to its photo. */
export async function finishPreviewRepair(
  imagePath: string,
  repairedPath: string
): Promise<void> {
  if (!(thumbnailDir && isStoredThumbnailName(repairedPath))) {
    return;
  }
  await ensureGalleryVariantIndex();
  const prefix = gallerySourcePrefix(imagePath);
  const identity = path
    .basename(repairedPath)
    .slice(prefix.length, prefix.length + 32);
  const repairSuffix = galleryRepairSuffix(repairedPath);
  for (const name of [...(galleryVariantNames.get(prefix) ?? [])]) {
    const cachedPath = path.join(thumbnailDir, name);
    if (
      name.startsWith(`${prefix}${identity}-`) &&
      !(
        repairSuffix && name.startsWith(`${prefix}${identity}${repairSuffix}-`)
      ) &&
      cachedPath !== repairedPath
    ) {
      await removeUnreferencedThumbnail(cachedPath);
    }
  }
}

/** Caller must prove full-content equality before transferring a preview. */
export async function preserveRelinkThumbnail(
  previousPath: string,
  nextPath: string,
  evidence: LegacyThumbnailEvidence
): Promise<string | undefined> {
  if (
    !thumbnailDir ||
    evidence.metadataRevision !== evidence.contentRevision ||
    evidence.sourceSize === null ||
    evidence.sourceMtimeMs === null ||
    evidence.sourceCtimeMs === null
  ) {
    return undefined;
  }
  const previousIdentity = thumbnailSourceIdentity({
    size: evidence.sourceSize,
    mtimeMs: evidence.sourceMtimeMs,
    ctimeMs: evidence.sourceCtimeMs,
  });
  const canonical = getVersionedThumbnailPath(
    previousPath,
    "md",
    previousIdentity
  );
  const expected =
    evidence.thumbnailPath === canonical
      ? canonical
      : repairedPreviewPath(
          previousPath,
          previousIdentity,
          evidence.thumbnailPath
        );
  if (!expected) {
    return undefined;
  }
  try {
    const scope = thumbnailScope;
    const source = await fs.promises.stat(nextPath);
    const identity = thumbnailSourceIdentity(source);
    const { buffer, metadata } = await readValidatedThumbnail(
      expected,
      await fs.promises.stat(expected)
    );
    if (metadata.format !== "webp" || (metadata.orientation ?? 1) !== 1) {
      return undefined;
    }
    const bytes = buffer ?? (await fs.promises.readFile(expected));
    await sharp(bytes).raw().toBuffer();
    const target = getVersionedThumbnailPath(nextPath, "md", identity);
    assertThumbnailSource(await fs.promises.stat(nextPath), scope, identity);
    await writeFileAtomic(target, bytes);
    assertThumbnailSource(await fs.promises.stat(nextPath), scope, identity);
    return target;
  } catch {
    // Missing, corrupt or obsolete caches must fall back to generation.
    return undefined;
  }
}

function previewMatchesSource(
  preview: fs.Stats,
  source: fs.Stats,
  legacy: boolean
): boolean {
  return (
    preview.isFile() &&
    (!legacy ||
      preview.mtimeMs >
        Math.max(source.mtimeMs, source.ctimeMs, source.birthtimeMs))
  );
}

async function galleryPreview(
  imagePath: string,
  source: fs.Stats,
  identity: string,
  evidence: LegacyThumbnailEvidence | undefined,
  requiredEdge: number
): Promise<ThumbnailResult | undefined> {
  try {
    const legacy = ownedLegacyPreviewPath(imagePath, source, evidence);
    const existing =
      legacy ?? getVersionedThumbnailPath(imagePath, "md", identity);
    const stats = await fs.promises.stat(existing);
    if (
      !previewMatchesSource(
        stats,
        source,
        existing === getThumbnailPath(imagePath, "md")
      )
    ) {
      return undefined;
    }
    const { metadata: meta, buffer } = await readValidatedThumbnail(
      existing,
      stats
    );
    if (
      meta.format === "webp" &&
      (meta.orientation ?? 1) === 1 &&
      Math.max(meta.width ?? 0, meta.height ?? 0) >= requiredEdge
    ) {
      return {
        thumbnailPath: existing,
        width: meta.width ?? 0,
        height: meta.height ?? 0,
        stat: stats,
        buffer,
      };
    }
  } catch {
    // Missing or stale previews are regenerated from the source.
  }
  return undefined;
}

/** Cheap availability hint; HTTP still validates dimensions, orientation and pixels. */
export async function getGalleryThumbnailHint(
  photo: { path: string; width: number | null; height: number | null },
  edge: GalleryThumbnailEdge,
  source: fs.Stats,
  readStat: (file: string) => Promise<fs.Stats | undefined>,
  legacyEvidence?: LegacyThumbnailEvidence
): Promise<GalleryThumbnailEdge | undefined> {
  const identity = thumbnailSourceIdentity(source);
  const legacy = ownedLegacyPreviewPath(photo.path, source, legacyEvidence);
  const target = path.join(
    thumbnailDir,
    `${gallerySourcePrefix(photo.path)}${identity}${galleryRepairSuffix(legacy)}-${edge}.webp`
  );
  const targetStat = await readStat(target);
  if (targetStat) {
    return edge;
  }
  const preview =
    legacy ?? getVersionedThumbnailPath(photo.path, "md", identity);
  const previewStat = await readStat(preview);
  if (
    !(
      previewStat &&
      previewMatchesSource(
        previewStat,
        source,
        preview === getThumbnailPath(photo.path, "md")
      )
    )
  ) {
    return undefined;
  }
  // The managed preview filename encodes this physical size. Do not read
  // every offscreen preview's sharp metadata ahead of the six image slots.
  // A damaged/mismatched file is repaired by the chosen exact-edge endpoint.
  const nominalEdge = THUMBNAIL_BASE_SIZES.md * dprScale;
  return GALLERY_THUMBNAIL_EDGES.find(
    (candidate) => candidate >= edge && candidate >= nominalEdge
  );
}

/** The source's filesystem identity is part of every new physical-pixel variant. */
export async function generateGalleryThumbnail(
  imagePath: string,
  edge: GalleryThumbnailEdge,
  signal?: AbortSignal,
  priority = 0,
  sourceSize?: { width: number | null; height: number | null },
  selectExisting = false,
  repair = false,
  legacyEvidence?: LegacyThumbnailEvidence
): Promise<ThumbnailResult> {
  if (stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  await waitForCacheClear();
  signal?.throwIfAborted();
  const scope = thumbnailScope;
  const source = await fs.promises.stat(imagePath);
  signal?.throwIfAborted();
  const identity = thumbnailSourceIdentity(source);
  assertThumbnailSource(source, scope, identity);
  const ownedPreview = ownedLegacyPreviewPath(
    imagePath,
    source,
    legacyEvidence
  );
  const target = path.join(
    thumbnailDir,
    `${gallerySourcePrefix(imagePath)}${identity}${galleryRepairSuffix(ownedPreview)}-${edge}.webp`
  );
  // A browser decode failure can leave readable container metadata. Repair
  // bypasses both cached representations and atomically replaces this tier.
  const cached = repair
    ? null
    : await readGalleryVariant(target, identity, signal);
  if (cached) {
    return cached;
  }
  // An orientation-safe preview can be returned directly only at the requested
  // physical size. Larger previews are cheap generation inputs, not small URLs.
  const sourceLongEdge = Math.max(
    sourceSize?.width ?? 0,
    sourceSize?.height ?? 0
  );
  const requiredEdge =
    sourceLongEdge > 0 ? Math.min(edge, sourceLongEdge) : edge;
  const preview = repair
    ? undefined
    : await galleryPreview(
        imagePath,
        source,
        identity,
        legacyEvidence,
        selectExisting ? Math.max(1, requiredEdge - 1) : requiredEdge
      );
  signal?.throwIfAborted();
  if (
    preview &&
    (selectExisting || Math.max(preview.width, preview.height) === requiredEdge)
  ) {
    assertThumbnailSource(await fs.promises.stat(imagePath), scope, identity);
    signal?.throwIfAborted();
    diskAccessLog.set(path.basename(preview.thumbnailPath), Date.now());
    recordGalleryMediaStat("thumbnailHit");
    return { ...preview, sourceIdentity: identity };
  }
  let job = galleryJobs.get(target);
  if (stopping) {
    throw new DOMException("Cancelled", "AbortError");
  }
  if (!job) {
    const controller = new AbortController();
    const promise = (async (): Promise<ThumbnailResult> => {
      const queued = performance.now();
      await genSemaphore.acquire(controller.signal, priority);
      recordGalleryMediaStat(
        "thumbnailGenerationQueueMs",
        performance.now() - queued
      );
      const started = performance.now();
      let written = false;
      try {
        assertThumbnailSource(
          await fs.promises.stat(imagePath),
          scope,
          identity
        );
        controller.signal.throwIfAborted();
        recordGalleryMediaStat("thumbnailRegenerate");
        const encodeStarted = performance.now();
        const { data, info } = await encodeFromGalleryPreview(
          imagePath,
          edge,
          preview,
          scope,
          identity
        );
        recordGalleryMediaStat(
          "thumbnailEncodeMs",
          performance.now() - encodeStarted
        );
        if (!(info.width && info.height)) {
          throw new Error("Invalid generated thumbnail");
        }
        const writeStarted = performance.now();
        assertThumbnailSource(
          await fs.promises.stat(imagePath),
          scope,
          identity
        );
        controller.signal.throwIfAborted();
        await writeFileAtomic(target, data);
        written = true;
        const stat = await fs.promises.stat(target);
        assertThumbnailSource(
          await fs.promises.stat(imagePath),
          scope,
          identity
        );
        recordGalleryMediaStat(
          "thumbnailWriteMs",
          performance.now() - writeStarted
        );
        scheduleThumbnailMaintenance();
        return {
          thumbnailPath: target,
          width: info.width,
          height: info.height,
          sourceIdentity: identity,
          stat,
          buffer: data,
        };
      } catch (error) {
        if (written) {
          await deleteUnreferencedThumbnail(target);
        }
        throw error;
      } finally {
        recordGalleryMediaStat(
          "thumbnailGenerationMs",
          performance.now() - started
        );
        genSemaphore.release();
      }
    })().finally(() => {
      if (galleryJobs.get(target)?.promise === promise) {
        galleryJobs.delete(target);
      }
    });
    job = { controller, consumers: 0, promise };
    galleryJobs.set(target, job);
  }
  const active = job;
  genSemaphore.promote(active.controller.signal, priority);
  active.consumers++;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = () => {
      if (settled) {
        return false;
      }
      settled = true;
      signal?.removeEventListener("abort", abort);
      active.consumers--;
      if (active.consumers === 0) {
        active.controller.abort();
      }
      return true;
    };
    const abort = () => {
      if (release()) {
        reject(new DOMException("Cancelled", "AbortError"));
      }
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) {
      abort();
    }
    active.promise.then(
      (result) => {
        if (release()) {
          resolve(result);
        }
      },
      (error) => {
        if (release()) {
          reject(error);
        }
      }
    );
  });
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
  clearThumbnailValidation();
}

export function getThumbnailDir(): string {
  return thumbnailDir || "";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: bounded filesystem batches handle missing files, service-scope changes and reconciliation without publishing stale usage.
export async function getThumbnailDiskUsage(): Promise<{
  dir: string;
  bytes: number;
  fileCount: number;
}> {
  const scope = thumbnailScope;
  const dir = thumbnailDir || "";
  if (
    diskUsageCheckedAt > 0 &&
    Date.now() - diskUsageCheckedAt < GALLERY_CONFIG.diskCheckIntervalMs
  ) {
    return { dir, bytes: knownDiskBytes, fileCount: knownDiskFiles.size };
  }
  let bytes = 0;
  let fileCount = 0;
  const knownBeforeScan = new Set(knownDiskFiles.keys());
  const seen = new Set<string>();
  if (dir) {
    try {
      await fs.promises.access(dir);
      const entries = await fs.promises.readdir(dir);
      // 并发 stat，每批 64 个避免 FD 耗尽，60K 文件从串行 3-8s 降至 ~200ms
      const BATCH = 64;
      for (let i = 0; i < entries.length; i += BATCH) {
        if (scope !== thumbnailScope) {
          break;
        }
        const batch = entries.slice(i, i + BATCH);
        const stats = await Promise.all(
          batch.map(async (entry) => {
            try {
              const entryPath = path.join(dir, entry);
              const st = await fs.promises.stat(entryPath);
              if (
                scope === thumbnailScope &&
                st.isFile() &&
                (MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
                  HEIF_MODEL_CACHE_PATTERN.test(entry))
              ) {
                seen.add(entry);
                knownDiskBytes += st.size - (knownDiskFiles.get(entry) ?? 0);
                knownDiskFiles.set(entry, st.size);
                indexGalleryVariant(entry);
              }
              return st.isFile() &&
                (MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
                  HEIF_MODEL_CACHE_PATTERN.test(entry))
                ? st.size
                : 0;
            } catch {
              return 0;
            }
          })
        );
        for (const size of stats) {
          if (size > 0) {
            bytes += size;
            fileCount++;
          }
        }
      }
    } catch {
      /* directory unreadable */
    }
  }
  if (scope !== thumbnailScope) {
    return { dir, bytes, fileCount };
  }
  for (const name of knownBeforeScan) {
    if (!seen.has(name)) {
      knownDiskBytes -= knownDiskFiles.get(name) ?? 0;
      knownDiskFiles.delete(name);
    }
  }
  diskUsageCheckedAt = Date.now();
  return {
    dir,
    bytes: Math.max(bytes, knownDiskBytes),
    fileCount: Math.max(fileCount, knownDiskFiles.size),
  };
}

/**
 * Delete all thumbnail variants for a single photo from disk and memory cache.
 * Safe to call even if the photo has no thumbnails — errors are silently caught.
 */
function thumbnailIsReferenced(
  filePath: string,
  includeDuel: boolean
): boolean {
  try {
    const db = getDatabase();
    const thumbnail = eq(photos.thumbnailPath, filePath);
    return !!db
      .select({ id: photos.id })
      .from(photos)
      .where(
        includeDuel
          ? or(thumbnail, eq(photos.duelPreviewPath, filePath))
          : thumbnail
      )
      .get();
  } catch {
    return true;
  }
}

/** Best-effort cleanup of a managed file after removing its database reference. */
export async function deleteUnreferencedThumbnail(
  filePath: string | null | undefined
): Promise<void> {
  if (filePath && isStoredThumbnailName(filePath)) {
    await removeUnreferencedThumbnail(filePath, true);
  }
}

async function removeUnreferencedThumbnail(
  filePath: string,
  includeDuel = false
): Promise<void> {
  const safe = resolveSafePath(filePath, [thumbnailDir]);
  if (
    safe &&
    !thumbnailIsReferenced(filePath, includeDuel) &&
    (safe === filePath || !thumbnailIsReferenced(safe, includeDuel))
  ) {
    await removeCachedThumbnail(filePath).catch(() => undefined);
  }
}

export async function deletePhotoThumbnails(imagePath: string): Promise<void> {
  if (!thumbnailDir) {
    return;
  }

  if ((await isHeifInput(imagePath)) || HEIF_FILE_EXTENSION.test(imagePath)) {
    const heifPrefix = heifSourcePrefix(imagePath);
    for (const name of await fs.promises
      .readdir(thumbnailDir)
      .catch(() => [])) {
      if (name.startsWith(heifPrefix) && HEIF_MODEL_CACHE_PATTERN.test(name)) {
        await removeCachedThumbnail(path.join(thumbnailDir, name)).catch(
          () => undefined
        );
      }
    }
  }
  const prefix = gallerySourcePrefix(imagePath);
  await ensureGalleryVariantIndex().catch(() => undefined);
  const variants = [...(galleryVariantNames.get(prefix) ?? [])];
  const candidates = [
    ...variants.map((name) => path.join(thumbnailDir, name)),
    ...(["sm", "md", "lg"] as const).map((size) =>
      getThumbnailPath(imagePath, size)
    ),
  ];
  await Promise.all(
    candidates
      .filter(
        (filePath) =>
          !(inFlightThumbnails.has(filePath) || galleryJobs.has(filePath))
      )
      .map((filePath) => removeUnreferencedThumbnail(filePath))
  );

  // 同时清理对比预览
  await deleteDuelPreview(imagePath);
}

export async function clearThumbnailDiskCache(): Promise<{
  fileCount: number;
  freedMB: number;
}> {
  while (cacheClearPromise) {
    await cacheClearPromise;
  }

  const clearPromise = (async () => {
    if (thumbnailDir) {
      await invalidateHeifModelCache(thumbnailDir);
    }
    await waitForActiveGenerations();

    let fileCount = 0;
    let totalBytes = 0;

    if (thumbnailDir) {
      try {
        await fs.promises.access(thumbnailDir);
        const entries = await fs.promises.readdir(thumbnailDir);
        for (const entry of entries) {
          if (
            !(
              MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
              HEIF_MODEL_CACHE_PATTERN.test(entry)
            )
          ) {
            continue;
          }
          const entryPath = path.join(thumbnailDir, entry);
          try {
            const stat = await fs.promises.stat(entryPath);
            totalBytes += stat.size;
            await removeCachedThumbnail(entryPath);
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
    clearThumbnailValidation();

    return {
      fileCount,
      freedMB: Math.round((totalBytes / (1024 * 1024)) * 10) / 10,
    };
  })();

  const barrier = clearPromise.then(() => undefined);
  cacheClearPromise = barrier;
  try {
    return await clearPromise;
  } finally {
    if (cacheClearPromise === barrier) {
      cacheClearPromise = null;
    }
  }
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
        expected.add(gallerySourcePrefix(r.path));
        expected.add(heifSourcePrefix(r.path));
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

function isExpectedThumbnail(expected: Set<string>, name: string): boolean {
  if (expected.has(name)) {
    return true;
  }
  const prefix =
    GALLERY_SOURCE_PREFIX.exec(name)?.[0] ?? HEIF_SOURCE_PREFIX.exec(name)?.[0];
  return prefix !== undefined && expected.has(prefix);
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
    const isManaged =
      MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
      HEIF_MODEL_CACHE_PATTERN.test(entry);
    if (!isManaged) {
      continue;
    }
    totalFiles++;
    if (!isExpectedThumbnail(expectedFiles, entry)) {
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
    const isManaged =
      MANAGED_THUMBNAIL_EXTENSION.test(entry) ||
      HEIF_MODEL_CACHE_PATTERN.test(entry);
    if (!isManaged) {
      continue;
    }
    if (!isExpectedThumbnail(expectedFiles, entry)) {
      const entryPath = path.join(thumbnailDir, entry);
      let fileSize = 0;
      try {
        fileSize = (await fs.promises.stat(entryPath)).size;
      } catch {
        continue;
      }

      try {
        await removeCachedThumbnail(entryPath);
        freedBytes += fileSize;
        removed++;
      } catch (err: unknown) {
        const code =
          typeof err === "object" && err !== null && "code" in err
            ? String(err.code)
            : "unknown";
        log.error(
          `[Thumbnailer] Failed to delete orphan: ${entry} (code: ${code})`
        );
      }
    }
  }

  return {
    removed,
    freedMB: Math.round((freedBytes / (1024 * 1024)) * 10) / 10,
  };
}

// ── HTTP Server 回退生成辅助函数 ─────────────────────────────────────────
// 当 HTTP Server 发现缩略图 / 对比预览文件缺失或损坏时，
// 通过这些函数反查原始照片路径并触发重新生成。

/**
 * 根据缩略图文件路径反查原始照片路径和缩略图尺寸。
 * 先通过数据库 thumbnailPath 列直接匹配（快速路径），
 * 再遍历所有照片计算预期路径（覆盖 sm/lg 尺寸的按需生成场景）。
 */
export function findPhotoPathByThumbnail(
  thumbPath: string
): { photoPath: string; size: ThumbSize } | null {
  try {
    const db = getDatabase();
    const thumbFilename = path.basename(thumbPath);

    const direct = db
      .select({ path: photos.path })
      .from(photos)
      .where(eq(photos.thumbnailPath, thumbPath))
      .get();
    if (direct) {
      return { photoPath: direct.path, size: "md" };
    }
    // Compatibility for old sm/lg URLs only. New requests address photos by ID.
    const allPhotos = db
      .select({
        path: photos.path,
        thumbnailPath: photos.thumbnailPath,
      })
      .from(photos)
      .all();

    for (const photo of allPhotos) {
      if (photo.thumbnailPath === thumbPath) {
        return { photoPath: photo.path, size: "md" };
      }
    }

    // 慢速路径：遍历所有照片，计算预期路径（覆盖 sm/lg 尺寸）
    for (const photo of allPhotos) {
      for (const size of ["sm", "md", "lg"] as ThumbSize[]) {
        if (
          path.basename(getThumbnailPath(photo.path, size)) === thumbFilename
        ) {
          return { photoPath: photo.path, size };
        }
      }
    }
  } catch {
    // 数据库未就绪
  }
  return null;
}

/**
 * 根据对比预览文件路径反查原始照片路径。
 * 先通过数据库 duelPreviewPath 列匹配，再遍历计算预期路径。
 */
export function findPhotoPathByDuelPreview(previewPath: string): string | null {
  try {
    const db = getDatabase();
    const previewFilename = path.basename(previewPath);

    const allPhotos = db
      .select({
        path: photos.path,
        duelPreviewPath: photos.duelPreviewPath,
      })
      .from(photos)
      .all();

    for (const photo of allPhotos) {
      if (photo.duelPreviewPath === previewPath) {
        return photo.path;
      }
    }

    // 慢速路径
    for (const photo of allPhotos) {
      if (path.basename(getDuelPreviewPath(photo.path)) === previewFilename) {
        return photo.path;
      }
    }
  } catch {
    /* DB not ready */
  }
  return null;
}
