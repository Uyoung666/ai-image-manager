import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { shell } from "electron";
import { z } from "zod";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags } from "@/db/schema";
import { deletePhotoVectors } from "@/services/ai-embedder";
import {
  clearThumbnailDiskCache,
  deletePhotoThumbnails,
  generateThumbnail,
  getThumbnailPath,
} from "@/services/thumbnailer";
import { IdSchema } from "./shared";
import { invalidateStatsCache } from "./stats";

/**
 * Unified hard-delete: removes photo DB records, updates folder photoCounts,
 * and cleans up AI vectors. All DB operations run in a single transaction.
 * Only decrements photoCount for photos that were NOT already soft-deleted,
 * avoiding double-counting when called from emptyTrash/permanentlyDeletePhotos.
 */
function performHardDelete(photoIds: number[]): void {
  if (photoIds.length === 0) return;

  const db = getDatabase();

  // Only decrement folder counts for photos that aren't already soft-deleted.
  // Soft-delete (deletePhoto/deletePhotos) already decremented the count,
  // so emptyTrash/permanentlyDeletePhotos must not decrement again.
  const photoFolders = db
    .select({ path: photos.path, folderId: photos.folderId, deletedAt: photos.deletedAt })
    .from(photos)
    .where(inArray(photos.id, photoIds))
    .all();

  const countsByFolder = new Map<number, number>();
  for (const pf of photoFolders) {
    if (pf.folderId && pf.deletedAt === null) {
      countsByFolder.set(
        pf.folderId,
        (countsByFolder.get(pf.folderId) || 0) + 1
      );
    }
  }

  db.transaction(() => {
    db.delete(exifData).where(inArray(exifData.photoId, photoIds)).run();
    db.delete(photoTags).where(inArray(photoTags.photoId, photoIds)).run();
    db.delete(photos).where(inArray(photos.id, photoIds)).run();

    for (const [fid, count] of countsByFolder) {
      db.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
        .where(eq(folders.id, fid))
        .run();
    }
  });

  // Clean up thumbnails and vectors (outside transaction, best-effort)
  for (const pf of photoFolders) {
    deletePhotoThumbnails(pf.path);
  }
  deletePhotoVectors(photoIds).catch((err) =>
    console.error("[AI] performHardDelete vector cleanup failed:", err)
  );

  invalidateStatsCache();
}

