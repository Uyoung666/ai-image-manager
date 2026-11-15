const HEIF_EXTENSION_RE = /\.hei[cf]$/i;

import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import exifr from "exifr";
import PQueue from "p-queue";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { exifData, folders, photos } from "@/db/schema";
import { invalidateFoldersCache } from "@/utils/folder-paths";
import { importPathKey } from "@/utils/import-path";
import { containsLibraryPath } from "@/utils/library-roots";
import { createLogger } from "@/utils/logger";
import { deletePhotoVectors } from "./ai-embedder";
import {
  createBackgroundWatcher,
  type FileWatcherHandle,
} from "./background-file-watcher";
import { extractDominantColors } from "./color-extractor";
import { checkNewPhotoDuplicates } from "./dedup-service";
import { registerExplicitPhotoFolder } from "./explicit-library-folders";
import { getFolderMatcher, reloadFolderMatcher } from "./folder-matcher";
import {
  getHeifImportMetrics,
  prepareHeifImport,
  resolveHeifInput,
} from "./heif-input";
import {
  type ExifOrientation,
  getOrientedDimensions,
  resolveImageOrientation,
} from "./image-orientation";
import { waitForLibraryForegroundIdle } from "./library-foreground";
import {
  forgetLibraryMoveTarget,
  pruneLibraryMoveTargets,
} from "./library-move-candidates";
import {
  acceptLibraryPathSpelling,
  commitLibraryMove,
  type LibraryMovePlan,
  libraryPhotoPathEquals,
  libraryPhotoPathsIn,
  planLibraryMoves,
  planWatchedLibraryMoves,
  requestLibraryHashBackfill,
} from "./library-moves";
import {
  inspectLibraryRoot,
  type LibraryFileObservation,
  libraryPathCondition,
  librarySourceIsPaused,
  reconcileLibrarySources,
  writeLibraryFolderSource,
} from "./library-source";
import { computePHash } from "./perceptual-hash";
import { extractRawPreview, isRawFile, readRawDimensions } from "./raw-preview";
import { thumbnailSourceIdentity } from "./thumbnail-identity";
import {
  deletePhotoThumbnails,
  generateThumbnail,
  getThumbnailSize,
} from "./thumbnailer";

const log = createLogger("indexer");
const FOCAL_RANGE_RE = /^\d+(?:\.\d+)?\s*-\s*\d+(?:\.\d+)?$/;
const FOCAL_SPLIT_RE = /\s*-\s*/;
const SHUTTER_FRACTION_RE = /^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/;

const SUPPORTED_EXTENSIONS = new Set([
  // Common image formats
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".avif",
  ".tiff",
  ".tif",
  ".heic",
  ".heif",
  ".gif",
  ".bmp",
  ".ico",
  // RAW camera formats
  ".cr2", // Canon
  ".cr3", // Canon
  ".nef", // Nikon
  ".nrw", // Nikon
  ".arw", // Sony
  ".srf", // Sony
  ".sr2", // Sony
  ".dng", // Adobe Digital Negative
  ".orf", // Olympus / OM System
  ".rw2", // Panasonic
  ".raf", // Fujifilm
  ".pef", // Pentax
  ".rwl", // Leica
  ".3fr", // Hasselblad
  ".raw", // Generic RAW
]);

const SKIP_PATTERNS = [/node_modules/, /\.git/, /\.thumbnails/, /\.cache/];

const WATCHER_CONCURRENCY = 2;
const watcherQueue = new PQueue({ concurrency: WATCHER_CONCURRENCY });

let watcherStats = {
  addEvents: 0,
  unlinkEvents: 0,
  processed: 0,
  skipped: 0,
  errors: 0,
};

export function getWatcherStats() {
  return {
    ...watcherStats,
    queueSize: watcherQueue.size,
    queuePending: watcherQueue.pending,
  };
}

export interface IndexProgress {
  currentFile: string;
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

type ProgressCallback = (progress: IndexProgress) => void;
let activeScanToken: { cancelled: boolean } | null = null;

interface WatcherContext {
  db: ReturnType<typeof getDatabase>;
  folderId: number | null;
  folderPath: string;
  key: string;
  onChange?: WatchChange;
  watcher: FileWatcherHandle;
}

const watchers = new Map<string, WatcherContext>();
const pendingWatcherAdds = new Map<
  string,
  { context: WatcherContext; filePath: string }
>();
let watcherAddTimer: ReturnType<typeof setTimeout> | undefined;

type WatcherStateContext = Pick<
  WatcherContext,
  "db" | "folderId" | "folderPath"
>;

type WatchChange = (
  photoId: number | null,
  event: "add" | "remove" | "update" | "status"
) => void;
let onWatcherReady: ((folderPath: string) => void) | undefined;
const retries = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; attempt: number }
>();
const retryCounts = new Map<string, number>();

export function setWatcherReconciliationCallback(
  callback?: (folderPath: string) => void
): void {
  onWatcherReady = callback;
}

function retryWatch(folderPath: string, onChange: WatchChange): void {
  const key = watcherPathKey(folderPath);
  if (retries.has(key)) {
    return;
  }
  const attempt = retryCounts.get(key) ?? 0;
  const delay = [5000, 30_000, 120_000][attempt];
  if (delay === undefined) {
    return;
  }
  retryCounts.set(key, attempt + 1);
  const timer = setTimeout(
    () => {
      retries.delete(key);
      installWatcher(folderPath, onChange);
    },
    delay * (0.8 + Math.random() * 0.4)
  );
  timer.unref?.();
  retries.set(key, { timer, attempt });
}

type WatcherFailurePhase = "close" | "create" | "error" | "state";

function getWatcherErrorField(
  error: unknown,
  field: "code" | "syscall"
): string | undefined {
  if (typeof error !== "object" || error === null || !(field in error)) {
    return undefined;
  }
  const value = (error as Record<string, unknown>)[field];
  return value === undefined || value === null ? undefined : String(value);
}

function logWatcherFailure(
  context: Pick<WatcherContext, "folderId" | "folderPath">,
  error: unknown,
  phase: WatcherFailurePhase,
  message: string
): void {
  log.error(
    {
      folderId: context.folderId,
      folderPath: context.folderPath,
      code: getWatcherErrorField(error, "code"),
      syscall: getWatcherErrorField(error, "syscall"),
      phase,
      err: error,
    },
    message
  );
}

function isCurrentWatcher(context: WatcherContext): boolean {
  return watchers.get(context.key) === context && context.db === getDatabase();
}

function removeCurrentWatcher(context: WatcherContext): void {
  if (isCurrentWatcher(context)) {
    watchers.delete(context.key);
  }
}

function updateWatcherState(
  context: WatcherStateContext,
  isWatching: boolean
): boolean {
  try {
    const update = context.db.update(folders).set({
      isWatching,
      watcherStartedAt: isWatching ? Date.now() : null,
    });
    let condition = eq(folders.path, context.folderPath);
    if (context.folderId !== null) {
      condition = eq(folders.id, context.folderId);
    } else if (process.platform === "win32") {
      condition = sql`lower(${folders.path}) = lower(${context.folderPath})`;
    }
    update.where(condition).run();
    return true;
  } catch (error) {
    logWatcherFailure(
      context,
      error,
      "state",
      `Watcher: Failed to update state (${isWatching ? "started" : "stopped"})`
    );
    watcherStats.errors++;
    return false;
  }
}

async function closeWatcherSafely(
  context: Pick<WatcherContext, "folderId" | "folderPath" | "watcher">,
  phase: WatcherFailurePhase = "close"
): Promise<void> {
  let closeResult: Promise<void> | undefined;
  try {
    closeResult = context.watcher.close();
  } catch (error) {
    watcherStats.errors++;
    logWatcherFailure(context, error, phase, "Watcher: Failed to close");
    context.watcher.on("error", () => undefined);
    return;
  }

  // chokidar removes every listener synchronously inside close(). Keep a
  // retired watcher's late native errors from becoming an unhandled error
  // event while its close promise settles (or after a rejected close).
  context.watcher.on("error", () => undefined);
  try {
    await closeResult;
  } catch (error) {
    watcherStats.errors++;
    logWatcherFailure(context, error, phase, "Watcher: Failed to close");
  }
}

