import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { appSettings, exifData, photos, photoTags, tags } from "@/db/schema";
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
  return {
    enabled: false,
    text: "",
    imagePath: "",
    mode: "text",
    anchor: "bottomRight",
    margin: 5,
    opacity: 50,
    fontSize: 24,
    imageScale: 15,
  };
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

// Export photos as ZIP with HTML gallery
const ExportSchema = z.object({
  ids: z
    .array(z.number().int().positive().max(2_147_483_646))
    .min(1)
    .max(50_000),
  format: z.enum(["original", "compressed"]).default("original"),
  maxWidth: z.number().optional().default(1920),
  quality: z.number().min(10).max(100).optional().default(85),
  outputPath: z.string().optional(),
  locale: z.string().optional().default("zh-CN"),
});

const EXPORT_DB_BATCH_SIZE = 250;
const EXPORT_YIELD_INTERVAL = 8;

export function sanitizeExportFilename(filename: string): string {
  const baseName = path.posix.basename(filename.replaceAll("\\", "/"));
  const sanitized = baseName
    .replace(/[<>:"/|?*]/g, "_")
    .split("")
    .filter((character) => character.charCodeAt(0) >= 32)
    .join("")
    .replace(/[. ]+$/g, "")
    .trim();
  if (!sanitized || sanitized === "." || sanitized === "..") {
    return "photo";
  }
  return sanitized;
}

export function allocateExportFilename(
  filename: string,
  format: "original" | "compressed",
  usedNames: Set<string>
): string {
  const safeName = sanitizeExportFilename(filename);
  const extension = format === "compressed" ? ".jpg" : path.extname(safeName);
  const baseName = path.basename(
    safeName,
    format === "compressed" ? path.extname(safeName) : extension
  );
  const normalizedBase = baseName || "photo";
  let candidate = `${normalizedBase}${extension}`;
  let counter = 1;
  while (usedNames.has(candidate.toLowerCase())) {
    candidate = `${normalizedBase}_${counter}${extension}`;
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
  const rootWithSeparator = `${root}${path.sep}`;
  if (!(resolved.startsWith(rootWithSeparator) && resolved !== root)) {
    throw new Error("Export filename resolves outside the export directory");
  }
  return resolved;
}

export function resolveExportOutputPath(outputPath?: string): string {
  const requestedPath =
    outputPath?.trim() ||
    path.join(
      nodeOs.tmpdir(),
      `gallery-${new Date().toISOString().slice(0, 10)}.zip`
    );
  if (requestedPath.includes("\u0000")) {
    throw new Error("Invalid export output path");
  }
  const resolved = path.resolve(requestedPath);
  if (fs.existsSync(resolved) && fs.statSync(resolved).isDirectory()) {
    throw new Error("Export output path must be a file");
  }
  return resolved;
}

function throwIfExportAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("Export cancelled");
  }
}

export const exportPhotos = os
  .input(ExportSchema)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Export orchestration preserves the existing per-photo and cleanup flow.
  .handler(async ({ input, signal }) => {
    const db = getDatabase();
    const { ids, format, maxWidth, quality, outputPath, locale } = input;
    const uniqueIds = [...new Set(ids)];

    // Read watermark settings from appSettings
    let wm: {
      enabled: boolean;
      text: string;
      imagePath?: string;
      mode: "text" | "image";
      anchor: string;
      margin: number;
      opacity: number;
      fontSize: number;
      imageScale: number;
    } = {
      enabled: false,
      text: "",
      imagePath: undefined,
      mode: "text",
      anchor: "bottomRight",
      margin: 5,
      opacity: 50,
      fontSize: 24,
      imageScale: 15,
    };
    try {
      const wmRow = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "watermark_settings"))
        .get();
      if (wmRow) {
        const parsed = JSON.parse(wmRow.value) as Partial<typeof wm>;
        let mode: "image" | "text" = "text";
        if (parsed.mode === "image" || parsed.mode === "text") {
          mode = parsed.mode;
        } else if (parsed.imagePath) {
          mode = "image";
        }
        wm = {
          ...wm,
          ...parsed,
          mode,
        };
      }
    } catch {
      /* use defaults */
    }

    // Prepare temp directory
    const tmpDir = fs.mkdtempSync(
      path.join(nodeOs.tmpdir(), "ai-image-gallery-")
    );
    const photosDir = path.join(tmpDir, "photos");
    fs.mkdirSync(photosDir, { recursive: true });

    const galleryPhotos: Array<{
      filename: string;
      width: number;
      height: number;
      tags: string[];
      exif: {
        camera?: string;
        lens?: string;
        focalLength?: string;
        aperture?: string;
        shutter?: string;
        iso?: number;
        dateTaken?: string;
      } | null;
    }> = [];

    // Calculate watermark pixel position from anchor + margin.
    // Margin is % of short edge — consistent visual gap across aspect ratios.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Anchor mapping handles all supported watermark positions.
    function wmAnchorPos(
      anchor: string,
      margin: number,
      imgW: number,
      imgH: number,
      wmW: number,
      wmH: number
    ): { left: number; top: number } {
      const mp = Math.round((margin / 100) * Math.min(imgW, imgH));
      let h: "left" | "center" | "right";
      let v: "top" | "center" | "bottom";
      if (anchor === "topLeft") {
        h = "left";
        v = "top";
      } else if (anchor === "topCenter") {
        h = "center";
        v = "top";
      } else if (anchor === "topRight") {
        h = "right";
        v = "top";
      } else if (anchor === "centerLeft") {
        h = "left";
        v = "center";
      } else if (anchor === "center") {
        h = "center";
        v = "center";
      } else if (anchor === "centerRight") {
        h = "right";
        v = "center";
      } else if (anchor === "bottomLeft") {
        h = "left";
        v = "bottom";
      } else if (anchor === "bottomCenter") {
        h = "center";
        v = "bottom";
      } else {
        h = "right";
        v = "bottom";
      }

      let left: number;
      if (h === "left") {
        left = mp;
      } else if (h === "right") {
        left = imgW - wmW - mp;
      } else {
        left = Math.round((imgW - wmW) / 2);
      }

      let top: number;
      if (v === "top") {
        top = mp;
      } else if (v === "bottom") {
        top = imgH - wmH - mp;
      } else {
        top = Math.round((imgH - wmH) / 2);
      }

      return { left: Math.max(0, left), top: Math.max(0, top) };
    }

    // Build watermark SVG overlay once.
    // Positions text by anchor point + text-anchor alignment — no width estimation.
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: SVG construction validates and escapes the persisted watermark settings.
    function buildWatermarkSvg(
      imgWidth: number,
      imgHeight: number
    ): Buffer | null {
      if (!(wm.enabled && wm.text.trim())) {
        return null;
      }

      const opacity = wm.opacity / 100;
      const fontSize = wm.fontSize;
      const anchor = wm.anchor || "bottomRight";
      const margin = wm.margin ?? 5;
      const mp = Math.round((margin / 100) * Math.min(imgWidth, imgHeight));

      // Resolve anchor to pixel point + text alignment
      let h: "left" | "center" | "right";
      let v: "top" | "center" | "bottom";
      if (anchor === "topLeft") {
        h = "left";
        v = "top";
      } else if (anchor === "topCenter") {
        h = "center";
        v = "top";
      } else if (anchor === "topRight") {
        h = "right";
        v = "top";
      } else if (anchor === "centerLeft") {
        h = "left";
        v = "center";
      } else if (anchor === "center") {
        h = "center";
        v = "center";
      } else if (anchor === "centerRight") {
        h = "right";
        v = "center";
      } else if (anchor === "bottomLeft") {
        h = "left";
        v = "bottom";
      } else if (anchor === "bottomCenter") {
        h = "center";
        v = "bottom";
      } else {
        h = "right";
        v = "bottom";
      }

      let x: number;
      if (h === "left") {
        x = mp;
      } else if (h === "right") {
        x = imgWidth - mp;
      } else {
        x = Math.round(imgWidth / 2);
      }

      let y: number;
      if (v === "top") {
        y = mp + fontSize;
      } else if (v === "bottom") {
        y = imgHeight - mp;
      } else {
        y = Math.round(imgHeight / 2);
      }

      let textAnchor: "start" | "end" | "middle";
      if (h === "left") {
        textAnchor = "start";
      } else if (h === "right") {
        textAnchor = "end";
      } else {
        textAnchor = "middle";
      }

      let baseline: "hanging" | "baseline" | "middle";
      if (v === "top") {
        baseline = "hanging";
      } else if (v === "bottom") {
        baseline = "baseline";
      } else {
        baseline = "middle";
      }

      const escaped = wm.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

      const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="${opacity}" text-anchor="${textAnchor}" dominant-baseline="${baseline}">${escaped}</text>
</svg>`;
      return Buffer.from(svg, "utf-8");
    }

    try {
      const sharp =
        format === "compressed" || wm.enabled
          ? (await import("sharp")).default
          : null;

      const usedNames = new Set<string>();
      let exportedPhotoCount = 0;
      for (
        let idOffset = 0;
        idOffset < uniqueIds.length;
        idOffset += EXPORT_DB_BATCH_SIZE
      ) {
        throwIfExportAborted(signal);
        const photoList = db
          .select()
          .from(photos)
          .where(
            inArray(
              photos.id,
              uniqueIds.slice(idOffset, idOffset + EXPORT_DB_BATCH_SIZE)
            )
          )
          .all();

        for (const photo of photoList) {
          throwIfExportAborted(signal);
          const destName = allocateExportFilename(
            photo.filename,
            format,
            usedNames
          );
          const destPath = resolveExportChildPath(photosDir, destName);

          if (sharp && (format === "compressed" || wm.enabled)) {
            try {
              let pipeline = sharp(photo.path).rotate();
              const meta = await pipeline.metadata();
              const imgWidth = meta.width || photo.width || 0;
              const imgHeight = meta.height || photo.height || 0;

              if (format === "compressed" && imgWidth > maxWidth) {
                pipeline = pipeline.resize(maxWidth);
              }

              let outWidth = imgWidth;
              let outHeight = imgHeight;
              if (format === "compressed" && imgWidth > maxWidth) {
                outWidth = maxWidth;
                outHeight = Math.round(maxWidth * (imgHeight / imgWidth));
              }

              // Apply the selected image watermark mode
              if (
                wm.enabled &&
                wm.mode === "image" &&
                wm.imagePath &&
                fs.existsSync(wm.imagePath) &&
                outWidth > 0 &&
                outHeight > 0
              ) {
                const maxDim = Math.round(
                  Math.min(outWidth, outHeight) * (wm.imageScale / 100)
                );
                const wmResized = sharp(wm.imagePath)
                  .resize(maxDim, maxDim, { fit: "inside" })
                  .ensureAlpha();
                const wmMeta = await wmResized.metadata();
                const wmW = wmMeta.width || maxDim;
                const wmH = wmMeta.height || maxDim;
                const wmBuffer = await wmResized.png().toBuffer();
                const { left, top } = wmAnchorPos(
                  wm.anchor || "bottomRight",
                  wm.margin ?? 5,
                  outWidth,
                  outHeight,
                  wmW,
                  wmH
                );
                pipeline = pipeline.composite([{ input: wmBuffer, top, left }]);
              } else if (
                wm.enabled &&
                wm.mode === "text" &&
                wm.text.trim() &&
                outWidth > 0 &&
                outHeight > 0
              ) {
                // Text watermark SVG
                const wmSvg = buildWatermarkSvg(outWidth, outHeight);
                if (wmSvg) {
                  pipeline = pipeline.composite([
                    { input: wmSvg, top: 0, left: 0 },
                  ]);
                }
              }

              if (format === "compressed") {
                const buffer = await pipeline.jpeg({ quality }).toBuffer();
                fs.writeFileSync(destPath, buffer);
              } else if (wm.enabled) {
                // Watermark in original format: preserve source format
                const srcFormat = (meta.format || "").toLowerCase();
                if (srcFormat === "jpeg" || srcFormat === "jpg") {
                  const buffer = await pipeline
                    .jpeg({ quality: 92 })
                    .toBuffer();
                  fs.writeFileSync(destPath, buffer);
                } else if (srcFormat === "webp") {
                  const buffer = await pipeline
                    .webp({ quality: 92 })
                    .toBuffer();
                  fs.writeFileSync(destPath, buffer);
                } else {
                  const buffer = await pipeline.png().toBuffer();
                  fs.writeFileSync(destPath, buffer);
                }
              }
            } catch {
              // Fallback: copy original on sharp failure
              fs.copyFileSync(photo.path, destPath);
            }
          } else {
            fs.copyFileSync(photo.path, destPath);
          }

          // Gather tags
          const photoTagRows = db
            .select({ name: tags.name })
            .from(photoTags)
            .innerJoin(tags, eq(photoTags.tagId, tags.id))
            .where(eq(photoTags.photoId, photo.id))
            .all();
          const tagNames = photoTagRows.map((t) => t.name);

          // Gather EXIF
          const exif = db
            .select()
            .from(exifData)
            .where(eq(exifData.photoId, photo.id))
            .get();

          galleryPhotos.push({
            filename: destName,
            width: photo.width ?? 0,
            height: photo.height ?? 0,
            tags: tagNames,
            exif: exif
              ? {
                  camera: exif.cameraModel ?? undefined,
                  lens: exif.lensModel ?? undefined,
                  focalLength: exif.focalLength?.toString(),
                  aperture: exif.aperture?.toString(),
                  shutter: exif.shutterSpeed ?? undefined,
                  iso: exif.iso ?? undefined,
                  dateTaken: exif.dateTaken
                    ? new Date(exif.dateTaken).toLocaleDateString(locale)
                    : undefined,
                }
              : null,
          });
          exportedPhotoCount++;
          if (exportedPhotoCount % EXPORT_YIELD_INTERVAL === 0) {
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
        }
      }

      if (exportedPhotoCount === 0) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
        return { success: false, error: "No photos found" };
      }

      // Generate HTML gallery
      const html = buildHtmlGallery(galleryPhotos, locale);
      fs.writeFileSync(path.join(tmpDir, "index.html"), html, "utf-8");

      throwIfExportAborted(signal);
      const zipPath = resolveExportOutputPath(outputPath);

      // archiver 8 exposes archive constructors instead of the legacy
      // default factory function.
      const { ZipArchive } = (await import("archiver")) as unknown as {
        ZipArchive: new (options: {
          zlib: { level: number };
        }) => {
          abort: () => void;
          directory: (source: string, destination: false) => void;
          finalize: () => Promise<void>;
          on: (event: string, listener: (...args: unknown[]) => void) => void;
          pipe: (destination: NodeJS.WritableStream) => void;
        };
      };
      const archive = new ZipArchive({ zlib: { level: 9 } });
      const output = fs.createWriteStream(zipPath);

      await new Promise<void>((resolve, reject) => {
        const onAbort = () => {
          archive.abort();
          output.destroy(new Error("Export cancelled"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
        output.on("close", () => resolve());
        output.on("error", reject);
        archive.on("error", reject);
        archive.pipe(output);
        archive.directory(tmpDir, false);
        archive.finalize().catch(reject);
        if (signal?.aborted) {
          onAbort();
        }
        output.once("close", () => {
          signal?.removeEventListener("abort", onAbort);
        });
      });

      // Cleanup temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });

      const sizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
      return {
        success: true,
        path: zipPath,
        filename: path.basename(zipPath),
        photoCount: exportedPhotoCount,
        sizeMB: Number.parseFloat(sizeMB),
      };
    } catch (e) {
      // Cleanup on error
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return {
        success: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
