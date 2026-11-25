import { randomUUID } from "node:crypto";
import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { os } from "@orpc/server";
import type archiver from "archiver";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { appSettings } from "@/db/schema";
import { assertLibraryFileReady } from "@/services/library-file-guard";
import {
  type DeliveryPhoto,
  deliveryLocale,
  deliveryMetadata,
  deliveryPhotos,
  deliverySequence,
} from "@/services/photo-delivery";
import { renderDeliveryJpeg } from "@/services/photo-delivery-jpeg";
import {
  DEFAULT_DELIVERY_DISCLOSURE,
  deliveryDisclosureSchema,
} from "@/types/photo-delivery";
import { buildHtmlGallery } from "./gallery-template";

// Watermark settings persistence
const WatermarkSchema = z.object({
  enabled: z.boolean(),
  text: z.string(),
  imagePath: z.string().optional(),
  mode: z.enum(["text", "image"]).optional().default("text"),
  position: z.string().optional(), // legacy
  anchor: z.string().optional().default("bottomRight"),
  margin: z.number().min(2).max(15).optional().default(5),
  opacity: z.number().min(10).max(100),
  fontSize: z.number().min(12).max(72),
  imageScale: z.number().min(5).max(50).optional().default(15),
  wmX: z.number().optional(),
  wmY: z.number().optional(),
});

const WM_KEY = "watermark_settings";
const DEFAULT_WATERMARK = {
  enabled: false,
  text: "",
  imagePath: "",
  mode: "text" as const,
  anchor: "bottomRight",
  margin: 5,
  opacity: 50,
  fontSize: 24,
  imageScale: 15,
};

export const getWatermarkSettings = os.handler(() => {
  const db = getDatabase();
  const row = db
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, WM_KEY))
    .get();
  if (row) {
    try {
      return JSON.parse(row.value);
    } catch {
      /* fall through */
    }
  }
  return DEFAULT_WATERMARK;
});

export const setWatermarkSettings = os
  .input(WatermarkSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const value = JSON.stringify(input);
    db.insert(appSettings)
      .values({ key: WM_KEY, value, updatedAt: Date.now() })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value, updatedAt: Date.now() },
      })
      .run();
    return { ok: true };
  });

const ExportSchema = z.object({
  ids: z
    .array(z.number().int().positive().max(2_147_483_646))
    .min(1)
    .max(100_000),
  format: z.enum(["original", "compressed"]).default("original"),
  maxWidth: z.number().int().min(1).max(32_768).nullable().default(1920),
  quality: z.number().int().min(10).max(100).default(85),
  applyWatermark: z.boolean().optional(),
  disclosure: deliveryDisclosureSchema.optional(),
  outputPath: z.string().optional(),
  locale: z.string().default("zh-CN"),
});

const WINDOWS_DEVICE_NAME =
  /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu;

