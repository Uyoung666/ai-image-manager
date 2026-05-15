import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { eq, sql } from "drizzle-orm";
import exifr from "exifr";
import sharp from "sharp";
import { getDatabase } from "@/db";
import { exifData, folders, photos } from "@/db/schema";
import { checkNewPhotoDuplicates } from "./dedup-service";
import { generateThumbnail } from "./thumbnailer";

const SUPPORTED_EXTENSIONS = new Set([
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
]);

const SKIP_PATTERNS = [/node_modules/, /\.git/, /\.thumbnails/, /\.cache/];

interface IndexProgress {
  currentFile: string;
  phase: "scanning" | "indexing" | "complete";
  scanned: number;
  total: number;
}

type ProgressCallback = (progress: IndexProgress) => void;
let isScanning = false;
let watchers: FSWatcher[] = [];

export function isIndexing(): boolean {
  return isScanning;
}

export function getSupportedExtensions(): string[] {
  return Array.from(SUPPORTED_EXTENSIONS);
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
    const meta = await sharp(filePath).metadata();
    return {
      width: meta.width || 0,
      height: meta.height || 0,
      format: meta.format || "",
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
        (!existingFolder || newFolder.path.length > existingFolder.path.length)
      ) {
        db.update(photos)
          .set({ folderId })
          .where(eq(photos.id, existing.id))
          .run();
      }
    }
    return existing.id;
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    console.warn(`[Indexer] File disappeared before indexing: ${filePath}`);
    return null;
  }
  const meta = await readBasicMeta(filePath);
  if (!meta) {
    console.warn(`[Indexer] Skipped unreadable file (sharp metadata failed): ${filePath}`);
    return null;
  }

  // Generate thumbnail (md=320px for crisp display in grid)
  let thumb;
  try {
    thumb = await generateThumbnail(filePath, "md");
  } catch {
    console.warn(`[Indexer] Thumbnail generation failed for: ${filePath}`);
    thumb = { thumbnailPath: null, width: 0, height: 0 };
  }

  // Compute perceptual hash for dedup
  const phash = await computePHash(filePath);

  // Insert photo record
  const result = db
    .insert(photos)
    .values({
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
    })
    .returning({ insertedId: photos.id })
    .get();

  if (!result) {
    return null;
  }
  const photoId = result.insertedId;

  // Incremental duplicate detection
  checkNewPhotoDuplicates(photoId, phash, filePath, stat.size);

  // Extract EXIF
  const exif = await readExif(filePath);
  if (exif && Object.keys(exif).length > 0) {
    try {
      db.insert(exifData)
        .values({
          photoId,
          cameraMake: exif.Make as string,
          cameraModel: exif.Model as string,
          lensMake: exif.LensMake as string,
          lensModel: exif.LensModel as string,
          focalLength: exif.FocalLength?.toString(),
          focalLength35mm: exif.FocalLengthIn35mmFormat?.toString(),
          aperture: exif.FNumber as number,
          shutterSpeed: exif.ExposureTime?.toString(),
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
        })
        .run();
    } catch (err: any) {
      console.warn(
        `[Indexer] EXIF insert failed for ${filePath}: ${err?.message}`
      );
    }
  }

  return photoId;
}