export const deletePhoto = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path, folderId: photos.folderId })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (photo) {
    db.update(photos)
      .set({ deletedAt: Date.now() })
      .where(eq(photos.id, input.id))
      .run();
    if (photo.folderId) {
      db.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - 1)` })
        .where(eq(folders.id, photo.folderId))
        .run();
    }
  }
  invalidateStatsCache();
  return { success: true };
});

export const deletePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const targetPhotos = db
      .select({ id: photos.id, folderId: photos.folderId })
      .from(photos)
      .where(inArray(photos.id, input.ids))
      .all();
    db.update(photos)
      .set({ deletedAt: Date.now() })
      .where(inArray(photos.id, input.ids))
      .run();
    const countsByFolder = new Map<number, number>();
    for (const p of targetPhotos) {
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
  const allFolders = db.select({ id: folders.id }).from(folders).all();
  for (const f of allFolders) {
    const count =
      db
        .select({ c: sql<number>`count(*)` })
        .from(photos)
        .where(and(eq(photos.folderId, f.id), isNull(photos.deletedAt)))
        .get()?.c ?? 0;
    db.update(folders)
      .set({ photoCount: count })
      .where(eq(folders.id, f.id))
      .run();
  }

  return { removed: orphanIds.length };
});

// Move photos to a different folder (drag-and-drop in sidebar)
export const movePhotos = os
  .input(z.object({ ids: z.array(z.number()), targetFolderId: z.number() }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const targetFolder = db
      .select({ path: folders.path })
      .from(folders)
      .where(eq(folders.id, input.targetFolderId))
      .get();
    if (!targetFolder) {
      throw new Error("Target folder not found");
    }

    const results: { error?: string; id: number }[] = [];
    for (const id of input.ids) {
      try {
        const photo = db
          .select({ path: photos.path, folderId: photos.folderId })
          .from(photos)
          .where(eq(photos.id, id))
          .get();
        if (!(photo && photo.folderId !== input.targetFolderId)) {
          results.push({ id });
          continue;
        }

        const newPath = path.join(
          targetFolder.path,
          path.basename(photo.path)
        );
        if (fs.existsSync(newPath) && newPath !== photo.path) {
          results.push({ id, error: "目标文件夹已存在同名文件" });
          continue;
        }

        fs.renameSync(photo.path, newPath);

        // Move thumbnail too
        const oldThumb = getThumbnailPath(photo.path, "md");
        if (fs.existsSync(oldThumb)) {
          const newThumb = getThumbnailPath(newPath, "md");
          fs.mkdirSync(path.dirname(newThumb), { recursive: true });
          fs.renameSync(oldThumb, newThumb);
        }

        db.update(photos)
          .set({ path: newPath, folderId: input.targetFolderId })
          .where(eq(photos.id, id))
          .run();

        // Update source and target folder photoCounts
        if (photo.folderId) {
          db.update(folders)
            .set({ photoCount: sql`MAX(0, photo_count - 1)` })
            .where(eq(folders.id, photo.folderId))
            .run();
        }
        db.update(folders)
          .set({ photoCount: sql`photo_count + 1` })
          .where(eq(folders.id, input.targetFolderId))
          .run();

        results.push({ id });
      } catch (err: any) {
        results.push({ id, error: err?.message || "Move failed" });
      }
    }
    return { moved: results.filter((r) => !r.error).length, results };
  });

function applyRenamePattern(
  pattern: string,
  filename: string,
  index: number,
  exif: Record<string, any> | null | undefined,
  fileDate: number | string | null
): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const date = exif?.dateTaken
    ? new Date(exif.dateTaken)
    : new Date(fileDate ?? Date.now());
  let newBase = pattern
    .replace(/\{yyyy\}/g, date.getFullYear().toString())
    .replace(/\{mm\}/g, String(date.getMonth() + 1).padStart(2, "0"))
    .replace(/\{dd\}/g, String(date.getDate()).padStart(2, "0"))
    .replace(
      /\{camera\}/g,
      (exif?.cameraModel || "Unknown").replace(/[<>:"/\\|?*]/g, "")
    )
    .replace(/\{iso\}/g, exif?.iso?.toString() || "")
    .replace(/\{focal\}/g, (exif?.focalLength || "").toString())
    .replace(/\{index\}/g, (index + 1).toString())
    .replace(/\{index:(\d+)\}/g, (_, pad) =>
      String(index + 1).padStart(Number.parseInt(pad, 10), "0")
    )
    .replace(/\{orig\}/g, base)
    .replace(/\{ext\}/g, ext);

  newBase = newBase.replace(/[<>:"/\\|?*]/g, "").trim() || base;
  return newBase + ext;
}

export const previewRename = os
  .input(z.object({ id: z.number(), pattern: z.string().min(1) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const photo = db.select().from(photos).where(eq(photos.id, input.id)).get();
    if (!photo) {
      return { preview: "" };
    }
    const exif =
      db.select().from(exifData).where(eq(exifData.photoId, photo.id)).get() ||
      null;
    const preview = applyRenamePattern(
      input.pattern,
      photo.filename,
      0,
      exif,
      photo.fileDate
    );
    return { preview };
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

      const exif = db
        .select()
        .from(exifData)
        .where(eq(exifData.photoId, photo.id))
        .get();
      const newFilename = applyRenamePattern(
        input.pattern,
        photo.filename,
        i,
        exif || null,
        photo.fileDate
      );

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

export const toggleFavorite = os
  .input(z.object({ ids: z.array(z.number()), favorite: z.boolean() }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    db.update(photos)
      .set({ isFavorite: input.favorite })
      .where(inArray(photos.id, input.ids))
      .run();
    invalidateStatsCache();
    return { success: true };
  });

export const listDeletedPhotos = os.handler(() => {
  const db = getDatabase();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  return db
    .select()
    .from(photos)
    .where(
      sql`${photos.deletedAt} IS NOT NULL AND ${photos.deletedAt} > ${thirtyDaysAgo}`
    )
    .orderBy(desc(photos.deletedAt))
    .all();
});

export const restorePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const targetPhotos = db
      .select({ id: photos.id, folderId: photos.folderId })
      .from(photos)
      .where(inArray(photos.id, input.ids))
      .all();
    db.update(photos)
      .set({ deletedAt: null })
      .where(inArray(photos.id, input.ids))
      .run();
    // Restore folder photoCounts
    const countsByFolder = new Map<number, number>();
    for (const p of targetPhotos) {
      if (p.folderId) {
        countsByFolder.set(
          p.folderId,
          (countsByFolder.get(p.folderId) || 0) + 1
        );
      }
    }
    for (const [fid, count] of countsByFolder) {
      db.update(folders)
        .set({ photoCount: sql`photo_count + ${count}` })
        .where(eq(folders.id, fid))
        .run();
    }
    return { restored: input.ids.length };
  });

export const permanentlyDeletePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const targetPhotos = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(inArray(photos.id, input.ids))
      .all();
    for (const p of targetPhotos) {
      if (fs.existsSync(p.path)) {
        await shell.trashItem(p.path);
      }
    }
    performHardDelete(input.ids);
    return { deleted: input.ids.length };
  });

export const emptyTrash = os.handler(async () => {
  const db = getDatabase();
  const deletedPhotos = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(sql`${photos.deletedAt} IS NOT NULL`)
    .all();
  const ids = deletedPhotos.map((p) => p.id);
  if (ids.length === 0) {
    invalidateStatsCache();
    return { deleted: 0 };
  }
  for (const p of deletedPhotos) {
    if (fs.existsSync(p.path)) {
      await shell.trashItem(p.path);
    }
  }
  performHardDelete(ids);
  return { deleted: ids.length };
});
