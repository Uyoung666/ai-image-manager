import fs from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import sharp from "sharp";
import exifr from "exifr";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photos, exifData } from "@/db/schema";
import { generateThumbnail } from "./thumbnailer";

const SUPPORTED_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".webp", ".avif",
  ".tiff", ".tif", ".heic", ".heif", ".gif",
  ".bmp", ".ico",
]);

const SKIP_PATTERNS = [/node_modules/, /\.git/, /\.thumbnails/, /\.cache/];

interface IndexProgress {
  scanned: number;
  total: number;
  phase: "scanning" | "indexing" | "complete";
  currentFile: string;
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
  if (!SUPPORTED_EXTENSIONS.has(ext)) return false;

  for (const pattern of SKIP_PATTERNS) {
    if (pattern.test(filePath)) return false;
  }

  return true;
}

async function readBasicMeta(filePath: string): Promise<{
  width: number; height: number; format: string;
  colorSpace: string; hasAlpha: boolean;
} | null> {
  try {
    const meta = await sharp(filePath).metadata();
    return {
      width: meta.width || 0,
      height: meta.height || 0,
      format: meta.format || "",
      colorSpace: meta.space || "",
      hasAlpha: meta.hasAlpha || false,
    };
  } catch {
    return null;
  }
}

async function readExif(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return await exifr.parse(filePath, {
      pick: [
        "Make", "Model", "LensMake", "LensModel",
        "FocalLength", "FocalLengthIn35mmFormat",
        "FNumber", "ExposureTime", "ISO",
        "ExposureCompensation",
        "DateTimeOriginal", "DateTimeDigitized",
        "Flash", "Orientation",
        "GPSLatitude", "GPSLongitude", "GPSAltitude",
        "Software", "ImageDescription",
        "Artist", "Copyright",
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

  // Check if already indexed
  const existing = db.select({ id: photos.id }).from(photos).where(eq(photos.path, filePath)).get();
  if (existing) return existing.id;

  const stat = fs.statSync(filePath);
  const meta = await readBasicMeta(filePath);
  if (!meta) return null;

  // Generate thumbnail
  const thumb = await generateThumbnail(filePath, "sm");

  // Insert photo record
  const result = db.insert(photos).values({
    path: filePath,
    folderId,
    filename: path.basename(filePath),
    fileSize: stat.size,
    fileDate: Math.floor(stat.mtimeMs),
    width: meta.width,
    height: meta.height,
    format: meta.format,
    colorSpace: meta.colorSpace,
    hasAlpha: meta.hasAlpha,
    thumbnailPath: thumb.thumbnailPath,
    thumbnailSize: `${thumb.width}x${thumb.height}`,
    isIndexed: true,
  }).returning({ insertedId: photos.id }).get();

  if (!result) return null;
  const photoId = result.insertedId;

  // Extract EXIF
  const exif = await readExif(filePath);
  if (exif && Object.keys(exif).length > 0) {
    db.insert(exifData).values({
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
      dateTaken: exif.DateTimeOriginal ? new Date(exif.DateTimeOriginal as string).getTime() : null,
      dateDigitized: exif.DateTimeDigitized ? new Date(exif.DateTimeDigitized as string).getTime() : null,
      flash: exif.Flash as boolean,
      orientation: exif.Orientation as number,
      gpsLatitude: exif.GPSLatitude as number,
      gpsLongitude: exif.GPSLongitude as number,
      gpsAltitude: exif.GPSAltitude as number,
      software: exif.Software as string,
      imageDescription: exif.ImageDescription as string,
      artist: exif.Artist as string,
      copyright: exif.Copyright as string,
      rawJson: JSON.stringify(exif),
    }).run();
  }

  return photoId;
}

export async function scanFolder(
  folderPath: string,
  onProgress?: ProgressCallback
): Promise<{ folderId: number; photoIds: number[] }> {
  const db = getDatabase();
  isScanning = true;

  const resolvedPath = path.resolve(folderPath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Folder does not exist: ${resolvedPath}`);
  }

  // Create or get folder record
  let folder = db.select().from(folders).where(eq(folders.path, resolvedPath)).get();
  if (!folder) {
    const result = db.insert(folders).values({
      path: resolvedPath,
      displayName: path.basename(resolvedPath),
    }).returning({ insertedId: folders.id }).get();
    folder = { id: result!.insertedId, path: resolvedPath, displayName: path.basename(resolvedPath), photoCount: 0, lastScannedAt: null, createdAt: Date.now() };
  }

  // Walk directory
  const files: string[] = [];
  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile() && shouldIndex(fullPath)) {
        files.push(fullPath);
      }
    }
  }
  walk(resolvedPath);

  // Index each file
  const photoIds: number[] = [];
  let scanned = 0;

  for (const file of files) {
    if (!isScanning) break;

    onProgress?.({
      scanned,
      total: files.length,
      phase: "indexing",
      currentFile: file,
    });

    try {
      const photoId = await indexSingleFile(file, folder.id);
      if (photoId) photoIds.push(photoId);
    } catch (error) {
      console.error(`[Indexer] Error indexing ${file}:`, error);
    }

    scanned++;
  }

  // Update folder metadata
  db.update(folders)
    .set({ photoCount: photoIds.length, lastScannedAt: Date.now() })
    .where(eq(folders.id, folder.id))
    .run();

  onProgress?.({
    scanned: files.length,
    total: files.length,
    phase: "complete",
    currentFile: "",
  });

  isScanning = false;
  return { folderId: folder.id, photoIds };
}

export function startWatching(onChange: (photoId: number | null, event: "add" | "remove") => void): void {
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
      if (!shouldIndex(filePath)) return;
      try {
        const photoId = await indexSingleFile(filePath, null);
        onChange(photoId, "add");
      } catch { /* ignore */ }
    });

    watcher.on("unlink", (filePath) => {
      const photo = db.select({ id: photos.id }).from(photos).where(eq(photos.path, filePath)).get();
      if (photo) {
        db.delete(photos).where(eq(photos.id, photo.id)).run();
        onChange(photo.id, "remove");
      }
    });

    watchers.push(watcher);
  }
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