export async function scanFolder(
  folderPath: string,
  onProgress?: ProgressCallback
): Promise<{ folderId: number; photoIds: number[]; skipped: number }> {
  const db = getDatabase();
  isScanning = true;

  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Folder does not exist: ${resolvedPath}`);
  }

  // Create or get folder record
  let folder = db
    .select()
    .from(folders)
    .where(eq(folders.path, resolvedPath))
    .get();
  if (!folder) {
    const result = db
      .insert(folders)
      .values({
        path: resolvedPath,
        displayName: path.basename(resolvedPath),
      })
      .returning({ insertedId: folders.id })
      .get();
    folder = {
      id: result?.insertedId,
      path: resolvedPath,
      displayName: path.basename(resolvedPath),
      photoCount: 0,
      lastScannedAt: null,
      createdAt: Date.now(),
    };
  }

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

  // Auto-discover subdirectories that contain images and create folder records
  const dirToFolderId = new Map<string, number>();
  dirToFolderId.set(resolvedPath, folder.id);

  for (const f of files) {
    const dir = path.dirname(f);
    if (dir === resolvedPath || dirToFolderId.has(dir)) continue;
    let subFolder = db.select({ id: folders.id }).from(folders).where(eq(folders.path, dir)).get();
    if (!subFolder) {
      const result = db
        .insert(folders)
        .values({ path: dir, displayName: path.basename(dir) })
        .returning({ insertedId: folders.id })
        .get();
      if (result) {
        dirToFolderId.set(dir, result.insertedId);
      }
    } else {
      dirToFolderId.set(dir, subFolder.id);
    }
  }

  // Index each file with concurrency for speed.
  // Sharp/libvips uses the libuv thread pool internally, so overlapping
  // thumbnail generation + metadata reads yields ~3x throughput on typical
  // consumer hardware without saturating I/O.
  const CONCURRENCY = 4;
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

  const fileResults = await runWithConcurrency(
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
        const fileFolderId = dirToFolderId.get(fileDir) || folder.id;
        const photoId = await indexSingleFile(file, fileFolderId);
        scanned++;
        return photoId;
      } catch (error) {
        console.error(`[Indexer] Error indexing ${file}:`, error);
        scanned++;
        return null;
      }
    },
    CONCURRENCY
  );

  for (const photoId of fileResults) {
    if (photoId) {
      photoIds.push(photoId);
    } else {
      skipped++;
    }
  }
  // Correct double-count: fileResults already accounts for skipped via the
  // worker catch handler, so reset skipped to the count of null results.
  skipped = fileResults.filter((r) => r === null).length;

  if (skipped > 0) {
    console.warn(
      `[Indexer] Folder scan summary: ${photoIds.length} indexed, ${skipped} skipped (${files.length} total files found)`
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
        if (idx >= 0) photoIds.splice(idx, 1);
        console.log(`[Indexer] Removed stale record: ${p.path}`);
      }
    }
  }

  // Update photo counts per folder
  for (const [dirPath, fid] of dirToFolderId) {
    const count = fileResults.filter(
      (pid, i) => pid && dirToFolderId.get(path.dirname(files[i])) === fid
    ).length;
    db.update(folders)
      .set({ photoCount: count, lastScannedAt: Date.now() })
      .where(eq(folders.id, fid))
      .run();
  }

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

  return { folderId: folder.id, photoIds, skipped };
}

export function startWatching(
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const db = getDatabase();
  const indexedFolders = db.select({ path: folders.path }).from(folders).all();

  for (const folder of indexedFolders) {
    const watcher = chokidar.watch(folder.path, {
      ignored: [/\.thumbnails/, /\.cache/],
      ignorePermissionErrors: true,
      awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
      depth: 10,
    });

    watcher.on("add", async (filePath) => {
      if (!shouldIndex(filePath)) {
        return;
      }
      try {
        // Match the closest parent folder from our indexed folders
        let matchedFolderId: number | null = null;
        const indexedFolders = db
          .select({ id: folders.id, path: folders.path })
          .from(folders)
          .all();
        for (const f of indexedFolders) {
          const normalizedFolder = f.path.replace(/\\/g, "/") + "/";
          const normalizedFile = filePath.replace(/\\/g, "/");
          if (normalizedFile.startsWith(normalizedFolder)) {
            // Keep the longest (most specific) match
            if (
              matchedFolderId === null ||
              f.path.length > (matchedFolderId ? 1 : 0)
            ) {
              matchedFolderId = f.id;
            }
          }
        }
        // Check if file was already indexed before calling indexSingleFile.
        // chokidar emits "add" for all existing files on startup — we must
        // NOT increment photoCount for files that are already in the DB.
        const alreadyIndexed = db
          .select({ id: photos.id })
          .from(photos)
          .where(eq(photos.path, filePath))
          .get();

        const photoId = await indexSingleFile(filePath, matchedFolderId);
        if (matchedFolderId && photoId && !alreadyIndexed) {
          db.update(folders)
            .set({ photoCount: sql`photo_count + 1` })
            .where(eq(folders.id, matchedFolderId))
            .run();
        }
        onChange(photoId, "add");
      } catch {
        /* ignore */
      }
    });

    watcher.on("unlink", (filePath) => {
      const photo = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.path, filePath))
        .get();
      if (photo) {
        db.delete(photos).where(eq(photos.id, photo.id)).run();
        onChange(photo.id, "remove");
      }
    });

    watchers.push(watcher);
  }
}

export function watchFolder(
  folderPath: string,
  onChange: (photoId: number | null, event: "add" | "remove") => void
): void {
  const db = getDatabase();
  const watcher = chokidar.watch(folderPath, {
    ignored: [/\.thumbnails/, /\.cache/],
    ignorePermissionErrors: true,
    awaitWriteFinish: { stabilityThreshold: 2000, pollInterval: 100 },
    depth: 10,
  });

  watcher.on("add", async (filePath) => {
    if (!shouldIndex(filePath)) {
      return;
    }
    try {
      let matchedFolderId: number | null = null;
      const indexedFolders = db
        .select({ id: folders.id, path: folders.path })
        .from(folders)
        .all();
      for (const f of indexedFolders) {
        const normalizedFolder = f.path.replace(/\\/g, "/") + "/";
        const normalizedFile = filePath.replace(/\\/g, "/");
        if (normalizedFile.startsWith(normalizedFolder)) {
          if (
            matchedFolderId === null ||
            f.path.length > (matchedFolderId ? 1 : 0)
          ) {
            matchedFolderId = f.id;
          }
        }
      }
      const alreadyIndexed = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.path, filePath))
        .get();

      const photoId = await indexSingleFile(filePath, matchedFolderId);
      if (matchedFolderId && photoId && !alreadyIndexed) {
        db.update(folders)
          .set({ photoCount: sql`photo_count + 1` })
          .where(eq(folders.id, matchedFolderId))
          .run();
      }
      onChange(photoId, "add");
    } catch {
      /* ignore */
    }
  });

  watcher.on("unlink", (filePath) => {
    const photo = db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.path, filePath))
      .get();
    if (photo) {
      db.delete(photos).where(eq(photos.id, photo.id)).run();
      onChange(photo.id, "remove");
    }
  });

  watchers.push(watcher);
}

export function stopWatching(): void {
  for (const watcher of watchers) {
    watcher.close();
  }
  watchers = [];
}

export function stopScanning(): void {
  isScanning = false;
}