function handleWatcherError(context: WatcherContext, error: unknown): void {
  if (!isCurrentWatcher(context)) {
    return;
  }
  removeCurrentWatcher(context);
  watcherStats.errors++;

  logWatcherFailure(context, error, "error", "Watcher: File system error");
  updateWatcherState(context, false);
  closeWatcherSafely(context).catch(() => undefined);
  if (context.onChange) {
    retryWatch(context.folderPath, context.onChange);
  }
}

function failWatcherSetup(
  context: WatcherContext,
  error: unknown,
  phase: WatcherFailurePhase
): void {
  removeCurrentWatcher(context);
  logWatcherFailure(context, error, phase, "Watcher: Failed to start");
  updateWatcherState(context, false);
  closeWatcherSafely(context, phase === "create" ? "close" : phase).catch(
    () => undefined
  );
}

function findFolderId(
  db: ReturnType<typeof getDatabase>,
  folderPath: string
): number | null {
  try {
    const folder = db
      .select({ id: folders.id })
      .from(folders)
      .where(
        process.platform === "win32"
          ? sql`lower(${folders.path}) = lower(${folderPath})`
          : eq(folders.path, folderPath)
      )
      .get();
    return folder?.id ?? null;
  } catch {
    return null;
  }
}

function createWatcher(
  db: ReturnType<typeof getDatabase>,
  folderPath: string,
  folderId: number | null
): WatcherContext | null {
  const key = watcherPathKey(folderPath);
  updateWatcherState({ db, folderId, folderPath }, false);
  let watcher: FileWatcherHandle;
  try {
    watcher = createBackgroundWatcher(folderPath, {
      ignored: SKIP_PATTERNS,
      ignorePermissionErrors: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      followSymlinks: false,
    });
  } catch (error) {
    watcherStats.errors++;
    updateWatcherState({ db, folderId, folderPath }, false);
    logWatcherFailure(
      { folderId, folderPath },
      error,
      "create",
      "Watcher: Failed to create"
    );
    return null;
  }

  const context: WatcherContext = {
    db,
    folderId,
    folderPath,
    key,
    watcher,
  };
  watchers.set(key, context);
  try {
    // Bind this before any event-specific handlers so native async errors
    // cannot escape during watcher startup.
    watcher.on("error", (error) => handleWatcherError(context, error));
  } catch (error) {
    failWatcherSetup(context, error, "create");
    return null;
  }
  return context;
}

function watcherPathKey(folderPath: string): string {
  const normalized = path.normalize(folderPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function isIndexing(): boolean {
  return activeScanToken !== null;
}

export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTENSIONS);
}

function getFolderDepth(folderPath: string): number {
  return folderPath.split(path.sep).filter(Boolean).length;
}

function shouldIndex(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    return false;
  }

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) {
      return false;
    }
  }

  return true;
}

// --- pHash (Perceptual Hash) — DCT-based ---
// Resize → 32×32 grayscale → 2D DCT → top-left 8×8 low-freq → median threshold → 64-bit hex.
// More robust than aHash against scaling, compression, and brightness changes.

async function readBasicMeta(filePath: string): Promise<{
  width: number;
  height: number;
  format: string;
  colorSpace: string;
  hasAlpha: boolean;
  orientation: ExifOrientation;
  thumbnailInput?: Buffer;
  thumbnailPrepared?: boolean;
} | null> {
  try {
    const heif = await prepareHeifImport(filePath, getThumbnailSize("md"));
    if (heif) {
      return {
        width: heif.width,
        height: heif.height,
        format: path.extname(filePath).slice(1).toLowerCase(),
        colorSpace: "srgb",
        hasAlpha: true,
        orientation: 1,
        thumbnailInput: Buffer.from(heif.buffer),
        thumbnailPrepared: true,
      };
    }
    const raw = isRawFile(filePath);
    // For RAW files, use the embedded JPEG only for decoder metadata and
    // thumbnail generation. Capture dimensions come from ExifTool below.
    let input: string | Buffer = filePath;
    let thumbnailInput: Buffer | undefined;
    if (raw) {
      const preview = await extractRawPreview(filePath);
      if (preview) {
        input = preview;
        thumbnailInput = preview;
      }
    }
    input = await resolveHeifInput(input);
    if (typeof input === "string") {
      input = await fs.promises.readFile(input);
    }
    if (Buffer.isBuffer(input)) {
      thumbnailInput = input;
    }
    const meta = await sharp(input).metadata();
    const orientation = await resolveImageOrientation(filePath, meta);
    const dimensions = raw
      ? await readRawDimensions(filePath)
      : getOrientedDimensions(meta.width, meta.height, orientation);
    if (!dimensions) {
      return null;
    }
    const { width, height } = raw
      ? getOrientedDimensions(dimensions.width, dimensions.height, orientation)
      : dimensions;
    // RAW files: use file extension as format (sharp returns "jpeg" from embedded preview)
    const format =
      raw || HEIF_EXTENSION_RE.test(filePath)
        ? path.extname(filePath).toLowerCase().replace(".", "")
        : meta.format || "";
    return {
      width,
      height,
      format,
      colorSpace: meta.space || "",
      hasAlpha: meta.hasAlpha,
      orientation,
      thumbnailInput,
    };
  } catch {
    return null;
  }
}

async function readExif(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    const result = await exifr.parse(filePath, {
      // 40KB first chunk — matches orientation()'s tuning for HEIC files
      // where the meta box (containing EXIF via iloc/iinf) may sit beyond
      // the default 512-byte first chunk (firstChunkSizeNode).
      firstChunkSize: 40_000,
    });
    if (!result || Object.keys(result).length === 0) {
      log.warn(
        { filePath, ext: path.extname(filePath).toLowerCase() },
        "EXIF extraction returned empty result"
      );
      return null;
    }
    return result;
  } catch (err) {
    log.warn(
      { filePath, ext: path.extname(filePath).toLowerCase(), err },
      "EXIF extraction threw an error"
    );
    return null;
  }
}

interface PhotoRecord {
  colorBucket: number | null;
  colorSpace: string;
  dominantColors: string | null;
  duelPreviewPath: string | null;
  fileDate: number;
  filename: string;
  fileSize: number;
  folderId: number | null;
  format: string;
  hasAlpha: boolean;
  height: number;
  isIndexed: boolean;
  path: string;
  phash: string | null;
  sourceAvailableAt: number;
  sourceCheckedAt: number;
  sourceCtimeMs: number;
  sourceMtimeMs: number;
  sourceSize: number;
  sourceStatus: "available";
  thumbnailPath: string | null;
  thumbnailSize: string;
  width: number;
}

// Parse shutter speed text (e.g. "0.001", "1/1000") to numeric seconds
function parseShutterSpeedToNum(value: string | undefined): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  // Fraction format: "1/1000", "1/60" etc.
  const fracMatch = value.match(SHUTTER_FRACTION_RE);
  if (fracMatch) {
    const num = Number.parseFloat(fracMatch[1]);
    const den = Number.parseFloat(fracMatch[2]);
    if (den !== 0) {
      return num / den;
    }
    return null;
  }
  // Decimal string: "0.001", "0.5" etc.
  const num = Number.parseFloat(value);
  return Number.isFinite(num) && num >= 0 ? num : null;
}

// Parse focal length text (e.g. "85", "24-70") to numeric value (first number)
function parseFocalLengthToNum(value: string | undefined): number | null {
  if (value === undefined || value === "") {
    return null;
  }
  const num = Number.parseFloat(value);
  return Number.isFinite(num) && num > 0 ? num : null;
}

