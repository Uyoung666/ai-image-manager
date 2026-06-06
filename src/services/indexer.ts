import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { eq, sql } from "drizzle-orm";
import exifr from "exifr";
import PQueue from "p-queue";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { exifData, folders, photos } from "@/db/schema";
import { createLogger } from "@/utils/logger";
import { deletePhotoVectors } from "./ai-embedder";
import { extractDominantColors } from "./color-extractor";
import { checkNewPhotoDuplicates } from "./dedup-service";
import { getFolderMatcher, reloadFolderMatcher } from "./folder-matcher";
import { extractRawPreview, isRawFile } from "./raw-preview";
import { deletePhotoThumbnails, generateThumbnail } from "./thumbnailer";

const log = createLogger("indexer");

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

interface IndexProgress {
  currentFile: string;
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

type ProgressCallback = (progress: IndexProgress) => void;
let isScanning = false;
let wasCancelled = false;
let watchers: FSWatcher[] = [];

export function isIndexing(): boolean {
  return isScanning;
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

function dct1D(input: Float64Array): Float64Array {
  const N = input.length;
  const output = new Float64Array(N);
  const piOver2N = Math.PI / (2 * N);
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos((2 * n + 1) * k * piOver2N);
    }
    output[k] = sum;
  }
  return output;
}

function dct2D(matrix: Float64Array[], size: number): Float64Array[] {
  // DCT on rows
  const rowTransformed: Float64Array[] = [];
  for (let i = 0; i < size; i++) {
    rowTransformed.push(dct1D(matrix[i]));
  }
  // DCT on columns
  const result: Float64Array[] = Array.from(
    { length: size },
    () => new Float64Array(size)
  );
  for (let j = 0; j < size; j++) {
    const col = new Float64Array(size);
    for (let i = 0; i < size; i++) {
      col[i] = rowTransformed[i][j];
    }
    const colDct = dct1D(col);
    for (let i = 0; i < size; i++) {
      result[i][j] = colDct[i];
    }
  }
  return result;
}

async function computePHash(filePath: string): Promise<string | null> {
  try {
    const SIZE = 32;
    const { data } = await sharp(filePath)
      .resize(SIZE, SIZE, { fit: "fill" })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    const pixels = new Uint8Array(data);

    // Build 32×32 float matrix
    const matrix: Float64Array[] = [];
    for (let i = 0; i < SIZE; i++) {
      const row = new Float64Array(SIZE);
      for (let j = 0; j < SIZE; j++) {
        row[j] = pixels[i * SIZE + j];
      }
      matrix.push(row);
    }

    // 2D DCT
    const dct = dct2D(matrix, SIZE);

    // Extract top-left 8×8 (lowest frequency coefficients, excluding DC at [0][0])
    const lowFreq: number[] = [];
    for (let i = 0; i < 8; i++) {
      for (let j = 0; j < 8; j++) {
        if (i === 0 && j === 0) {
          continue; // skip DC component
        }
        lowFreq.push(dct[i][j]);
      }
    }

    // Median threshold
    const sorted = [...lowFreq].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];

    // 64-bit hash (63 values from 8×8 minus DC = 63, pad to 64)
    let hash = 0n;
    for (let i = 0; i < lowFreq.length; i++) {
      if (lowFreq[i] > median) {
        hash |= 1n << BigInt(i);
      }
    }

    return hash.toString(16).padStart(16, "0");
  } catch {
    return null;
  }
}

async function readBasicMeta(filePath: string): Promise<{
  width: number;
  height: number;
  format: string;
  colorSpace: string;
  hasAlpha: boolean;
} | null> {
  try {
    const raw = isRawFile(filePath);
    // For RAW files, read metadata from the embedded JPEG preview
    let input: string | Buffer = filePath;
    if (raw) {
      const preview = await extractRawPreview(filePath);
      if (preview) {
        input = preview;
      }
    }
    const meta = await sharp(input).metadata();
    // RAW files: use file extension as format (sharp returns "jpeg" from embedded preview)
    const format = raw
      ? path.extname(filePath).toLowerCase().replace(".", "")
      : meta.format || "";
    return {
      width: meta.width || 0,
      height: meta.height || 0,
      format,
      colorSpace: meta.space || "",
      hasAlpha: meta.hasAlpha,
    };
  } catch {
    return null;
  }
}

