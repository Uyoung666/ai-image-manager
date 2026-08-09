import fs from "node:fs";
import fsp from "node:fs/promises";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
} from "drizzle-orm";
import { shell } from "electron";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  albumPhotos,
  albums,
  duplicatePairs,
  exifData,
  folders,
  photos,
  photoTags,
} from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { deletePhotoVectors } from "@/services/ai-embedder";
import { validateDuplicateCleanupGroup } from "@/services/duplicate-groups";
import { invalidateSmartAlbumCache } from "@/services/smart-album-engine";
import {
  cleanOrphanThumbnails as cleanOrphanThumbnailsService,
  clearThumbnailDiskCache,
  deletePhotoThumbnails,
  generateThumbnail,
  getThumbnailPath,
  scanOrphanThumbnails as scanOrphanThumbnailsService,
} from "@/services/thumbnailer";
import {
  executeSystemTrashMove,
  type TrashOperationFailure,
  type TrashOperationResult,
} from "@/services/trash-operations";
import { BatchPhotoIdsSchema, IdSchema, TrashListSchema } from "./shared";
import { invalidateIndexStatsCache, invalidateStatsCache } from "./stats";

/**
 * Unified hard-delete: removes photo DB records, updates folder photoCounts,
 * and cleans up AI vectors. All DB operations run in a single transaction.
 * Only decrements photoCount for photos that were NOT already soft-deleted,
 * avoiding double-counting when called from emptyTrash/permanentlyDeletePhotos.
 */
function performHardDelete(photoIds: number[]): void {
  if (photoIds.length === 0) {
    return;
  }

  const db = getDatabase();

  // Only decrement folder counts for photos that aren't already soft-deleted.
  // Soft-delete (deletePhoto/deletePhotos) already decremented the count,
  // so emptyTrash/permanentlyDeletePhotos must not decrement again.
  const photoFolders = db
    .select({
      path: photos.path,
      folderId: photos.folderId,
      deletedAt: photos.deletedAt,
    })
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
    // 清理引用被删照片的相册封面（必须在 delete photos 之前，albumPhotos 有 FK cascade）
    const affectedAlbums = db
      .select({ id: albums.id, isSmart: albums.isSmart })
      .from(albums)
      .where(inArray(albums.coverPhotoId, photoIds))
      .all();

    for (const album of affectedAlbums) {
      if (album.isSmart) {
        // 智能相册：置 null，下次读取时自动重算
        db.update(albums)
          .set({ coverPhotoId: null })
          .where(eq(albums.id, album.id))
          .run();
      } else {
        // 普通相册：尝试找下一张照片作为封面（排除即将被删的照片）
        const nextCover = db
          .select({ photoId: albumPhotos.photoId })
          .from(albumPhotos)
          .where(
            and(
              eq(albumPhotos.albumId, album.id),
              sql`${albumPhotos.photoId} NOT IN (${photoIds.join(",")})`
            )
          )
          .orderBy(asc(albumPhotos.sortOrder))
          .get();
        db.update(albums)
          .set({ coverPhotoId: nextCover?.photoId ?? null })
          .where(eq(albums.id, album.id))
          .run();
      }
    }

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
  invalidateCountCache();
  invalidateSmartAlbumCache();
}

const photoIdsMovingToSystemTrash = new Set<number>();

interface AssetMove {
  from: string;
  to: string;
}

function rollbackAssetMoves(moves: AssetMove[]): void {
  for (const move of [...moves].reverse()) {
    try {
      if (fs.existsSync(move.to) && !fs.existsSync(move.from)) {
        fs.renameSync(move.to, move.from);
      }
    } catch (error) {
      console.error(
        `[Photos] Failed to roll back ${move.to} -> ${move.from}:`,
        error
      );
    }
  }
}

function movePhotoAssets(oldPath: string, newPath: string): AssetMove[] {
  const moves: AssetMove[] = [];
  try {
    fs.renameSync(oldPath, newPath);
    moves.push({ from: oldPath, to: newPath });

    for (const size of ["sm", "md", "lg"] as const) {
      const oldThumb = getThumbnailPath(oldPath, size);
      if (!fs.existsSync(oldThumb)) {
        continue;
      }
      const newThumb = getThumbnailPath(newPath, size);
      fs.mkdirSync(path.dirname(newThumb), { recursive: true });
      fs.renameSync(oldThumb, newThumb);
      moves.push({ from: oldThumb, to: newThumb });
    }
    return moves;
  } catch (error) {
    rollbackAssetMoves(moves);
    throw error;
  }
}