// Clean focal length display text: rational→float precision artifacts produce
// strings like "85.00000000001" which break GROUP BY and look ugly in charts.
// Single-number → rounded to 0 decimals; zoom range "24-70" → kept as-is.
function cleanFocalLengthText(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  // Zoom range like "24-70" or "18-55"
  if (FOCAL_RANGE_RE.test(trimmed)) {
    // Clean each part: "24.000001-70.00001" → "24-70"
    const parts = trimmed.split(FOCAL_SPLIT_RE);
    const cleaned = parts.map((p) => {
      const n = Number.parseFloat(p);
      return Number.isFinite(n) ? Math.round(n).toString() : p;
    });
    return cleaned.join("-");
  }
  // Single number → round to nearest integer
  const n = Number.parseFloat(trimmed);
  if (Number.isFinite(n) && n > 0) {
    return Math.round(n).toString();
  }
  return trimmed;
}

interface ExifRecord {
  aperture?: number;
  artist?: string;
  cameraMake?: string;
  cameraModel?: string;
  copyright?: string;
  dateDigitized?: number | null;
  dateTaken?: number | null;
  exposureCompensation?: number;
  flash?: boolean;
  focalLength?: string;
  focalLength35mm?: string;
  focalLengthNum?: number | null;
  gpsAltitude?: number;
  gpsLatitude?: number;
  gpsLongitude?: number;
  imageDescription?: string;
  iso?: number;
  lensMake?: string;
  lensModel?: string;
  orientation?: number;
  photoId: number;
  rawJson: string;
  shutterSpeed?: string;
  shutterSpeedNum?: number | null;
  software?: string;
}

// ── Hue bucket helper ────────────────────────────────────────────────────
// Maps the primary hue (0–359) from dominant_colors JSON to a 36-bucket
// integer (0–35) for color-search pre-filtering. Returns null if no color data.
function computeHueBucket(dominantColorsJson: string | null): number | null {
  if (!dominantColorsJson) {
    return null;
  }
  try {
    const palette = JSON.parse(dominantColorsJson) as Array<{
      hue?: number;
      weight: number;
    }>;
    if (palette.length === 0 || palette[0].hue == null) {
      return null;
    }
    return Math.floor(palette[0].hue / 10) % 36;
  } catch {
    return null;
  }
}

function queuePrimaryColorVectorUpsert(
  photoId: number,
  dominantColors: string | null
): void {
  if (!dominantColors) {
    return;
  }

  try {
    const palette = JSON.parse(dominantColors) as Array<{
      b: number;
      g: number;
      r: number;
      weight: number;
    }>;
    const primary = palette[0];
    if (!primary) {
      return;
    }

    import("./ai/vector-db")
      .then(({ upsertColorVector }) =>
        upsertColorVector(photoId, primary.r, primary.g, primary.b)
      )
      .catch(() => {
        /* best-effort */
      });
  } catch {
    // Invalid palette JSON should not block indexing.
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Photo preparation combines metadata, thumbnail, RAW preview, EXIF, and color extraction for one indexed file.
export async function preparePhotoRecord(
  filePath: string,
  folderId: number | null,
  options: { repairPreview?: boolean } = {}
): Promise<{
  photoRecord: PhotoRecord;
  exifRecord: ExifRecord | null;
  stat: fs.Stats;
  phash: string | null;
} | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch {
    log.warn({ filePath }, "File disappeared before indexing");
    return null;
  }

  const meta = await readBasicMeta(filePath);
  if (!meta) {
    log.warn({ filePath }, "Skipped unreadable file (sharp metadata failed)");
    return null;
  }

  // Generate thumbnail (md=320px for crisp display in grid)
  let thumb: Awaited<ReturnType<typeof generateThumbnail>>;
  try {
    thumb = await generateThumbnail(filePath, "md", {
      force: options.repairPreview,
      expectedIdentity: thumbnailSourceIdentity(stat),
      input: meta.thumbnailInput,
      prepared: meta.thumbnailPrepared,
      orientation: meta.orientation,
    });
  } catch {
    log.warn({ filePath }, "Thumbnail generation failed");
    if (options.repairPreview) {
      return null;
    }
    thumb = { thumbnailPath: "", width: 0, height: 0 };
  }

  // Duel previews are generated lazily by cull.ensureDuelPreview.
  const duelPreviewPath: string | null = null;

  // Reuse the in-memory thumbnail for pHash instead of decoding the original
  // image a second time. pHash normalizes to 32x32, so the 512px thumbnail has
  // ample detail while substantially reducing import I/O and CPU cost.
  let phash: string | null = null;
  const phashInput = thumb.buffer ?? thumb.thumbnailPath ?? filePath;
  try {
    phash = await computePHash(phashInput);
  } catch (err) {
    // pHash computation failed — photo can still be indexed and browsed;
    // it simply won't participate in pHash-based dedup.
    log.warn(
      { filePath, err },
      "pHash computation failed, photo will be indexed without dedup hash"
    );
    phash = null;
  }

  // 提取主色调（使用缩略图，3-8ms/张）
  let dominantColors: string | null = null;
  if (thumb.thumbnailPath) {
    try {
      dominantColors = await extractDominantColors(
        thumb.buffer ?? thumb.thumbnailPath
      );
    } catch (err) {
      // 颜色提取失败不阻塞索引
      console.warn(`[Indexer] Color extraction failed for ${filePath}:`, err);
    }
  }
  const colorBucket = computeHueBucket(dominantColors);

  const photoRecord: PhotoRecord = {
    path: filePath,
    folderId,
    filename: path.basename(filePath),
    fileSize: stat.size,
    sourceSize: stat.size,
    sourceMtimeMs: stat.mtimeMs,
    sourceCtimeMs: stat.ctimeMs,
    sourceStatus: "available",
    sourceCheckedAt: Date.now(),
    sourceAvailableAt: Date.now(),
    fileDate: Math.floor(Math.min(stat.birthtimeMs, stat.mtimeMs)),
    width: meta.width,
    height: meta.height,
    format: meta.format,
    colorSpace: meta.colorSpace,
    colorBucket,
    hasAlpha: meta.hasAlpha,
    thumbnailPath: thumb.thumbnailPath,
    thumbnailSize: `${thumb.width}x${thumb.height}`,
    duelPreviewPath,
    isIndexed: true,
    phash,
    dominantColors,
  };

  // Extract EXIF
  const exif = await readExif(filePath);
  let exifRecord: ExifRecord | null = null;

  if (exif && Object.keys(exif).length > 0) {
    const focalLengthStr = exif.FocalLength?.toString();
    const focalLengthNum = parseFocalLengthToNum(focalLengthStr);
    const shutterSpeedStr = exif.ExposureTime?.toString();

    // Derive camera model with fallback: phone photos (iPhone/OPPO/etc.)
    // often have an empty Model tag but a descriptive LensModel like
    // "iPhone 17 Pro Max back triple camera 6.765mm f/1.78".
    // Extract the phone name from LensModel as a fallback.
    let cameraModel = (exif.Model as string) || "";
    const rawLensModel = (exif.LensModel as string) || "";
    if (!cameraModel && rawLensModel) {
      // Lens model format for phones: "<PhoneName> back <rest>"
      const backIdx = rawLensModel.indexOf(" back ");
      if (backIdx > 0) {
        cameraModel = rawLensModel.slice(0, backIdx).trim();
      }
    }
    // Last resort: use Make (brand name) if Model is still empty
    if (!cameraModel) {
      cameraModel = (exif.Make as string) || "";
    }

    // Derive camera make with the same fallback philosophy:
    // 1. Use EXIF Make tag directly when present
    // 2. When missing but we have a resolved camera model, extract the
    //    first word or map known phone model prefixes to manufacturers.
    let cameraMake = (exif.Make as string) || "";
    if (!cameraMake && cameraModel) {
      const modelLower = cameraModel.toLowerCase();
      if (modelLower.startsWith("iphone") || modelLower.startsWith("ipad")) {
        cameraMake = "Apple";
      } else {
        // Use first word of camera model as a best-effort make
        cameraMake = cameraModel.split(" ")[0] || "";
      }
    }

    exifRecord = {
      photoId: 0, // Will be set after insert
      cameraMake,
      cameraModel,
      lensMake: exif.LensMake as string,
      lensModel: exif.LensModel as string,
      focalLength: cleanFocalLengthText(focalLengthStr),
      focalLength35mm: cleanFocalLengthText(
        exif.FocalLengthIn35mmFormat?.toString()
      ),
      focalLengthNum:
        focalLengthNum === null ? null : Math.round(focalLengthNum * 10) / 10,
      aperture:
        exif.FNumber == null
          ? undefined
          : Math.round((exif.FNumber as number) * 10) / 10,
      shutterSpeed: shutterSpeedStr,
      shutterSpeedNum: parseShutterSpeedToNum(shutterSpeedStr),
      iso: exif.ISO as number,
      exposureCompensation: exif.ExposureCompensation as number,
      dateTaken: exif.DateTimeOriginal
        ? new Date(exif.DateTimeOriginal as string).getTime()
        : null,
      dateDigitized: exif.DateTimeDigitized
        ? new Date(exif.DateTimeDigitized as string).getTime()
        : null,
      flash: exif.Flash as boolean,
      orientation: exif.Orientation as number,
      gpsLatitude: (exif.latitude ?? exif.GPSLatitude) as number,
      gpsLongitude: (exif.longitude ?? exif.GPSLongitude) as number,
      gpsAltitude: exif.GPSAltitude as number,
      software: exif.Software as string,
      imageDescription: exif.ImageDescription as string,
      artist: (exif.Artist ?? exif.Creator) as string,
      copyright: exif.Copyright as string,
      rawJson: JSON.stringify(exif),
    };
  } else {
    log.warn(
      {
        filePath,
        ext: path.extname(filePath).toLowerCase(),
        hasExif: exif !== null && exif !== undefined,
      },
      "No EXIF metadata extracted for photo"
    );
  }

  try {
    const latest = await fs.promises.stat(filePath);
    if (
      stat.size !== latest.size ||
      stat.mtimeMs !== latest.mtimeMs ||
      stat.ctimeMs !== latest.ctimeMs ||
      stat.ino !== latest.ino ||
      stat.dev !== latest.dev
    ) {
      return null;
    }
  } catch {
    return null;
  }
  return { photoRecord, exifRecord, stat, phash };
}

async function observeIndexedPhoto(
  photo: { id: number; path: string },
  force = false,
  verifiedObservation?: LibraryFileObservation
): Promise<boolean> {
  if (librarySourceIsPaused(photo.path)) {
    return false;
  }
  const { observeLibraryPhoto } = await import("./library-content-refresh");
  return observeLibraryPhoto(photo.id, photo.path, {
    force,
    verifiedObservation,
  });
}

function assignDeeperPhotoFolder(
  db: ReturnType<typeof getDatabase>,
  photo: { id: number; folderId: number | null },
  folderId: number | null
): void {
  if (folderId === null || photo.folderId === folderId) {
    return;
  }
  const oldFolder =
    photo.folderId === null
      ? undefined
      : db
          .select({ path: folders.path })
          .from(folders)
          .where(eq(folders.id, photo.folderId))
          .get();
  const nextFolder = db
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.id, folderId))
    .get();
  if (
    nextFolder &&
    (!oldFolder ||
      getFolderDepth(nextFolder.path) > getFolderDepth(oldFolder.path))
  ) {
    db.update(photos).set({ folderId }).where(eq(photos.id, photo.id)).run();
  }
}

