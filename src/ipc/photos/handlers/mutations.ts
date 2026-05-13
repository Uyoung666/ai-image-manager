import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { eq, inArray, sql } from "drizzle-orm";
import { shell } from "electron";
import { z } from "zod";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags } from "@/db/schema";
import { deletePhotoVectors } from "@/services/ai-embedder";
import {
  clearThumbnailDiskCache,
  generateThumbnail,
  getThumbnailPath,
} from "@/services/thumbnailer";
import { IdSchema } from "./shared";

export const deletePhoto = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path, folderId: photos.folderId })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (photo) {
    // Move file to system recycle bin
    if (fs.existsSync(photo.path)) {
      await shell.trashItem(photo.path);
    }
    db.delete(exifData).where(eq(exifData.photoId, input.id)).run();
    db.delete(photos).where(eq(photos.id, input.id)).run();
    // Clean up LanceDB vector
    deletePhotoVectors([input.id]).catch((err) =>
      console.error("[AI] deletePhoto vector cleanup failed:", err)
    );
    // Decrement folder photoCount
    if (photo.folderId) {
      db.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - 1)` })
        .where(eq(folders.id, photo.folderId))
        .run();
    }
  }
  return { success: true };
});

export const deletePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const deletedPhotos = db
      .select({ id: photos.id, path: photos.path, folderId: photos.folderId })
      .from(photos)
      .where(inArray(photos.id, input.ids))
      .all();
    // Move files to system recycle bin
    for (const p of deletedPhotos) {
      if (fs.existsSync(p.path)) {
        await shell.trashItem(p.path);
      }
    }
    for (const id of input.ids) {
      db.delete(exifData).where(eq(exifData.photoId, id)).run();
      db.delete(photos).where(eq(photos.id, id)).run();
    }
    // Clean up LanceDB vectors
    deletePhotoVectors(input.ids).catch((err) =>
      console.error("[AI] deletePhotos vector cleanup failed:", err)
    );
    // Decrement folder photoCount by group
    const countsByFolder = new Map<number, number>();
    for (const p of deletedPhotos) {
      if (p.folderId) {
        countsByFolder.set(
          p.folderId,
          (countsByFolder.get(p.folderId) || 0) + 1
        );
      }
    }
    for (const [fid, count] of countsByFolder) {
      db.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
        .where(eq(folders.id, fid))
        .run();
    }
    return { deleted: input.ids.length };
  });

// Clean up orphan photos: photos with folderId=NULL or folderId pointing
// to a deleted folder. Also recalculates folder photoCounts.
export const cleanupOrphanPhotos = os.handler(async () => {
  const db = getDatabase();

  const orphanIds = db
    .select({ id: photos.id })
    .from(photos)
    .where(
      sql`${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (SELECT id FROM folders)`
    )
    .all()
    .map((p) => p.id);

  if (orphanIds.length > 0) {
    db.delete(exifData).where(inArray(exifData.photoId, orphanIds)).run();
    db.delete(photoTags).where(inArray(photoTags.photoId, orphanIds)).run();
    db.delete(photos).where(inArray(photos.id, orphanIds)).run();
    deletePhotoVectors(orphanIds).catch((err) =>
      console.error("[AI] cleanupOrphanPhotos vector cleanup failed:", err)
    );
  }
  // Recalculate all folder photoCounts
  const allFolders = db.select({ id: folders.id }).from(folders).all();
  for (const f of allFolders) {
    const count =
      db
        .select({ c: sql<number>`count(*)` })
        .from(photos)
        .where(eq(photos.folderId, f.id))
        .get()?.c ?? 0;
    db.update(folders)
      .set({ photoCount: count })
      .where(eq(folders.id, f.id))
      .run();
  }

  return { removed: orphanIds.length };
});

export const renamePhotos = os
  .input(
    z.object({
      ids: z.array(z.number()),
      pattern: z.string().min(1),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results: Array<{
      id: number;
      oldName: string;
      newName: string;
      error?: string;
    }> = [];

    for (let i = 0; i < input.ids.length; i++) {
      const photo = db
        .select()
        .from(photos)
        .where(eq(photos.id, input.ids[i]))
        .get();
      if (!photo) {
        continue;
      }

      const ext = path.extname(photo.filename);
      const base = path.basename(photo.filename, ext);
      const exif = db
        .select()
        .from(exifData)
        .where(eq(exifData.photoId, photo.id))
        .get();
      const date = exif?.dateTaken
        ? new Date(exif.dateTaken)
        : new Date(photo.fileDate ?? Date.now());
      let newBase = input.pattern
        .replace(/\{yyyy\}/g, date.getFullYear().toString())
        .replace(/\{mm\}/g, String(date.getMonth() + 1).padStart(2, "0"))
        .replace(/\{dd\}/g, String(date.getDate()).padStart(2, "0"))
        .replace(
          /\{camera\}/g,
          (exif?.cameraModel || "Unknown").replace(/[<>:"/\\|?*]/g, "")
        )
        .replace(/\{iso\}/g, exif?.iso?.toString() || "")
        .replace(/\{focal\}/g, (exif?.focalLength || "").toString())
        .replace(/\{index\}/g, (i + 1).toString())
        .replace(/\{index:(\d+)\}/g, (_, pad) =>
          String(i + 1).padStart(Number.parseInt(pad, 10), "0")
        )
        .replace(/\{orig\}/g, base)
        .replace(/\{ext\}/g, ext);

      // Clean invalid filename chars
      newBase = newBase.replace(/[<>:"/\\|?*]/g, "").trim() || base;
      const newFilename = newBase + ext;

      if (newFilename === photo.filename) {
        continue;
      }

      try {
        const newPath = path.join(path.dirname(photo.path), newFilename);
        if (fs.existsSync(newPath)) {
          results.push({
            id: photo.id,
            oldName: photo.filename,
            newName: newFilename,
            error: "目标文件已存在",
          });
          continue;
        }
        const oldThumbPath = photo.thumbnailPath;
        fs.renameSync(photo.path, newPath);
        const newThumbPath = getThumbnailPath(newPath, "md");

        // Migrate thumbnail: try renaming old thumbnail file first
        let thumbMigrated = false;
        if (oldThumbPath && fs.existsSync(oldThumbPath)) {
          try {
            fs.renameSync(oldThumbPath, newThumbPath);
            thumbMigrated = true;
          } catch {
            // Cross-device or permission error — generate fresh instead
          }
        }
        if (!thumbMigrated) {
          // Generate new thumbnail asynchronously (don't block rename)
          generateThumbnail(newPath, "md").catch(() => {});
        }
        db.update(photos)
          .set({
            path: newPath,
            filename: newFilename,
            thumbnailPath: newThumbPath,
          })
          .where(eq(photos.id, photo.id))
          .run();
        results.push({
          id: photo.id,
          oldName: photo.filename,
          newName: newFilename,
        });
      } catch (e: any) {
        results.push({
          id: photo.id,
          oldName: photo.filename,
          newName: newFilename,
          error: e.message,
        });
      }
    }

    return {
      renamed: results.filter((r) => !r.error).length,
      errors: results.filter((r) => r.error).length,
      results,
    };
  });

export const convertPhotos = os
  .input(
    z.object({
      ids: z.array(z.number()),
      format: z.enum(["jpg", "png", "webp", "avif"]),
      quality: z.number().min(10).max(100).default(80),
      maxWidth: z.number().optional(),
      outputDir: z.string().optional().default(""),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const sharp = (await import("sharp")).default;
    let converted = 0;

    const outputDir =
      input.outputDir || path.join(nodeOs.tmpdir(), `convert-${Date.now()}`);
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }

    for (const id of input.ids) {
      const photo = db.select().from(photos).where(eq(photos.id, id)).get();
      if (!photo) {
        continue;
      }
      try {
        let pipeline = sharp(photo.path);
        const meta = await pipeline.metadata();

        if (input.maxWidth && meta.width && meta.width > input.maxWidth) {
          pipeline = pipeline.resize(input.maxWidth);
        }

        const extNoDot = path
          .extname(photo.filename)
          .toLowerCase()
          .replace(".", "");
        const outName =
          input.format === extNoDot
            ? `${path.basename(photo.filename, path.extname(photo.filename))}_converted.${input.format}`
            : `${path.basename(photo.filename, path.extname(photo.filename))}.${input.format}`;

        const outPath = path.join(outputDir, outName);
        const buffer = await pipeline
          .toFormat(input.format, { quality: input.quality })
          .toBuffer();
        fs.writeFileSync(outPath, buffer);
        converted++;
      } catch (e) {
        console.error(`[Convert] Error converting photo ${id}:`, e);
      }
    }

    return { converted, outputDir };
  });

export const clearThumbCache = os.handler(() => {
  return clearThumbnailDiskCache();
});