async function readExif(
  filePath: string
): Promise<Record<string, unknown> | null> {
  try {
    return await exifr.parse(filePath, {
      pick: [
        "Make",
        "Model",
        "LensMake",
        "LensModel",
        "FocalLength",
        "FocalLengthIn35mmFormat",
        "FNumber",
        "ExposureTime",
        "ISO",
        "ExposureCompensation",
        "DateTimeOriginal",
        "DateTimeDigitized",
        "Flash",
        "Orientation",
        "GPSLatitude",
        "GPSLongitude",
        "GPSAltitude",
        "latitude",
        "longitude",
        "Software",
        "ImageDescription",
        "Artist",
        "Copyright",
      ],
    });
  } catch {
    return null;
  }
}

interface PhotoRecord {
  colorSpace: string;
  dominantColors: string | null;
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
  const fracMatch = value.match(/^(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/);
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

async function preparePhotoRecord(
  filePath: string,
  folderId: number | null
): Promise<{
  photoRecord: PhotoRecord;
  exifRecord: ExifRecord | null;
  stat: fs.Stats;
  phash: string | null;
} | null> {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
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
  let thumb;
  try {
    thumb = await generateThumbnail(filePath, "md");
  } catch {
    log.warn({ filePath }, "Thumbnail generation failed");
    thumb = { thumbnailPath: null, width: 0, height: 0 };
  }

  const phash = await computePHash(filePath);

  // 提取主色调（使用缩略图，3-8ms/张）
  let dominantColors: string | null = null;
  if (thumb.thumbnailPath) {
    try {
      dominantColors = await extractDominantColors(thumb.thumbnailPath);
    } catch (err) {
      // 颜色提取失败不阻塞索引
      console.warn(`[Indexer] Color extraction failed for ${filePath}:`, err);
    }
  }

  const photoRecord: PhotoRecord = {
    path: filePath,
    folderId,
    filename: path.basename(filePath),
    fileSize: stat.size,
    fileDate: Math.floor(Math.min(stat.birthtimeMs, stat.mtimeMs)),
    width: meta.width,
    height: meta.height,
    format: meta.format,
    colorSpace: meta.colorSpace,
    hasAlpha: meta.hasAlpha,
    thumbnailPath: thumb.thumbnailPath,
    thumbnailSize: `${thumb.width}x${thumb.height}`,
    isIndexed: true,
    phash,
    dominantColors,
  };

  // Extract EXIF
  const exif = await readExif(filePath);
  let exifRecord: ExifRecord | null = null;

  if (exif && Object.keys(exif).length > 0) {
    const focalLengthStr = exif.FocalLength?.toString();
    const shutterSpeedStr = exif.ExposureTime?.toString();
    exifRecord = {
      photoId: 0, // Will be set after insert
      cameraMake: exif.Make as string,
      cameraModel: exif.Model as string,
      lensMake: exif.LensMake as string,
      lensModel: exif.LensModel as string,
      focalLength: focalLengthStr,
      focalLength35mm: exif.FocalLengthIn35mmFormat?.toString(),
      focalLengthNum: parseFocalLengthToNum(focalLengthStr),
      aperture: exif.FNumber as number,
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
      artist: exif.Artist as string,
      copyright: exif.Copyright as string,
      rawJson: JSON.stringify(exif),
    };
  }

  return { photoRecord, exifRecord, stat, phash };
}

async function indexSingleFile(
  filePath: string,
  folderId: number | null
): Promise<number | null> {
  const db = getDatabase();

  // Check if already indexed — update folderId to the more specific (deeper) folder
  const existing = db
    .select({ id: photos.id, folderId: photos.folderId })
    .from(photos)
    .where(eq(photos.path, filePath))
    .get();
  if (existing) {
    if (folderId !== null && existing.folderId !== folderId) {
      // Only reassign if the new folder is more specific (deeper path) than the current one
      const existingFolder = existing.folderId
        ? db
            .select({ path: folders.path })
            .from(folders)
            .where(eq(folders.id, existing.folderId))
            .get()
        : null;
      const newFolder = db
        .select({ path: folders.path })
        .from(folders)
        .where(eq(folders.id, folderId))
        .get();
      if (
        newFolder &&
        (!existingFolder ||
          getFolderDepth(newFolder.path) > getFolderDepth(existingFolder.path))
      ) {
        db.update(photos)
          .set({ folderId })
          .where(eq(photos.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }

  const prepared = await preparePhotoRecord(filePath, folderId);
  if (!prepared) {
    return null;
  }

  const { photoRecord, exifRecord, stat, phash } = prepared;

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

  // Incremental duplicate detection
  checkNewPhotoDuplicates(photoId, phash, filePath, stat.size);

  // Insert EXIF if available
  if (exifRecord) {
    try {
      exifRecord.photoId = photoId;
      db.insert(exifData).values(exifRecord).run();
    } catch (err: any) {
      log.warn({ filePath, err }, "EXIF insert failed");
    }
  }

  return photoId;
}

export async function scanFolder(
  folderPath: string,
  onProgress?: ProgressCallback
): Promise<{
  folderId: number;
  photoIds: number[];
  skipped: number;
  cancelled: boolean;
  folderExisted: boolean;
}> {
  const db = getDatabase();
  isScanning = true;
  wasCancelled = false;

  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Folder does not exist: ${resolvedPath}`);
  }

  let folder = db
    .select()
    .from(folders)
    .where(eq(folders.path, resolvedPath))
    .get();
  const folderExisted = !!folder;
  if (!folder) {
    const result = db
      .insert(folders)
      .values({
        path: resolvedPath,
        displayName: path.basename(resolvedPath),
      })
      .returning({ insertedId: folders.id })
      .get();
    if (!result) {
      throw new Error("Failed to create folder record");
    }
    folder = {
      id: result.insertedId,
      path: resolvedPath,
      displayName: path.basename(resolvedPath),
      parentId: null,
      photoCount: 0,
      lastScannedAt: null,
      createdAt: Date.now(),
      isWatching: false,
      watcherStartedAt: null,
      lastWatcherEventAt: null,
    };
  }

  const folderId = folder.id;

  // Async walk — avoids blocking the main process on large folders.
  // Each directory level yields the event loop via setImmediate to keep the UI responsive.
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      // Permission denied or directory removed — skip silently
      return;
    }
    // Yield the event loop after reading each directory to prevent UI jank
    await new Promise<void>((r) => setImmediate(r));
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && shouldIndex(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  await walk(resolvedPath);

  // Auto-discover subdirectories that contain images and create folder records.
  // Walk up from each file's directory to the scan root, creating any missing
  // intermediate folder records with proper parentId linkage.
  const dirToFolderId = new Map<string, number>();
  dirToFolderId.set(resolvedPath, folderId);

  for (const f of files) {
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

  async function runWithConcurrency<T, R>(
    items: T[],
    fn: (item: T) => Promise<R | null>,
    limit: number
  ): Promise<Array<R | null>> {
    const results: Array<R | null> = new Array(items.length);
    let cursor = 0;

    async function worker(): Promise<void> {
      while (cursor < items.length && isScanning) {
        const idx = cursor++;
        const item = items[idx];
        results[idx] = await fn(item);
      }
    }

    const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
      worker()
    );
    await Promise.all(workers);
    return results;
  }

  // Batch preparation: prepare all photo records with concurrency
  const preparedRecords = await runWithConcurrency(
    files,
    async (file) => {
      if (!isScanning) {
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
        const existing = db
          .select({ id: photos.id, folderId: photos.folderId })
          .from(photos)
          .where(eq(photos.path, file))
          .get();

        if (existing) {
          if (fileFolderId !== null && existing.folderId !== fileFolderId) {
            const existingFolder = existing.folderId
              ? db
                  .select({ path: folders.path })
                  .from(folders)
                  .where(eq(folders.id, existing.folderId))
                  .get()
              : null;
            const newFolder = db
              .select({ path: folders.path })
              .from(folders)
              .where(eq(folders.id, fileFolderId))
              .get();
            if (
              newFolder &&
              (!existingFolder ||
                getFolderDepth(newFolder.path) >
                  getFolderDepth(existingFolder.path))
            ) {
              db.update(photos)
                .set({ folderId: fileFolderId })
                .where(eq(photos.id, existing.id))
                .run();
            }
          }
          scanned++;
          return { type: "existing" as const, photoId: existing.id };
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
    if (!isScanning) {
      break;
    }

    const batch = newRecords.slice(i, i + BATCH_SIZE);
    const photoRecords = batch.map((r) => r.photoRecord);

    try {
      // Batch insert photos
      const insertedIds = db
        .insert(photos)
        .values(photoRecords)
        .returning({ insertedId: photos.id })
        .all();

      // Process each inserted photo
      for (let j = 0; j < insertedIds.length; j++) {
        const photoId = insertedIds[j].insertedId;
        const record = batch[j];

        photoIds.push(photoId);

        // Incremental duplicate detection
        checkNewPhotoDuplicates(
          photoId,
          record.phash,
          record.photoRecord.path,
          record.stat.size
        );

        // Insert EXIF if available
        if (record.exifRecord) {
          try {
            record.exifRecord.photoId = photoId;
            db.insert(exifData).values(record.exifRecord).run();
          } catch (err: any) {
            log.warn(
              { filePath: record.photoRecord.path, err },
              "EXIF insert failed"
            );
          }
        }
      }
    } catch (err: any) {
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

            checkNewPhotoDuplicates(
              photoId,
              record.phash,
              record.photoRecord.path,
              record.stat.size
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
        }
      }
    }
  }

  // Count skipped files
  skipped = preparedRecords.filter((r) => r === null).length;

  if (skipped > 0) {
    log.info(
      { indexed: photoIds.length, skipped, total: files.length },
      "Folder scan summary"
    );
  }

  // Clean up photos whose files no longer exist on disk — check all folders
  for (const [dirPath, fid] of dirToFolderId) {
    const dbPhotos = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(eq(photos.folderId, fid))
      .all();
    for (const p of dbPhotos) {
      if (!fs.existsSync(p.path)) {
        db.delete(exifData).where(eq(exifData.photoId, p.id)).run();
        db.delete(photos).where(eq(photos.id, p.id)).run();
        const idx = photoIds.indexOf(p.id);
        if (idx >= 0) {
          photoIds.splice(idx, 1);
        }
        log.info({ path: p.path }, "Removed stale record");
      }
    }
  }

  for (const [dirPath, fid] of dirToFolderId) {
    const count = photoIds.filter((pid) => {
      const photo = db
        .select({ folderId: photos.folderId })
        .from(photos)
        .where(eq(photos.id, pid))
        .get();
      return photo && photo.folderId === fid;
    }).length;
    db.update(folders)
      .set({ photoCount: count, lastScannedAt: Date.now() })
      .where(eq(folders.id, fid))
      .run();
  }

  // 重新加载文件夹匹配器缓存
  reloadFolderMatcher();

  onProgress?.({
    scanned: files.length,
    total: files.length,
    phase: "complete",
    currentFile: "",
  });

  isScanning = false;

  // Auto-tagging now runs after embedAllPhotos() completes, when all CLIP
  // vectors are available in LanceDB. This avoids expensive per-photo worker
  // embedding and prevents the scene-tag bias (every photo tagged as indoor/outdoor/city).

  return {
    folderId,
    photoIds,
    skipped,
    cancelled: wasCancelled,
    folderExisted,
  };
}

export function startWatching(
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const db = getDatabase();
  const indexedFolders = db
    .select({ id: folders.id, path: folders.path })
    .from(folders)
    .all();

  for (const folder of indexedFolders) {
    const watcher = chokidar.watch(folder.path, {
      ignored: [/\.thumbnails/, /\.cache/],
      ignorePermissionErrors: true,
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      depth: 10,
    });

    watcher.on("add", (filePath) => {
      if (!shouldIndex(filePath)) {
        return;
      }
      watcherStats.addEvents++;

      watcherQueue.add(async () => {
        try {
          const matchedFolderId = getFolderMatcher().match(filePath);

          const alreadyIndexed = db
            .select({ id: photos.id })
            .from(photos)
            .where(eq(photos.path, filePath))
            .get();

          if (alreadyIndexed) {
            watcherStats.skipped++;
            return;
          }

          const photoId = await indexSingleFile(filePath, matchedFolderId);
          if (matchedFolderId && photoId) {
            db.update(folders)
              .set({
                photoCount: sql`photo_count + 1`,
                lastWatcherEventAt: Date.now(),
              })
              .where(eq(folders.id, matchedFolderId))
              .run();
          }
          watcherStats.processed++;
          onChange(photoId, "add");
        } catch (err) {
          watcherStats.errors++;
          log.error({ filePath, err }, "Watcher: Error processing add event");
        }
      });
    });

    watcher.on("unlink", (filePath) => {
      watcherStats.unlinkEvents++;

      watcherQueue.add(async () => {
        try {
          const photo = db
            .select({ id: photos.id, folderId: photos.folderId })
            .from(photos)
            .where(eq(photos.path, filePath))
            .get();
          if (photo) {
            db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
            db.delete(photos).where(eq(photos.id, photo.id)).run();
            deletePhotoThumbnails(filePath);
            deletePhotoVectors([photo.id]).catch((err) =>
              log.error(
                { err, photoId: photo.id },
                "Watcher: vector cleanup failed on unlink"
              )
            );

            if (photo.folderId) {
              db.update(folders)
                .set({
                  photoCount: sql`photo_count - 1`,
                  lastWatcherEventAt: Date.now(),
                })
                .where(eq(folders.id, photo.folderId))
                .run();
            }

            watcherStats.processed++;
            onChange(photo.id, "remove");
          }
        } catch (err) {
          watcherStats.errors++;
          log.error(
            { filePath, err },
            "Watcher: Error processing unlink event"
          );
        }
      });
    });

    // 更新文件夹 watcher 状态
    db.update(folders)
      .set({
        isWatching: true,
        watcherStartedAt: Date.now(),
      })
      .where(eq(folders.id, folder.id))
      .run();

    watchers.push(watcher);
  }

  log.info(
    { count: indexedFolders.length },
    "Watcher: Started watching folders"
  );
}

export function watchFolder(
  folderPath: string,
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const db = getDatabase();
  const watcher = chokidar.watch(folderPath, {
    ignored: [/\.thumbnails/, /\.cache/],
    ignorePermissionErrors: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    depth: 10,
  });

  watcher.on("add", (filePath) => {
    if (!shouldIndex(filePath)) {
      return;
    }
    watcherStats.addEvents++;

    watcherQueue.add(async () => {
      try {
        const matchedFolderId = getFolderMatcher().match(filePath);

        const alreadyIndexed = db
          .select({ id: photos.id })
          .from(photos)
          .where(eq(photos.path, filePath))
          .get();

        if (alreadyIndexed) {
          watcherStats.skipped++;
          return;
        }

        const photoId = await indexSingleFile(filePath, matchedFolderId);
        if (matchedFolderId && photoId) {
          db.update(folders)
            .set({
              photoCount: sql`photo_count + 1`,
              lastWatcherEventAt: Date.now(),
            })
            .where(eq(folders.id, matchedFolderId))
            .run();
        }
        watcherStats.processed++;
        onChange(photoId, "add");
      } catch (err) {
        watcherStats.errors++;
        log.error({ filePath, err }, "Watcher: Error processing add event");
      }
    });
  });

  watcher.on("unlink", (filePath) => {
    watcherStats.unlinkEvents++;

    watcherQueue.add(async () => {
      try {
        const photo = db
          .select({ id: photos.id, folderId: photos.folderId })
          .from(photos)
          .where(eq(photos.path, filePath))
          .get();
        if (photo) {
          db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
          db.delete(photos).where(eq(photos.id, photo.id)).run();
          deletePhotoThumbnails(filePath);
          deletePhotoVectors([photo.id]).catch((err) =>
            log.error(
              { err, photoId: photo.id },
              "Watcher: vector cleanup failed on unlink"
            )
          );

          if (photo.folderId) {
            db.update(folders)
              .set({
                photoCount: sql`photo_count - 1`,
                lastWatcherEventAt: Date.now(),
              })
              .where(eq(folders.id, photo.folderId))
              .run();
          }

          watcherStats.processed++;
          onChange(photo.id, "remove");
        }
      } catch (err) {
        watcherStats.errors++;
        log.error({ filePath, err }, "Watcher: Error processing unlink event");
      }
    });
  });

  watchers.push(watcher);
}

export async function stopWatching(): Promise<void> {
  const db = getDatabase();

  // 等待队列清空
  await watcherQueue.onIdle();

  for (const watcher of watchers) {
    await watcher.close();
  }
  watchers = [];

  // 更新所有文件夹状态
  db.update(folders).set({ isWatching: false }).run();

  log.info({ stats: watcherStats }, "Watcher: Stopped");

  watcherStats = {
    addEvents: 0,
    unlinkEvents: 0,
    processed: 0,
    skipped: 0,
    errors: 0,
  };
}

export async function cleanupOrphanedRecords(): Promise<{
  checked: number;
  removed: number;
}> {
  const db = getDatabase();
  const allPhotos = db
    .select({ id: photos.id, path: photos.path, folderId: photos.folderId })
    .from(photos)
    .all();

  let removed = 0;
  const folderUpdates = new Map<number, number>();

  for (const photo of allPhotos) {
    if (!fs.existsSync(photo.path)) {
      db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
      db.delete(photos).where(eq(photos.id, photo.id)).run();

      if (photo.folderId) {
        folderUpdates.set(
          photo.folderId,
          (folderUpdates.get(photo.folderId) || 0) + 1
        );
      }

      removed++;
    }
  }

  for (const [folderId, count] of folderUpdates) {
    db.update(folders)
      .set({ photoCount: sql`photo_count - ${count}` })
      .where(eq(folders.id, folderId))
      .run();
  }

  return { checked: allPhotos.length, removed };
}

/**
 * Async variant of cleanupOrphanedRecords — yields the event loop every
 * BATCH_SIZE photos so the UI stays responsive during startup cleanup.
 */
export async function cleanupOrphanedRecordsAsync(
  onProgress?: (checked: number, removed: number, total: number) => void
): Promise<{ checked: number; removed: number }> {
  const db = getDatabase();
  const allPhotos = db
    .select({ id: photos.id, path: photos.path, folderId: photos.folderId })
    .from(photos)
    .all();

  let removed = 0;
  const folderUpdates = new Map<number, number>();
  const BATCH_SIZE = 200;

  for (let i = 0; i < allPhotos.length; i += BATCH_SIZE) {
    const batch = allPhotos.slice(i, i + BATCH_SIZE);
    for (const photo of batch) {
      if (!fs.existsSync(photo.path)) {
        db.delete(exifData).where(eq(exifData.photoId, photo.id)).run();
        db.delete(photos).where(eq(photos.id, photo.id)).run();

        if (photo.folderId) {
          folderUpdates.set(
            photo.folderId,
            (folderUpdates.get(photo.folderId) || 0) + 1
          );
        }
        removed++;
      }
    }
    // Yield the event loop every batch to keep UI responsive
    await new Promise<void>((resolve) => setImmediate(resolve));
    onProgress?.(Math.min(i + BATCH_SIZE, allPhotos.length), removed, allPhotos.length);
  }

  for (const [folderId, count] of folderUpdates) {
    db.update(folders)
      .set({ photoCount: sql`photo_count - ${count}` })
      .where(eq(folders.id, folderId))
      .run();
  }

  return { checked: allPhotos.length, removed };
}

export function stopScanning(): void {
  isScanning = false;
  wasCancelled = true;
}