async function indexSingleFile(
  filePath: string,
  folderId: number | null,
  isCurrent = () => !librarySourceIsPaused(filePath)
): Promise<number | null> {
  const db = getDatabase();

  // Check if already indexed — update folderId to the more specific (deeper) folder
  const existing = db
    .select({
      id: photos.id,
      path: photos.path,
      folderId: photos.folderId,
      deletedAt: photos.deletedAt,
    })
    .from(photos)
    .where(libraryPhotoPathEquals(filePath))
    .get();
  if (existing) {
    if (existing.deletedAt !== null) {
      return existing.id;
    }
    acceptLibraryPathSpelling(db, existing, filePath);
    assignDeeperPhotoFolder(db, existing, folderId);
    await reconcileLibrarySources({
      photoIds: [existing.id],
      isCurrent,
      onAvailable: (photo) => observeIndexedPhoto(photo),
    });
    return existing.id;
  }

  const prepared = await preparePhotoRecord(filePath, folderId);
  if (!(prepared && isCurrent())) {
    return null;
  }

  const { photoRecord, exifRecord, stat, phash } = prepared;

  // A scan or another overlapping watcher may have inserted this path while
  // metadata/thumbnail preparation yielded. Reuse its row instead of racing it.
  const indexedDuringPreparation = db
    .select({ id: photos.id })
    .from(photos)
    .where(libraryPhotoPathEquals(filePath))
    .get();
  if (indexedDuringPreparation) {
    return indexedDuringPreparation.id;
  }

  // Insert photo record
  const result = db
    .insert(photos)
    .values(photoRecord)
    .returning({ insertedId: photos.id })
    .get();

  if (!result) {
    return null;
  }
  const photoId = result.insertedId;
  requestLibraryHashBackfill();

  // Incremental duplicate detection
  checkNewPhotoDuplicates(photoId, phash, filePath, stat.size);

  // Insert EXIF if available
  if (exifRecord) {
    try {
      exifRecord.photoId = photoId;
      db.insert(exifData).values(exifRecord).run();
    } catch (err: unknown) {
      log.warn({ filePath, err }, "EXIF insert failed");
    }
  }

  queuePrimaryColorVectorUpsert(photoId, photoRecord.dominantColors);

  return photoId;
}

/** Import only confirmed files, with catalog folders but without scanning or watching siblings. */
export async function indexExplicitPhotoFiles(
  filePaths: string[],
  signal?: AbortSignal,
  rootPath?: string
): Promise<{ added: number; failed: number; photoIds: number[] }> {
  const db = getDatabase();
  const photoIds: number[] = [];
  let failed = 0;
  for (const candidate of new Set(filePaths)) {
    if (signal?.aborted) {
      break;
    }
    const filePath = path.resolve(candidate);
    if (!shouldIndex(filePath)) {
      failed++;
      continue;
    }
    const existing = db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.path, filePath))
      .get();
    try {
      const folderId = registerExplicitPhotoFolder(filePath, rootPath);
      if (existing) {
        db.update(photos)
          .set({ folderId })
          .where(eq(photos.id, existing.id))
          .run();
        db.update(folders)
          .set({
            photoCount: sql`(select count(*) from photos where folder_id = ${folderId} and deleted_at is null)`,
          })
          .where(eq(folders.id, folderId))
          .run();
        continue;
      }
      const id = await indexSingleFile(filePath, folderId);
      if (!id) {
        failed++;
        continue;
      }
      photoIds.push(id);
      if (folderId !== null) {
        db.update(folders)
          .set({
            photoCount: sql`(select count(*) from photos where folder_id = ${folderId} and deleted_at is null)`,
          })
          .where(eq(folders.id, folderId))
          .run();
      }
    } catch {
      failed++;
    }
  }
  return { added: photoIds.length, failed, photoIds };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Folder scanning preserves cancellation, batching, duplicate handling, and progress lifecycle in one public operation.