async function moveFilesToSystemTrash(
  targetPhotos: Array<{ id: number; path: string }>
): Promise<TrashOperationResult> {
  const availablePhotos = targetPhotos.filter(
    (photo) => !photoIdsMovingToSystemTrash.has(photo.id)
  );
  const busyFailures: TrashOperationFailure[] = targetPhotos
    .filter((photo) => photoIdsMovingToSystemTrash.has(photo.id))
    .map((photo) => ({
      code: "FILE_OPERATION_FAILED",
      id: photo.id,
      message: "Photo is already being moved to the system trash",
    }));
  for (const photo of availablePhotos) {
    photoIdsMovingToSystemTrash.add(photo.id);
  }
  try {
    const result = await executeSystemTrashMove(availablePhotos, {
      fileExists: async (filePath) => {
        try {
          await fsp.lstat(filePath);
          return true;
        } catch (error) {
          const code = (error as NodeJS.ErrnoException)?.code;
          if (code === "ENOENT" || code === "ENOTDIR") {
            return false;
          }
          throw error;
        }
      },
      hardDelete: performHardDelete,
      onFailure: (photo, message) => {
        console.warn(`[Trash] Failed to trash file: ${photo.path}`, message);
      },
      trashFile: (filePath) => shell.trashItem(filePath),
    });
    result.failed.push(...busyFailures);
    return result;
  } finally {
    for (const photo of availablePhotos) {
      photoIdsMovingToSystemTrash.delete(photo.id);
    }
  }
}

export const deletePhoto = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({
      path: photos.path,
      folderId: photos.folderId,
      deletedAt: photos.deletedAt,
    })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (photo) {
    // Skip if already soft-deleted (idempotency guard)
    if (photo.deletedAt !== null) {
      return { success: true };
    }
    db.transaction(() => {
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
    });
  }
  invalidateStatsCache();
  invalidateCountCache();
  invalidateSmartAlbumCache();
  return { success: true };
});

export const deletePhotos = os
  .input(BatchPhotoIdsSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    // Only target active (non-soft-deleted) photos for idempotency
    const targetPhotos = db
      .select({ id: photos.id, folderId: photos.folderId })
      .from(photos)
      .where(
        and(inArray(photos.id, input.ids), sql`${photos.deletedAt} IS NULL`)
      )
      .all();
    if (targetPhotos.length === 0) {
      return { deleted: 0 };
    }
    const activeIds = targetPhotos.map((p) => p.id);
    const countsByFolder = new Map<number, number>();
    for (const p of targetPhotos) {
      if (p.folderId) {
        countsByFolder.set(
          p.folderId,
          (countsByFolder.get(p.folderId) || 0) + 1
        );
      }
    }
    db.transaction(() => {
      db.update(photos)
        .set({ deletedAt: Date.now() })
        .where(inArray(photos.id, activeIds))
        .run();
      for (const [fid, count] of countsByFolder) {
        db.update(folders)
          .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
          .where(eq(folders.id, fid))
          .run();
      }
    });
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
    return { deleted: activeIds.length };
  });

