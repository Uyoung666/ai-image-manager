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
  position: z.enum(["topLeft", "topRight", "bottomLeft", "bottomRight", "center"]),
  opacity: z.number().min(10).max(100),
  fontSize: z.number().min(12).max(72),
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
      /* fall through to default */
    }
  }
  return {
    enabled: false,
    text: "",
    position: "bottomRight",
    opacity: 50,
    fontSize: 24,
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
  ids: z.array(z.number()),
  format: z.enum(["original", "compressed"]).default("original"),
  maxWidth: z.number().optional().default(1920),
  quality: z.number().min(10).max(100).optional().default(85),
  outputPath: z.string().optional(),
});

export const exportPhotos = os
  .input(ExportSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const { ids, format, maxWidth, quality, outputPath } = input;

    // Read watermark settings from appSettings
    let wm: {
      enabled: boolean;
      text: string;
      position: string;
      opacity: number;
      fontSize: number;
    } = { enabled: false, text: "", position: "bottomRight", opacity: 50, fontSize: 24 };
    try {
      const wmRow = db
        .select({ value: appSettings.value })
        .from(appSettings)
        .where(eq(appSettings.key, "watermark_settings"))
        .get();
      if (wmRow) {
        wm = JSON.parse(wmRow.value);
      }
    } catch {
      /* use defaults */
    }

    const photoList = db
      .select()
      .from(photos)
      .where(inArray(photos.id, ids))
      .all();

    if (photoList.length === 0) {
      return { success: false, error: "No photos found" };
    }

    // Prepare temp directory
    const tmpDir = path.join(nodeOs.tmpdir(), `ai-image-gallery-${Date.now()}`);
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

    // Build watermark SVG overlay once
    function buildWatermarkSvg(imgWidth: number, imgHeight: number): Buffer | null {
      if (!(wm.enabled && wm.text.trim())) return null;
      const opacity = wm.opacity / 100;
      const fontSize = wm.fontSize;
      const margin = Math.max(16, Math.floor(Math.min(imgWidth, imgHeight) * 0.03));
      const textAnchor =
        wm.position === "topLeft" || wm.position === "bottomLeft"
          ? "start"
          : wm.position === "center"
            ? "middle"
            : "end";
      let x: number;
      if (wm.position === "topLeft" || wm.position === "bottomLeft") {
        x = margin;
      } else if (wm.position === "center") {
        x = imgWidth / 2;
      } else {
        x = imgWidth - margin;
      }
      let y: number;
      if (wm.position === "topLeft" || wm.position === "topRight") {
        y = margin + fontSize;
      } else if (wm.position === "center") {
        y = imgHeight / 2;
      } else {
        y = imgHeight - margin;
      }
      const svg = `<svg width="${imgWidth}" height="${imgHeight}" xmlns="http://www.w3.org/2000/svg">
  <text x="${x}" y="${y}" font-family="sans-serif" font-size="${fontSize}" fill="white" fill-opacity="${opacity}" text-anchor="${textAnchor}">${wm.text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>
</svg>`;
      return Buffer.from(svg, "utf-8");
    }

    try {
      const sharp =
        format === "compressed" || wm.enabled ? (await import("sharp")).default : null;

      for (const photo of photoList) {
        // Resolve filename collision
        let destName = photo.filename;
        let counter = 1;
        while (fs.existsSync(path.join(photosDir, destName))) {
          const ext = path.extname(photo.filename);
          const base = path.basename(photo.filename, ext);
          destName = `${base}_${counter}${ext}`;
          counter++;
        }

        const destPath = path.join(photosDir, destName);

        if (sharp && (format === "compressed" || wm.enabled)) {
          try {
            let pipeline = sharp(photo.path);
            const meta = await pipeline.metadata();
            const imgWidth = meta.width || photo.width || 0;
            const imgHeight = meta.height || photo.height || 0;

            if (format === "compressed" && imgWidth > maxWidth) {
              pipeline = pipeline.resize(maxWidth);
            }

            // Calculate output dimensions after potential resize
            let outWidth = imgWidth;
            let outHeight = imgHeight;
            if (format === "compressed" && imgWidth > maxWidth) {
              outWidth = maxWidth;
              outHeight = Math.round(maxWidth * (imgHeight / imgWidth));
            }

            // Apply watermark
            if (wm.enabled && wm.text.trim() && outWidth > 0 && outHeight > 0) {
              const wmSvg = buildWatermarkSvg(outWidth, outHeight);
              if (wmSvg) {
                pipeline = pipeline.composite([
                  { input: wmSvg, top: 0, left: 0 },
                ]);
              }
            }

            if (format === "compressed") {
              const buffer = await pipeline.jpeg({ quality }).toBuffer();
              destName = path.basename(destName, path.extname(destName)) + ".jpg";
              fs.writeFileSync(path.join(photosDir, destName), buffer);
            } else {
              // Watermark in original format: preserve source format
              if (wm.enabled) {
                const srcFormat = (meta.format || "").toLowerCase();
                if (srcFormat === "jpeg" || srcFormat === "jpg") {
                  const buffer = await pipeline.jpeg({ quality: 92 }).toBuffer();
                  fs.writeFileSync(destPath, buffer);
                } else if (srcFormat === "webp") {
                  const buffer = await pipeline.webp({ quality: 92 }).toBuffer();
                  fs.writeFileSync(destPath, buffer);
                } else {
                  const buffer = await pipeline.png().toBuffer();
                  fs.writeFileSync(destPath, buffer);
                }
              } else {
                const buffer = await pipeline.toBuffer();
                fs.writeFileSync(destPath, buffer);
              }
            }
          } catch {
            // Fallback: copy original on sharp failure
            fs.copyFileSync(photo.path, path.join(photosDir, destName));
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
                  ? new Date(exif.dateTaken).toLocaleDateString("zh-CN")
                  : undefined,
              }
            : null,
        });
      }

      // Generate HTML gallery
      const html = buildHtmlGallery(galleryPhotos);
      fs.writeFileSync(path.join(tmpDir, "index.html"), html, "utf-8");

      // Create ZIP — handle archiver ESM/CJS compatibility in Electron
      const { createRequire } = await import("node:module");
      const requirePath =
        typeof __filename !== "undefined"
          ? __filename
          : typeof import.meta !== "undefined" && import.meta.url
            ? import.meta.url
            : `file://${process.cwd()}/dummy.js`;
      const req = createRequire(requirePath);
      let createArchive: any;
      try {
        // Try CJS require first (most reliable in Electron main process)
        const archiverCjs = req("archiver");
        createArchive = typeof archiverCjs === "function" ? archiverCjs : archiverCjs.default;
      } catch {
        // Fallback: dynamic ESM import
        const am = await import("archiver");
        createArchive = (am as any).default || am;
      }

      const zipPath =
        outputPath ||
        path.join(
          nodeOs.tmpdir(),
          `gallery-${new Date().toISOString().slice(0, 10)}.zip`
        );

      if (typeof createArchive !== "function") {
        return { success: false, error: "archiver 模块加载失败，无法创建 ZIP 包" };
      }

      const archive = createArchive("zip", { zlib: { level: 9 } });
      const output = fs.createWriteStream(zipPath);

      await new Promise<string>((resolve, reject) => {
        output.on("close", () => resolve(zipPath));
        archive.on("error", reject);
        archive.pipe(output);
        archive.directory(tmpDir, false);
        archive.finalize();
      });

      // Cleanup temp directory
      fs.rmSync(tmpDir, { recursive: true, force: true });

      const sizeMB = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
      return {
        success: true,
        path: zipPath,
        filename: path.basename(zipPath),
        photoCount: photoList.length,
        sizeMB: Number.parseFloat(sizeMB),
      };
    } catch (e: any) {
      // Cleanup on error
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      return { success: false, error: e.message };
    }
  });