export async function scanFolder(
  folderPath: string,
  onProgress?: ProgressCallback,
  options?: { background?: boolean }
): Promise<{
  incomplete: boolean;
  createdFolderIds: number[];
  folderId: number;
  photoIds: number[];
  newPhotoIds: number[];
  moved: number;
  updated: number;
  sourceChanges: number;
  missing: number;
  offline: number;
  inaccessible: number;
  skipped: number;
  failed: number;
  cancelled: boolean;
  folderExisted: boolean;
}> {
  const db = getDatabase();
  if (activeScanToken !== null) {
    throw new Error("A folder scan is already in progress");
  }
  const scanStarted = performance.now();
  const heifBefore = getHeifImportMetrics();
  const scanToken = { cancelled: false };
  activeScanToken = scanToken;
  let incomplete = false;
  const newPhotoIds: number[] = [];
  const createdFolderIds: number[] = [];
  const scope = path.resolve(folderPath);
  const current = () =>
    !scanToken.cancelled &&
    db === getDatabase() &&
    !librarySourceIsPaused(scope);

  try {
    if (!current()) {
      throw new Error("LIBRARY_SOURCE_BUSY");
    }
    let resolvedPath = scope;

    let folder = db
      .select()
      .from(folders)
      .where(
        process.platform === "win32"
          ? sql`lower(${folders.path}) = lower(${resolvedPath})`
          : eq(folders.path, resolvedPath)
      )
      .get();
    const folderExisted = !!folder;
    if (folder) {
      resolvedPath = folder.path;
    }
    const checkedAt = Date.now();
    const root = await inspectLibraryRoot(resolvedPath);
    if (root.status !== "available") {
      if (!folder) {
        throw new Error(
          `Folder unavailable: ${resolvedPath} (${root.errorCode})`
        );
      }
      if (current()) {
        writeLibraryFolderSource(
          db,
          resolvedPath,
          root,
          checkedAt,
          root.status
        );
      }
      const state = await reconcileLibrarySources({
        folderPath: resolvedPath,
        isCurrent: current,
      });
      return {
        incomplete: true,
        createdFolderIds,
        folderId: folder.id,
        photoIds: [],
        newPhotoIds,
        moved: 0,
        updated: 0,
        sourceChanges: state.changed,
        missing: state.missing,
        offline: state.offline,
        inaccessible: state.inaccessible,
        skipped: 0,
        failed: 0,
        cancelled: !current(),
        folderExisted,
      };
    }
    if (!current()) {
      throw new Error("LIBRARY_SOURCE_BUSY");
    }
    if (!folder) {
      folder = db
        .insert(folders)
        .values({
          path: resolvedPath,
          displayName: path.basename(resolvedPath),
        })
        .returning()
        .get();
      if (!folder) {
        throw new Error("Failed to create folder record");
      }
      createdFolderIds.push(folder.id);
    }

    const folderId = folder.id;
    db.update(folders)
      .set({ explicitOnly: false })
      .where(eq(folders.id, folderId))
      .run();
    invalidateFoldersCache();

    // Async walk — avoids blocking the main process on large folders.
    // Each directory level yields the event loop via setImmediate to keep the UI responsive.
    const files: string[] = [];
    async function recordDirectoryFailure(
      dir: string,
      error: unknown
    ): Promise<void> {
      if (!current()) {
        return;
      }
      const unavailable = await inspectLibraryRoot(dir);
      if (unavailable.status !== "available" && current()) {
        writeLibraryFolderSource(
          db,
          dir,
          unavailable,
          checkedAt,
          unavailable.status
        );
      }
      log.warn({ error, dir }, "Library directory check incomplete");
    }
    async function walk(dir: string): Promise<void> {
      if (!current()) {
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
      } catch (error) {
        incomplete = true;
        await recordDirectoryFailure(dir, error);
        return;
      }
      // Yield the event loop after reading each directory to prevent UI jank
      await new Promise<void>((r) => setImmediate(r));
      onProgress?.({
        scanned: files.length,
        total: 0,
        phase: "scanning",
        currentFile: dir,
      });
      for (const entry of entries) {
        if (!current()) {
          return;
        }
        const fullPath = path.join(dir, entry.name);
        if (
          entry.isDirectory() &&
          !SKIP_PATTERNS.some((pattern) => pattern.test(fullPath))
        ) {
          await walk(fullPath);
        } else if (entry.isFile() && shouldIndex(fullPath)) {
          files.push(fullPath);
        }
      }
    }
    await walk(resolvedPath);
    if (!current()) {
      scanToken.cancelled = true;
    }

    // Auto-discover subdirectories that contain images and create folder records.
    // Walk up from each file's directory to the scan root, creating any missing
    // intermediate folder records with proper parentId linkage.
    const dirToFolderId = new Map<string, number>();
    dirToFolderId.set(resolvedPath, folderId);

    for (const f of scanToken.cancelled ? [] : files) {
      let dir = path.dirname(f);

      // Collect missing ancestor directories (bottom-up)
      const missing: string[] = [];
      while (dir !== resolvedPath && !dirToFolderId.has(dir)) {
        missing.unshift(dir);
        dir = path.dirname(dir);
      }

      // Create missing directories top-down so parentId is available
      for (const d of missing) {
        const parentDir = path.dirname(d);
        const parentId = dirToFolderId.get(parentDir) ?? null;

        let subFolder = db
          .select({ id: folders.id })
          .from(folders)
          .where(eq(folders.path, d))
          .get();
        if (!subFolder) {
          const result = db
            .insert(folders)
            .values({
              path: d,
              displayName: path.basename(d),
              parentId,
            })
            .returning({ insertedId: folders.id })
            .get();
          if (result) {
            subFolder = { id: result.insertedId };
            createdFolderIds.push(result.insertedId);
          }
        } else if (subFolder) {
          // Existing folder record — update parentId if missing
          db.update(folders)
            .set({ parentId })
            .where(eq(folders.id, subFolder.id))
            .run();
        }

        if (subFolder) {
          dirToFolderId.set(d, subFolder.id);
        }
      }
    }

    // Index each file with concurrency for speed.
    // Sharp/libvips uses the libuv thread pool internally, so overlapping
    // thumbnail generation + metadata reads yields ~3x throughput on typical
    // consumer hardware without saturating I/O.
    const CONCURRENCY = 4;
    const BATCH_SIZE = 50;
    const photoIds: number[] = [];
    let scanned = 0;
    let skipped = 0;
    let failed = 0;
    let moved = 0;
    let updated = 0;
    let sourceChanges = 0;
    let missing = 0;
    let offline = 0;
    let inaccessible = 0;
    const movePlan = await planLibraryMoves(db, files, current, {
      include: shouldIndex,
      skipDirectory: (directory) =>
        SKIP_PATTERNS.some((pattern) => pattern.test(directory)),
      scan: { folderPath: resolvedPath, complete: !incomplete },
    });
    sourceChanges += movePlan.candidatesChanged ? 1 : 0;
    if (
      !incomplete &&
      current() &&
      pruneLibraryMoveTargets(db, resolvedPath, files)
    ) {
      sourceChanges++;
    }

    async function runWithConcurrency<T, R>(
      items: T[],
      fn: (item: T) => Promise<R | null>,
      limit: number
    ): Promise<Array<R | null>> {
      const results: Array<R | null> = new Array(items.length);
      let cursor = 0;

      async function worker(): Promise<void> {
        while (cursor < items.length && current()) {
          const idx = cursor++;
          const item = items[idx];
          results[idx] = await fn(item);
        }
      }

      const workers = Array.from(
        { length: Math.min(limit, items.length) },
        () => worker()
      );
      await Promise.all(workers);
      return results;
    }

    // Process one bounded batch at a time so EXIF/raw metadata for very large
    // folders cannot accumulate in memory before the first database write.
    for (
      let batchStart = 0;
      batchStart < files.length;
      batchStart += BATCH_SIZE
    ) {
      // Yield before observing this batch, never while retaining file evidence.
      if (
        options?.background &&
        !(await waitForLibraryForegroundIdle(current))
      ) {
        scanToken.cancelled = true;
        break;
      }
      if (!current()) {
        scanToken.cancelled = true;
        break;
      }
      const batchFiles = files.slice(batchStart, batchStart + BATCH_SIZE);
      const existingRows = db
        .select({ id: photos.id, folderId: photos.folderId, path: photos.path })
        .from(photos)
        .where(libraryPhotoPathsIn(batchFiles))
        .all();
      const existingByPath = new Map(
        existingRows.map((row) => [importPathKey(row.path), row])
      );
      if (existingRows.length) {
        for (const file of batchFiles) {
          const indexed = existingByPath.get(importPathKey(file));
          if (indexed) {
            acceptLibraryPathSpelling(db, indexed, file);
          }
        }
        const state = await reconcileLibrarySources({
          photoIds: existingRows.map(({ id }) => id),
          isCurrent: current,
          onAvailable: async (photo, observation) => {
            if (await observeIndexedPhoto(photo, false, observation)) {
              updated++;
            }
          },
        });
        sourceChanges += state.changed;
        missing += state.missing;
        offline += state.offline;
        inaccessible += state.inaccessible;
      }

      // Sample a bounded batch together, so stability checks do not add two
      // seconds to every four new photos in a large offline addition.
      const beforeWrite = new Map<string, fs.Stats>();
      if (options?.background) {
        await runWithConcurrency(
          batchFiles.filter((file) => !existingByPath.has(importPathKey(file))),
          async (file) => {
            try {
              beforeWrite.set(file, await fs.promises.stat(file));
            } catch {
              incomplete = true;
            }
          },
          CONCURRENCY
        );
        if (beforeWrite.size > 0) {
          await new Promise((resolve) => setTimeout(resolve, 2000));
        }
      }

      const preparedRecords = await runWithConcurrency(
        batchFiles,
        // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Per-file indexing callback keeps all error and cancellation branches together for queue ordering.
        async (file) => {
          if (!current()) {
            return null;
          }

          onProgress?.({
            scanned,
            total: files.length,
            phase: "indexing",
            currentFile: file,
          });

          try {
            const fileDir = path.dirname(file);
            const fileFolderId = dirToFolderId.get(fileDir) || folderId;

            // Check if already indexed
            const key = importPathKey(file);
            const existing = existingByPath.get(key);

            if (existing) {
              assignDeeperPhotoFolder(db, existing, fileFolderId);
              scanned++;
              return { type: "existing" as const, photoId: existing.id };
            }

            const move = movePlan.moves.get(key);
            if (move) {
              const photoId = await commitLibraryMove(
                db,
                move,
                file,
                fileFolderId,
                current
              );
              if (photoId !== null) {
                moved++;
                scanned++;
                return { type: "existing" as const, photoId };
              }
              // A concurrent watcher can already have completed the same move.
              const currentPhoto = db
                .select({ id: photos.id })
                .from(photos)
                .where(libraryPhotoPathEquals(file))
                .get();
              if (currentPhoto) {
                scanned++;
                return { type: "existing" as const, photoId: currentPhoto.id };
              }
              scanned++;
              return null;
            }
            if (movePlan.unresolved.has(key)) {
              scanned++;
              return null;
            }

            if (options?.background) {
              const before = beforeWrite.get(file);
              const after = await fs.promises.stat(file);
              if (
                !before ||
                before.size !== after.size ||
                before.mtimeMs !== after.mtimeMs
              ) {
                incomplete = true;
                scanned++;
                return null;
              }
            }
            const prepared = await preparePhotoRecord(file, fileFolderId);
            if (!prepared) {
              scanned++;
              return null;
            }

            scanned++;
            return { type: "new" as const, ...prepared };
          } catch (error) {
            log.error({ file, err: error }, "Error preparing file");
            failed++;
            scanned++;
            return null;
          }
        },
        CONCURRENCY
      );

      // Batch insert: insert photos in batches
      const newRecords = preparedRecords.filter(
        (r) => r && r.type === "new"
      ) as Array<{
        type: "new";
        photoRecord: PhotoRecord;
        exifRecord: ExifRecord | null;
        stat: fs.Stats;
        phash: string | null;
      }>;

      const existingRecords = preparedRecords.filter(
        (r) => r && r.type === "existing"
      ) as Array<{ type: "existing"; photoId: number }>;

      // Add existing photo IDs
      for (const record of existingRecords) {
        photoIds.push(record.photoId);
      }

      // Batch insert new photos
      for (let i = 0; i < newRecords.length; i += BATCH_SIZE) {
        if (!current()) {
          scanToken.cancelled = true;
          // Clean up thumbnails for prepared-but-uninserted records.
          // These files were processed by preparePhotoRecord (thumbnails
          // already on disk) but were never committed to the database, so
          // the IPC-level cancel cleanup won't find them.
          for (let k = i; k < newRecords.length; k++) {
            deletePhotoThumbnails(newRecords[k].photoRecord.path);
          }
          break;
        }

        // A watcher may finish while this scan prepares its batch. Include
        // that row in the scan result rather than attempting a duplicate insert.
        const batch = newRecords.slice(i, i + BATCH_SIZE).filter((record) => {
          const indexed = db
            .select({ id: photos.id })
            .from(photos)
            .where(libraryPhotoPathEquals(record.photoRecord.path))
            .get();
          if (indexed) {
            photoIds.push(indexed.id);
            return false;
          }
          return true;
        });
        if (batch.length === 0) {
          continue;
        }
        const photoRecords = batch.map((r) => r.photoRecord);

        try {
          const insertedPairs: Array<{
            photoId: number;
            record: (typeof batch)[number];
          }> = [];

          db.transaction(() => {
            const insertedIds = db
              .insert(photos)
              .values(photoRecords)
              .returning({ insertedId: photos.id })
              .all();

            for (let j = 0; j < insertedIds.length; j++) {
              const photoId = insertedIds[j].insertedId;
              const record = batch[j];

              photoIds.push(photoId);
              newPhotoIds.push(photoId);
              insertedPairs.push({ photoId, record });

              if (record.exifRecord) {
                try {
                  record.exifRecord.photoId = photoId;
                  db.insert(exifData).values(record.exifRecord).run();
                } catch (err: unknown) {
                  log.warn(
                    { filePath: record.photoRecord.path, err },
                    "EXIF insert failed"
                  );
                }
              }
            }
          });

          requestLibraryHashBackfill();
          for (const { photoId, record } of insertedPairs) {
            checkNewPhotoDuplicates(
              photoId,
              record.phash,
              record.photoRecord.path,
              record.stat.size
            );
            queuePrimaryColorVectorUpsert(
              photoId,
              record.photoRecord.dominantColors
            );
          }
        } catch (err: unknown) {
          // Fallback to individual inserts if batch fails
          log.warn(
            { err },
            "Batch insert failed, falling back to individual inserts"
          );
          for (const record of batch) {
            try {
              const result = db
                .insert(photos)
                .values(record.photoRecord)
                .returning({ insertedId: photos.id })
                .get();

              if (result) {
                const photoId = result.insertedId;
                photoIds.push(photoId);
                newPhotoIds.push(photoId);
                requestLibraryHashBackfill();

                checkNewPhotoDuplicates(
                  photoId,
                  record.phash,
                  record.photoRecord.path,
                  record.stat.size
                );
                queuePrimaryColorVectorUpsert(
                  photoId,
                  record.photoRecord.dominantColors
                );

                if (record.exifRecord) {
                  try {
                    record.exifRecord.photoId = photoId;
                    db.insert(exifData).values(record.exifRecord).run();
                  } catch {
                    /* skip */
                  }
                }
              }
            } catch {
              skipped++;
              failed++;
            }
          }
        }
      }

      // Count skipped files
      skipped += preparedRecords.filter((r) => r === null).length;
      if (scanToken.cancelled) {
        break;
      }
    }

    if (skipped > 0) {
      log.info(
        { indexed: photoIds.length, skipped, total: files.length },
        "Folder scan summary"
      );
    }

    if (current()) {
      const rootCheckedAt = Date.now();
      const finalRoot = await inspectLibraryRoot(resolvedPath);
      const unexpectedlyEmpty =
        files.length === 0 &&
        !!db
          .select({ id: photos.id })
          .from(photos)
          .where(
            and(
              isNull(photos.deletedAt),
              libraryPathCondition(photos.path, resolvedPath)
            )
          )
          .limit(1)
          .get();
      if (current()) {
        let scanResult: typeof folders.$inferSelect.lastScanResult = "complete";
        if (unexpectedlyEmpty) {
          scanResult = "empty";
        }
        if (incomplete) {
          scanResult = "incomplete";
        }
        if (finalRoot.status !== "available") {
          scanResult = finalRoot.status;
        }
        writeLibraryFolderSource(
          db,
          resolvedPath,
          finalRoot,
          rootCheckedAt,
          scanResult
        );
      }
      if (
        !(incomplete || unexpectedlyEmpty) ||
        finalRoot.status !== "available"
      ) {
        const state = await reconcileLibrarySources({
          folderPath: resolvedPath,
          isCurrent: current,
          unseenPaths:
            finalRoot.status === "available"
              ? new Set(files.map(importPathKey))
              : undefined,
        });
        sourceChanges += state.changed;
        missing += state.missing;
        offline += state.offline;
        inaccessible += state.inaccessible;
      }
      incomplete ||= unexpectedlyEmpty || finalRoot.status !== "available";
    }

    if (!current()) {
      scanToken.cancelled = true;
    }
    const folderIds = Array.from(new Set(dirToFolderId.values()));
    const folderPhotoCounts = new Map<number, number>();
    if (folderIds.length > 0) {
      const rows = db
        .select({
          count: sql<number>`count(*)`,
          folderId: photos.folderId,
        })
        .from(photos)
        .where(
          and(inArray(photos.folderId, folderIds), isNull(photos.deletedAt))
        )
        .groupBy(photos.folderId)
        .all();

      for (const row of rows) {
        if (row.folderId !== null) {
          folderPhotoCounts.set(row.folderId, row.count);
        }
      }
    }

    for (const fid of folderIds) {
      db.update(folders)
        .set({
          ...(scanToken.cancelled || incomplete
            ? {}
            : { lastScannedAt: Date.now() }),
          photoCount: folderPhotoCounts.get(fid) ?? 0,
        })
        .where(eq(folders.id, fid))
        .run();
    }

    // 重新加载文件夹匹配器缓存
    reloadFolderMatcher();

    if (!scanToken.cancelled) {
      onProgress?.({
        scanned: files.length,
        total: files.length,
        phase: "complete",
        currentFile: "",
      });
    }

    const heifAfter = getHeifImportMetrics();
    const heifMetrics = Object.fromEntries(
      Object.entries(heifAfter).map(([key, value]) => [
        key,
        value - (heifBefore[key] ?? 0),
      ])
    );
    log.info(
      {
        totalMs: performance.now() - scanStarted,
        scanned,
        failed,
        heif: heifMetrics,
      },
      "Import performance summary"
    );
    // Auto-tagging now runs after embedAllPhotos() completes, when all CLIP
    // vectors are available in LanceDB. This avoids expensive per-photo worker
    // embedding and prevents the scene-tag bias (every photo tagged as indoor/outdoor/city).

    return {
      incomplete,
      createdFolderIds: [...createdFolderIds],
      folderId,
      photoIds,
      newPhotoIds,
      moved,
      updated,
      sourceChanges,
      missing,
      offline,
      inaccessible,
      skipped,
      failed,
      cancelled: scanToken.cancelled,
      folderExisted,
    };
  } catch (error) {
    const inserted =
      newPhotoIds.length > 0
        ? db
            .select({ id: photos.id, path: photos.path })
            .from(photos)
            .where(inArray(photos.id, newPhotoIds))
            .all()
        : [];
    if (newPhotoIds.length > 0) {
      db.transaction(() => {
        db.delete(exifData).where(inArray(exifData.photoId, newPhotoIds)).run();
        db.delete(photos).where(inArray(photos.id, newPhotoIds)).run();
      });
      for (const record of inserted) {
        deletePhotoThumbnails(record.path);
      }
      await deletePhotoVectors(newPhotoIds).catch(() => {
        /* best-effort rollback */
      });
    }
    for (const folderId of createdFolderIds.reverse()) {
      const remaining = db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(eq(photos.folderId, folderId))
        .get()?.count;
      if (!remaining) {
        db.delete(folders).where(eq(folders.id, folderId)).run();
      }
    }
    reloadFolderMatcher();
    throw error;
  } finally {
    if (activeScanToken === scanToken) {
      activeScanToken = null;
    }
  }
}