export const cleanDuplicateGroups = os
  .input(
    z.object({
      groups: z
        .array(
          z.object({
            deletePhotoIds: z.array(z.number().int().positive()).min(1),
            keepPhotoId: z.number().int().positive(),
            pairIds: z.array(z.number().int().positive()).min(1),
          })
        )
        .min(1),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const deleteIds = new Set<number>();
    const keepIds = new Set<number>();
    const claimedPairIds = new Set<number>();

    for (const group of input.groups) {
      const pairIds = [...new Set(group.pairIds)];
      if (pairIds.some((id) => claimedPairIds.has(id))) {
        throw new Error("Duplicate relationship submitted more than once");
      }
      const relations = db
        .select({
          id: duplicatePairs.id,
          photoAId: duplicatePairs.photoAId,
          photoBId: duplicatePairs.photoBId,
        })
        .from(duplicatePairs)
        .where(inArray(duplicatePairs.id, pairIds))
        .all();
      for (const relation of relations) {
        claimedPairIds.add(relation.id);
      }
      const groupDeleteIds = validateDuplicateCleanupGroup(relations, group);
      keepIds.add(group.keepPhotoId);
      for (const id of groupDeleteIds) {
        deleteIds.add(id);
      }
    }

    if ([...keepIds].some((id) => deleteIds.has(id))) {
      throw new Error("A keeper cannot be deleted by another group");
    }

    const targetPhotos = db
      .select({ id: photos.id, folderId: photos.folderId })
      .from(photos)
      .where(
        and(
          inArray(photos.id, [...deleteIds]),
          sql`${photos.deletedAt} IS NULL`
        )
      )
      .all();
    if (targetPhotos.length === 0) {
      return { deleted: 0 };
    }

    const activeIds = targetPhotos.map((photo) => photo.id);
    db.transaction(() => {
      db.update(photos)
        .set({ deletedAt: Date.now() })
        .where(inArray(photos.id, activeIds))
        .run();
      const countsByFolder = new Map<number, number>();
      for (const photo of targetPhotos) {
        if (photo.folderId) {
          countsByFolder.set(
            photo.folderId,
            (countsByFolder.get(photo.folderId) ?? 0) + 1
          );
        }
      }
      for (const [folderId, count] of countsByFolder) {
        db.update(folders)
          .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
          .where(eq(folders.id, folderId))
          .run();
      }
    });
    invalidateCountCache();
    invalidateStatsCache();
    return { deleted: activeIds.length };
  });

/**
 * Shared utility: returns photo IDs for orphan records — photos whose folderId
 * is NULL or points to a deleted folder. Includes both active and soft-deleted
 * photos — when the original folder is gone, there is nothing to restore, so
 * even trashed orphans should be cleaned up immediately.
 * Used by both startup cleanup in main.ts and the cleanupOrphanPhotos handler.
 */
export function getOrphanPhotoIds(
  db: ReturnType<typeof getDatabase>
): number[] {
  return db
    .select({ id: photos.id })
    .from(photos)
    .where(
      sql`${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (SELECT id FROM folders)`
    )
    .all()
    .map((p) => p.id);
}

// Clean up orphan photos (both active and soft-deleted): photos whose folderId
// is NULL or points to a deleted folder. When the original folder is gone there
// is nothing to restore, so trashed orphans are cleaned up together with active ones.
// Also recalculates folder photoCounts.
export const cleanupOrphanPhotos = os.handler(() => {
  const db = getDatabase();

  const orphanIds = getOrphanPhotoIds(db);
  const orphanRecords =
    orphanIds.length > 0
      ? db
          .select({ id: photos.id, path: photos.path })
          .from(photos)
          .where(inArray(photos.id, orphanIds))
          .all()
      : [];

  if (orphanIds.length > 0) {
    // Clean up orphaned thumbnail files before removing DB records
    for (const r of orphanRecords) {
      deletePhotoThumbnails(r.path);
    }

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

  return { removed: orphanRecords.length };
});

// Move photos to a different folder (drag-and-drop in sidebar)
export const movePhotos = os
  .input(z.object({ ids: z.array(z.number()), targetFolderId: z.number() }))
  .handler(({ input }) => {
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

        const newPath = path.join(targetFolder.path, path.basename(photo.path));
        if (fs.existsSync(newPath) && newPath !== photo.path) {
          results.push({ id, error: "目标文件夹已存在同名文件" });
          continue;
        }

        const movedAssets = movePhotoAssets(photo.path, newPath);
        try {
          db.transaction(() => {
            db.update(photos)
              .set({ path: newPath, folderId: input.targetFolderId })
              .where(eq(photos.id, id))
              .run();

            // Keep the catalog path and folder counts atomic with the file
            // move. A database failure is followed by an asset rollback.
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
          });
        } catch (error) {
          rollbackAssetMoves(movedAssets);
          throw error;
        }

        results.push({ id });
      } catch (err) {
        results.push({
          id,
          error: err instanceof Error ? err.message : "Move failed",
        });
      }
    }
    return { moved: results.filter((r) => !r.error).length, results };
  });