export function sanitizeExportFilename(filename: string): string {
  const baseName = path.posix.basename(filename.replaceAll("\\", "/"));
  const sanitized = baseName
    .replace(/[<>:"/|?*]/g, "_")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized) {
    return "photo";
  }
  return WINDOWS_DEVICE_NAME.test(sanitized) ? `_${sanitized}` : sanitized;
}

export function allocateExportFilename(
  filename: string,
  format: "original" | "compressed",
  usedNames: Set<string>
): string {
  const safeName = sanitizeExportFilename(filename);
  const sourceExtension = path.extname(safeName);
  const extension = format === "compressed" ? ".jpg" : sourceExtension;
  const baseName =
    path.basename(safeName, sourceExtension).replace(/[. ]+$/g, "") || "photo";
  let candidate = `${baseName}${extension}`;
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${baseName}_${counter}${extension}`;
    counter++;
  }
  usedNames.add(candidate.toLowerCase());
  return candidate;
}

export function resolveExportChildPath(
  directory: string,
  filename: string
): string {
  const root = path.resolve(directory);
  const resolved = path.resolve(root, filename);
  if (path.dirname(resolved) !== root) {
    throw new Error("Export filename resolves outside the export directory");
  }
  return resolved;
}

export function resolveExportOutputPath(outputPath?: string): string {
  const resolved = path.resolve(
    outputPath?.trim() ||
      path.join(nodeOs.tmpdir(), `gallery-${randomUUID()}.zip`)
  );
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new Error("Export output path must be a file");
  }
  if (
    resolved.includes("\u0000") ||
    path.extname(resolved).toLowerCase() !== ".zip"
  ) {
    throw new Error("Export output path must end in .zip");
  }
  return resolved;
}

function readExportWatermark(requested: boolean | undefined) {
  if (requested === false) {
    return undefined;
  }
  const row = getDatabase()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, WM_KEY))
    .get();
  const stored = row ? JSON.parse(row.value) : {};
  if (requested !== true && !stored.enabled) {
    return undefined;
  }
  return WatermarkSchema.parse({
    ...DEFAULT_WATERMARK,
    ...stored,
    mode: stored.mode ?? (stored.imagePath ? "image" : "text"),
  });
}

type GalleryPhoto = Parameters<typeof buildHtmlGallery>[0][number];
type ExportInput = z.output<typeof ExportSchema>;

interface ArchivePhoto {
  filename: string;
  gallery: GalleryPhoto;
  original?: { photo: DeliveryPhoto; stat: fs.Stats };
  source: string;
}

async function prepareArchivePhoto(
  photo: DeliveryPhoto,
  index: number,
  input: ExportInput,
  usedNames: Set<string>,
  stage: string,
  watermark: z.output<typeof WatermarkSchema> | undefined
): Promise<ArchivePhoto> {
  const stat = assertLibraryFileReady(photo);
  const original = input.format === "original";
  const disclosure = input.disclosure ?? DEFAULT_DELIVERY_DISCLOSURE;
  const requestedName =
    original || disclosure.filenames ? photo.filename : deliverySequence(index);
  const filename = allocateExportFilename(
    requestedName,
    input.format,
    usedNames
  );
  const source = original
    ? photo.path
    : resolveExportChildPath(stage, `${deliverySequence(index)}.jpg`);
  const dimensions = original
    ? { width: photo.width ?? 0, height: photo.height ?? 0 }
    : await renderDeliveryJpeg(
        photo.path,
        source,
        input.maxWidth,
        input.quality,
        watermark
      );
  if (!original) {
    assertUnchangedSource(photo, stat);
  }
  const metadata = deliveryMetadata(
    photo,
    disclosure,
    deliveryLocale(input.locale)
  );
  return {
    filename,
    source,
    gallery: { filename, ...dimensions, ...metadata },
    original: original ? { photo, stat } : undefined,
  };
}

async function writeArchive(
  entries: ArchivePhoto[],
  outputPath: string,
  html: string,
  signal?: AbortSignal
): Promise<void> {
  // Archiver 8 exports the constructor, while the bundled types target v7.
  const { ZipArchive } = (await import("archiver")) as unknown as {
    ZipArchive: new (options: { zlib: { level: number } }) => archiver.Archiver;
  };
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const output = fs.createWriteStream(outputPath, { flags: "wx" });
  const written = pipeline(archive, output, { signal });
  const zipEpoch = new Date(1980, 0, 1);
  archive.on("warning", (error) => archive.destroy(error));
  try {
    for (const entry of entries) {
      const metadata: archiver.ZipEntryData = {
        name: `photos/${entry.filename}`,
        date: entry.original?.stat.mtime ?? zipEpoch,
        store: !entry.original,
      };
      archive.file(entry.source, metadata);
    }
    archive.append(html, { name: "index.html", date: zipEpoch, store: false });
    await Promise.all([archive.finalize(), written]);
  } catch (error) {
    archive.abort();
    archive.destroy();
    await written.catch(() => undefined);
    throw error;
  }
}

function assertUnchangedSource(photo: DeliveryPhoto, stat: fs.Stats): void {
  const current = assertLibraryFileReady(photo);
  if (
    current.size !== stat.size ||
    current.mtimeMs !== stat.mtimeMs ||
    current.ctimeMs !== stat.ctimeMs ||
    current.ino !== stat.ino
  ) {
    throw new Error("LIBRARY_SOURCE_CHANGED");
  }
}

function checkArchivedOriginal(entry: ArchivePhoto): void {
  if (entry.original) {
    const { photo, stat } = entry.original;
    try {
      assertUnchangedSource(photo, stat);
    } catch (error) {
      throw photoExportError(photo.filename, error);
    }
  }
}

function photoExportError(filename: string, error: unknown): Error {
  const reason = error instanceof Error ? error.message : String(error);
  return new Error(`${filename}: ${reason}`, { cause: error });
}

export const exportPhotos = os
  .input(ExportSchema)
  .handler(async ({ input, signal }) => {
    let stage: string | undefined;
    try {
      signal?.throwIfAborted();
      const zipPath = resolveExportOutputPath(input.outputPath);
      stage = await fs.promises.mkdtemp(
        path.join(path.dirname(zipPath), ".aim-export-")
      );
      const entries: ArchivePhoto[] = [];
      const usedNames = new Set<string>();
      const watermark =
        input.format === "compressed"
          ? readExportWatermark(input.applyWatermark)
          : undefined;

      for (const photo of deliveryPhotos(input.ids)) {
        signal?.throwIfAborted();
        try {
          entries.push(
            await prepareArchivePhoto(
              photo,
              entries.length,
              input,
              usedNames,
              stage,
              watermark
            )
          );
        } catch (error) {
          throw photoExportError(photo.filename, error);
        }
        if (entries.length % 8 === 0) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      }

      const html = buildHtmlGallery(
        entries.map((entry) => entry.gallery),
        input.locale
      );
      const stagedZip = resolveExportChildPath(stage, "archive.zip");
      await writeArchive(entries, stagedZip, html, signal);
      for (const entry of entries) {
        checkArchivedOriginal(entry);
      }
      const size = (await fs.promises.stat(stagedZip)).size;
      signal?.throwIfAborted();
      await fs.promises.rename(stagedZip, zipPath);
      return {
        success: true as const,
        path: zipPath,
        filename: path.basename(zipPath),
        photoCount: entries.length,
        sizeMB: Number((size / (1024 * 1024)).toFixed(1)),
      };
    } catch (error) {
      return {
        success: false as const,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      if (stage) {
        await fs.promises
          .rm(stage, { recursive: true, force: true })
          .catch((error) => {
            console.warn("Could not clean up photo export", error);
          });
      }
    }
  });