// A watcher can discover files before a scan has registered their directories.
// Resolve the actual parent before asynchronous metadata work, so a stale
// ancestor match can never be written as the new photo's folder relation.
function resolveWatchedFileFolder(filePath: string): number | null {
  const db = getDatabase();
  const ancestorId = getFolderMatcher().match(filePath);
  if (ancestorId === null) {
    return null;
  }
  const ancestor = db
    .select()
    .from(folders)
    .where(eq(folders.id, ancestorId))
    .get();
  if (!ancestor) {
    return null;
  }
  const relative = path.relative(ancestor.path, path.dirname(filePath));
  if (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return null;
  }
  const folderId = db.transaction(() => {
    let parentId = ancestor.id;
    let directory = ancestor.path;
    for (const segment of relative.split(path.sep).filter(Boolean)) {
      directory = path.join(directory, segment);
      const existing = db
        .select({ id: folders.id })
        .from(folders)
        .where(
          process.platform === "win32"
            ? sql`lower(${folders.path}) = lower(${directory})`
            : eq(folders.path, directory)
        )
        .get();
      if (existing) {
        parentId = existing.id;
      } else {
        const inserted = db
          .insert(folders)
          .values({ path: directory, displayName: segment, parentId })
          .returning({ id: folders.id })
          .get();
        if (!inserted) {
          throw new Error("Failed to register watched directory");
        }
        parentId = inserted.id;
      }
    }
    return parentId;
  });
  if (folderId !== ancestorId) {
    reloadFolderMatcher();
  }
  return folderId;
}