function applyRenamePattern(
  pattern: string,
  filename: string,
  index: number,
  exif:
    | Record<string, boolean | number | string | null | undefined>
    | null
    | undefined,
  fileDate: number | string | null
): string {
  const ext = path.extname(filename);
  const base = path.basename(filename, ext);
  const dateTaken = exif?.dateTaken;
  const date =
    typeof dateTaken === "string" || typeof dateTaken === "number"
      ? new Date(dateTaken)
      : new Date(fileDate ?? Date.now());
  let newBase = pattern
    .replace(/\{yyyy\}/g, date.getFullYear().toString())
    .replace(/\{mm\}/g, String(date.getMonth() + 1).padStart(2, "0"))
    .replace(/\{dd\}/g, String(date.getDate()).padStart(2, "0"))
    .replace(
      /\{camera\}/g,
      String(exif?.cameraModel || "Unknown").replace(/[<>:"/\\|?*]/g, "")
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
  .handler(({ input }) => {
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
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch rename preserves per-photo ordering and error reporting.
  .handler(({ input }) => {
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
        const movedAssets = movePhotoAssets(photo.path, newPath);

        const newThumbPath = getThumbnailPath(newPath, "md");

        // Migrate thumbnails (all sizes): try renaming old thumbnail files first
        let thumbMigrated = true;
        for (const size of ["sm", "md", "lg"] as const) {
          const oldThumb = getThumbnailPath(photo.path, size);
          if (fs.existsSync(oldThumb)) {
            try {
              const newThumb = getThumbnailPath(newPath, size);
              fs.renameSync(oldThumb, newThumb);
            } catch {
              // Cross-device or permission error — delete old, generate new
              thumbMigrated = false;
              try {
                fs.unlinkSync(oldThumb);
              } catch {
                /* best-effort */
              }
            }
          }
        }
        if (!thumbMigrated) {
          // Generate new thumbnail asynchronously (don't block rename)
          generateThumbnail(newPath, "md").catch(() => {
            // Thumbnail generation is best-effort during rename.
          });
        }
        try {
          db.update(photos)
            .set({
              path: newPath,
              filename: newFilename,
              thumbnailPath: newThumbPath,
            })
            .where(eq(photos.id, photo.id))
            .run();
        } catch (error) {
          rollbackAssetMoves(movedAssets);
          throw error;
        }
        results.push({
          id: photo.id,
          oldName: photo.filename,
          newName: newFilename,
        });
      } catch (e) {
        results.push({
          id: photo.id,
          oldName: photo.filename,
          newName: newFilename,
          error: e instanceof Error ? e.message : String(e),
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
        let pipeline = sharp(photo.path).rotate();
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

export const clearThumbCache = os.handler(async () => {
  const result = await clearThumbnailDiskCache();
  invalidateIndexStatsCache();
  return result;
});

export const scanOrphanThumbnails = os.handler(async () => {
  return await scanOrphanThumbnailsService();
});

export const cleanOrphanThumbnails = os.handler(async () => {
  const result = await cleanOrphanThumbnailsService();
  invalidateIndexStatsCache();
  return result;
});

export const backfillMissingThumbnails = os
  .input(
    z.object({
      ids: z.array(z.number()).max(200),
      limit: z.number().min(1).max(50).default(24),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const uniqueIds = [...new Set(input.ids)].slice(0, input.limit);
    if (uniqueIds.length === 0) {
      return { checked: 0, generated: 0, failed: 0 };
    }

    const candidates = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(
        and(
          inArray(photos.id, uniqueIds),
          isNull(photos.deletedAt),
          isNull(photos.thumbnailPath)
        )
      )
      .all();

    let generated = 0;
    let failed = 0;
    const updated: Array<{
      id: number;
      thumbnailPath: string;
      thumbnailSmallPath: string | null;
    }> = [];
    for (const photo of candidates) {
      try {
        if (!fs.existsSync(photo.path)) {
          failed++;
          continue;
        }
        const result = await generateThumbnail(photo.path, "md");
        db.update(photos)
          .set({ thumbnailPath: result.thumbnailPath })
          .where(eq(photos.id, photo.id))
          .run();
        generated++;
        updated.push({
          id: photo.id,
          thumbnailPath: result.thumbnailPath,
          thumbnailSmallPath: null,
        });
      } catch (err) {
        failed++;
        console.warn(
          `[ThumbnailBackfill] Failed for photo ${photo.id}: ${(err as Error)?.message ?? String(err)}`
        );
      }
    }

    if (generated > 0) {
      invalidateStatsCache();
    }

    return { checked: candidates.length, generated, failed, updated };
  });

export const toggleFavorite = os
  .input(z.object({ ids: z.array(z.number()), favorite: z.boolean() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(photos)
      .set({ isFavorite: input.favorite })
      .where(inArray(photos.id, input.ids))
      .run();
    invalidateStatsCache();
    return { success: true };
  });

export const listDeletedPhotos = os
  .input(TrashListSchema)
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Trash cleanup preserves the existing retention and filesystem flow.
  .handler(({ input }) => {
    const db = getDatabase();

    // Expired records stay visible until their file operation succeeds. This
    // lets users retry failures instead of silently losing them from the UI.
    const trashCondition = sql`${photos.deletedAt} IS NOT NULL`;
    const conditions = [trashCondition];
    if (input.query) {
      const escapedQuery = input.query.replace(/[\\%_]/g, "\\$&");
      conditions.push(
        sql`${photos.filename} LIKE ${`%${escapedQuery}%`} ESCAPE '\\'`
      );
    }
    const filteredWhere = and(...conditions);
    const sortColumns = {
      deletedAt: photos.deletedAt,
      name: photos.filename,
      size: photos.fileSize,
    };
    const sortColumn = sortColumns[input.sort];
    const sortDirection = input.order === "asc" ? asc : desc;

    if (input.cursor) {
      const idTieBreak = lt(photos.id, input.cursor.id);
      if (input.sort === "name") {
        const cursorValue = String(input.cursor.value);
        const cursorCondition = or(
          input.order === "asc"
            ? gt(photos.filename, cursorValue)
            : lt(photos.filename, cursorValue),
          and(eq(photos.filename, cursorValue), idTieBreak)
        );
        if (cursorCondition) {
          conditions.push(cursorCondition);
        }
      } else {
        const cursorValue = Number(input.cursor.value);
        const column =
          input.sort === "size" ? photos.fileSize : photos.deletedAt;
        const cursorCondition = or(
          input.order === "asc"
            ? gt(column, cursorValue)
            : lt(column, cursorValue),
          and(eq(column, cursorValue), idTieBreak)
        );
        if (cursorCondition) {
          conditions.push(cursorCondition);
        }
      }
    }
    const pageWhere = and(...conditions);

    const pageItems = db
      .select({
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        fileSize: photos.fileSize,
        width: photos.width,
        height: photos.height,
        thumbnailPath: photos.thumbnailPath,
        deletedAt: photos.deletedAt,
        folderId: photos.folderId,
        folderName: folders.displayName,
      })
      .from(photos)
      .leftJoin(folders, eq(folders.id, photos.folderId))
      .where(pageWhere)
      .orderBy(sortDirection(sortColumn), desc(photos.id))
      .limit(input.limit + 1)
      .all();

    const hasMore = pageItems.length > input.limit;
    const items = hasMore ? pageItems.slice(0, input.limit) : pageItems;

    const summary = db
      .select({
        totalBytes: sql<number>`COALESCE(SUM(${photos.fileSize}), 0)`,
        totalCount: sql<number>`COUNT(*)`,
      })
      .from(photos)
      .where(filteredWhere)
      .get();
    const totalCount = summary?.totalCount ?? 0;

    const trashSummary = input.query
      ? db
          .select({
            totalBytes: sql<number>`COALESCE(SUM(${photos.fileSize}), 0)`,
            totalCount: sql<number>`COUNT(*)`,
          })
          .from(photos)
          .where(trashCondition)
          .get()
      : summary;

    const lastItem = items.at(-1);
    let cursorValue: number | string | null = null;
    if (lastItem) {
      if (input.sort === "name") {
        cursorValue = lastItem.filename;
      } else if (input.sort === "size") {
        cursorValue = lastItem.fileSize;
      } else {
        cursorValue = lastItem.deletedAt;
      }
    }

    return {
      items,
      nextCursor:
        hasMore && lastItem && cursorValue !== null
          ? { id: lastItem.id, value: cursorValue }
          : null,
      totalBytes: summary?.totalBytes ?? 0,
      totalCount,
      trashTotalBytes: trashSummary?.totalBytes ?? 0,
      trashTotalCount: trashSummary?.totalCount ?? 0,
    };
  });

export const restorePhotos = os
  .input(BatchPhotoIdsSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const targetPhotos = db
      .select({ id: photos.id, folderId: photos.folderId, path: photos.path })
      .from(photos)
      .where(
        and(inArray(photos.id, input.ids), sql`${photos.deletedAt} IS NOT NULL`)
      )
      .all();

    const targetById = new Map(targetPhotos.map((photo) => [photo.id, photo]));
    const failed: TrashOperationFailure[] = input.ids
      .filter((id) => !targetById.has(id))
      .map((id) => ({
        code: "NOT_FOUND_OR_NOT_DELETED",
        id,
        message: "Photo was not found in recently deleted",
      }));
    const restorablePhotos = targetPhotos.filter((photo) => {
      if (photoIdsMovingToSystemTrash.has(photo.id)) {
        failed.push({
          code: "FILE_OPERATION_FAILED",
          id: photo.id,
          message: "Photo is currently being moved to the system trash",
        });
        return false;
      }
      if (fs.existsSync(photo.path)) {
        return true;
      }
      failed.push({
        code: "SOURCE_MISSING",
        id: photo.id,
        message: "Original file no longer exists",
      });
      return false;
    });

    // Collect all valid folder IDs currently in the folders table
    const validFolderIds = new Set(
      db
        .select({ id: folders.id })
        .from(folders)
        .all()
        .map((f) => f.id)
    );

    // Separate photos with valid vs invalid/missing original folders
    const idsWithValidFolder: number[] = [];
    const idsWithoutFolder: number[] = [];
    const countsByFolder = new Map<number, number>();

    for (const p of restorablePhotos) {
      if (p.folderId && validFolderIds.has(p.folderId)) {
        idsWithValidFolder.push(p.id);
        countsByFolder.set(
          p.folderId,
          (countsByFolder.get(p.folderId) || 0) + 1
        );
      } else {
        idsWithoutFolder.push(p.id);
      }
    }

    // Restore photos with valid folders
    db.transaction(() => {
      if (idsWithValidFolder.length > 0) {
        db.update(photos)
          .set({ deletedAt: null })
          .where(inArray(photos.id, idsWithValidFolder))
          .run();
        for (const [fid, count] of countsByFolder) {
          db.update(folders)
            .set({ photoCount: sql`photo_count + ${count}` })
            .where(eq(folders.id, fid))
            .run();
        }
      }

      // Restore photos whose original folder no longer exists — set folderId to NULL
      if (idsWithoutFolder.length > 0) {
        db.update(photos)
          .set({ deletedAt: null, folderId: null })
          .where(inArray(photos.id, idsWithoutFolder))
          .run();
      }
    });

    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();

    return {
      failed,
      restoredWithoutFolderIds: idsWithoutFolder,
      succeededIds: [...idsWithValidFolder, ...idsWithoutFolder],
    };
  });

export const permanentlyDeletePhotos = os
  .input(BatchPhotoIdsSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const targetPhotos = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(
        and(inArray(photos.id, input.ids), sql`${photos.deletedAt} IS NOT NULL`)
      )
      .all();
    const foundIds = new Set(targetPhotos.map((photo) => photo.id));
    const result = await moveFilesToSystemTrash(targetPhotos);
    result.failed.push(
      ...input.ids
        .filter((id) => !foundIds.has(id))
        .map((id) => ({
          code: "NOT_FOUND_OR_NOT_DELETED" as const,
          id,
          message: "Photo was not found in recently deleted",
        }))
    );
    return result;
  });

export const emptyTrash = os.handler(() => {
  const db = getDatabase();
  const deletedPhotos = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(sql`${photos.deletedAt} IS NOT NULL`)
    .all();
  const ids = deletedPhotos.map((p) => p.id);
  if (ids.length === 0) {
    invalidateStatsCache();
    return { failed: [], succeededIds: [] };
  }
  return moveFilesToSystemTrash(deletedPhotos);
});

/**
 * Clean up photos that have been in trash for over 30 days.
 * Called at app startup to enforce the 30-day retention policy.
 * Returns the count of permanently deleted photos.
 */
let trashCleanupPromise: Promise<number> | null = null;

export function cleanupExpiredTrash(): Promise<number> {
  if (!trashCleanupPromise) {
    trashCleanupPromise = runExpiredTrashCleanup().finally(() => {
      trashCleanupPromise = null;
    });
  }
  return trashCleanupPromise;
}

async function runExpiredTrashCleanup(): Promise<number> {
  const db = getDatabase();
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;

  const expiredPhotos = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(
      sql`${photos.deletedAt} IS NOT NULL AND ${photos.deletedAt} <= ${thirtyDaysAgo}`
    )
    .all();

  if (expiredPhotos.length === 0) {
    return 0;
  }

  console.log(
    `[TrashCleanup] Removing ${expiredPhotos.length} expired photos (older than 30 days)...`
  );

  const result = await moveFilesToSystemTrash(expiredPhotos);

  console.log(
    `[TrashCleanup] Moved ${result.succeededIds.length} expired photos to the system trash`
  );
  return result.succeededIds.length;
}