async function applyWatcherAdd(
  context: WatcherContext,
  filePath: string,
  plan: LibraryMovePlan
): Promise<void> {
  const current = () =>
    isCurrentWatcher(context) && !librarySourceIsPaused(filePath);
  if (!current()) {
    return;
  }
  const { db } = context;
  const existing = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(libraryPhotoPathEquals(filePath))
    .get();
  if (existing) {
    acceptLibraryPathSpelling(db, existing, filePath);
    await checkWatchedSource(context, filePath, false);
    return;
  }
  const key = importPathKey(filePath);
  if (plan.unresolved.has(key)) {
    watcherStats.skipped++;
    log.info({ filePath }, "Deferred ambiguous or unstable library move");
    return;
  }
  const folderId = resolveWatchedFileFolder(filePath);
  if (folderId === null) {
    return;
  }
  const move = plan.moves.get(key);
  const photoId = move
    ? await commitLibraryMove(db, move, filePath, folderId, current)
    : await indexSingleFile(filePath, folderId, current);
  if (!(current() && photoId)) {
    return;
  }
  db.update(folders)
    .set({
      photoCount: sql`(SELECT count(*) FROM photos WHERE folder_id = ${folderId} AND deleted_at IS NULL)`,
      lastWatcherEventAt: Date.now(),
    })
    .where(eq(folders.id, folderId))
    .run();
  watcherStats.processed++;
  context.onChange?.(photoId, move ? "update" : "add");
}

function queueWatcherAdd(context: WatcherContext, filePath: string): void {
  pendingWatcherAdds.set(importPathKey(filePath), { context, filePath });
  watcherAddTimer ??= setTimeout(() => {
    watcherAddTimer = undefined;
    const batch = [...pendingWatcherAdds.values()];
    pendingWatcherAdds.clear();
    watcherQueue
      .add(async () => {
        const active = batch.filter(
          (item) =>
            isCurrentWatcher(item.context) &&
            !librarySourceIsPaused(item.filePath)
        );
        if (!active.length) {
          return;
        }
        const plan = await planWatchedLibraryMoves(
          active[0].context.db,
          active.map((item) => item.filePath),
          () => active.some((item) => isCurrentWatcher(item.context)),
          shouldIndex,
          (directory) =>
            SKIP_PATTERNS.some((pattern) => pattern.test(directory))
        );
        if (plan.candidatesChanged) {
          active[0].context.onChange?.(null, "status");
        }
        for (const item of active) {
          await applyWatcherAdd(item.context, item.filePath, plan);
        }
      })
      .catch((err: unknown) => {
        watcherStats.errors++;
        log.error({ err }, "Watcher: Error processing added files");
      });
  }, 125);
  watcherAddTimer.unref?.();
}

async function checkWatchedSource(
  context: WatcherContext,
  filePath: string,
  force: boolean
): Promise<void> {
  const current = () =>
    isCurrentWatcher(context) && !librarySourceIsPaused(filePath);
  if (!current()) {
    return;
  }
  const photo = context.db
    .select({ id: photos.id, folderId: photos.folderId })
    .from(photos)
    .where(and(libraryPhotoPathEquals(filePath), isNull(photos.deletedAt)))
    .get();
  if (!photo) {
    return;
  }
  let updated = false;
  const status = await reconcileLibrarySources({
    photoIds: [photo.id],
    isCurrent: current,
    onAvailable: async (observed) => {
      updated = await observeIndexedPhoto(observed, force);
    },
  });
  if (!(current() && (status.changed || updated))) {
    watcherStats.skipped++;
    return;
  }
  if (photo.folderId !== null) {
    context.db
      .update(folders)
      .set({ lastWatcherEventAt: Date.now() })
      .where(eq(folders.id, photo.folderId))
      .run();
  }
  watcherStats.processed++;
  context.onChange?.(photo.id, updated ? "update" : "status");
}

function queueWatcherSourceCheck(
  context: WatcherContext,
  filePath: string,
  force = false
): void {
  watcherQueue
    .add(() => checkWatchedSource(context, filePath, force))
    .catch((err: unknown) => {
      watcherStats.errors++;
      log.error({ filePath, err }, "Watcher: Error checking photo source");
    });
}

export function startWatching(onChange: WatchChange): void {
  const indexedFolders = getDatabase()
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.explicitOnly, false))
    .all();
  for (const folder of [...indexedFolders].sort(
    (a, b) => a.path.length - b.path.length
  )) {
    installWatcher(folder.path, onChange);
  }
  log.info({ count: watchers.size }, "Watcher: Started watching folders");
}

function installWatcher(folderPath: string, onChange: WatchChange): void {
  if (
    [...watchers.values()].some((context) =>
      containsLibraryPath(context.folderPath, folderPath)
    )
  ) {
    return;
  }
  const key = watcherPathKey(folderPath);
  const retry = retries.get(key);
  if (retry) {
    clearTimeout(retry.timer);
    retries.delete(key);
  }
  const db = getDatabase();
  if (findFolderId(db, folderPath) === null) {
    return;
  }
  for (const context of [...watchers.values()]) {
    if (containsLibraryPath(folderPath, context.folderPath)) {
      removeCurrentWatcher(context);
      closeWatcherSafely(context).catch(() => undefined);
    }
  }
  const context = createWatcher(db, folderPath, findFolderId(db, folderPath));
  if (!context) {
    retryWatch(folderPath, onChange);
    return;
  }
  context.onChange = onChange;
  const watcher = context.watcher;
  watcher.on("addDir", () => {
    if (isCurrentWatcher(context)) {
      onWatcherReady?.(folderPath);
    }
  });
  watcher.on("ready", () => {
    if (!isCurrentWatcher(context)) {
      return;
    }
    if (!updateWatcherState(context, true)) {
      handleWatcherError(
        context,
        new Error("Failed to publish watcher readiness")
      );
      return;
    }
    onWatcherReady?.(folderPath);
  });
  watcher.on("add", (filePath) => {
    if (isCurrentWatcher(context) && shouldIndex(filePath)) {
      watcherStats.addEvents++;
      queueWatcherAdd(context, filePath);
    }
  });
  watcher.on("change", (filePath) => {
    if (isCurrentWatcher(context) && shouldIndex(filePath)) {
      queueWatcherSourceCheck(context, filePath, true);
    }
  });
  watcher.on("unlink", (filePath) => {
    if (isCurrentWatcher(context)) {
      watcherStats.unlinkEvents++;
      if (forgetLibraryMoveTarget(context.db, filePath)) {
        onChange(null, "status");
      }
      queueWatcherSourceCheck(context, filePath);
    }
  });
  watcher.on("unlinkDir", () => {
    if (isCurrentWatcher(context)) {
      watcherQueue
        .add(async () => {
          const status = await reconcileLibrarySources({
            folderPath,
            isCurrent: () => isCurrentWatcher(context),
          });
          if (status.changed && isCurrentWatcher(context)) {
            onChange(null, "status");
          }
        })
        .catch((err: unknown) => {
          watcherStats.errors++;
          log.error(
            { folderPath, err },
            "Watcher: Error checking removed directory"
          );
        });
      onWatcherReady?.(folderPath);
    }
  });
}

export function watchFolder(folderPath: string, onChange: WatchChange): void {
  const db = getDatabase();
  db.update(folders)
    .set({ explicitOnly: false })
    .where(eq(folders.path, path.resolve(folderPath)))
    .run();
  invalidateFoldersCache();
  installWatcher(folderPath, onChange);
}

/** Stop watchers rooted at this folder or one of its descendants. */
export async function unwatchFolder(folderPath: string): Promise<void> {
  const root = watcherPathKey(folderPath);
  const closing: Promise<void>[] = [];
  for (const [key, retry] of retries) {
    if (containsLibraryPath(root, key)) {
      clearTimeout(retry.timer);
      retries.delete(key);
      retryCounts.delete(key);
    }
  }
  for (const [key, context] of watchers) {
    if (containsLibraryPath(root, key)) {
      removeCurrentWatcher(context);
      closing.push(closeWatcherSafely(context));
    }
  }
  await Promise.all(closing);
}

export async function stopWatching(): Promise<void> {
  const db = getDatabase();

  for (const retry of retries.values()) {
    clearTimeout(retry.timer);
  }
  retries.clear();
  retryCounts.clear();
  clearTimeout(watcherAddTimer);
  watcherAddTimer = undefined;
  pendingWatcherAdds.clear();

  const contexts = Array.from(watchers.values());
  watchers.clear();
  await Promise.all(contexts.map((context) => closeWatcherSafely(context)));
  await watcherQueue.onIdle();

  // 更新所有文件夹状态
  try {
    db.update(folders).set({ isWatching: false, watcherStartedAt: null }).run();
  } catch (error) {
    logWatcherFailure(
      { folderId: null, folderPath: "<all>" },
      error,
      "state",
      "Watcher: Failed to update stopped state"
    );
  }

  log.info({ stats: watcherStats }, "Watcher: Stopped");

  watcherStats = {
    addEvents: 0,
    unlinkEvents: 0,
    processed: 0,
    skipped: 0,
    errors: 0,
  };
}

export function cleanupOrphanedRecords(): Promise<{
  checked: number;
  removed: number;
}> {
  return cleanupOrphanedRecordsAsync();
}

/** Historical entry point. Absence only changes the recorded source state. */
export async function cleanupOrphanedRecordsAsync(
  onProgress?: (checked: number, removed: number, total: number) => void,
  signal?: AbortSignal
): Promise<{ checked: number; removed: number }> {
  const summary = await reconcileLibrarySources({
    signal,
    onProgress: ({ checked }) => onProgress?.(checked, 0, checked),
  });
  return { checked: summary.checked, removed: 0 };
}

export function stopScanning(): void {
  if (activeScanToken) {
    activeScanToken.cancelled = true;
  }
}
