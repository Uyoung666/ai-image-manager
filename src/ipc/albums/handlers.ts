import { os } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { albumPhotos, albums, photos } from "@/db/schema";
import {
  evaluateSmartAlbum,
  validateSmartRules,
} from "@/services/smart-album-engine";

const IdSchema = z.object({ id: z.number() });
const CreateAlbumSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().optional(),
  coverPhotoId: z.number().optional(),
  isSmart: z.boolean().optional().default(false),
  smartRules: z.string().optional(),
});
const UpdateAlbumSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().optional().nullable(),
  coverPhotoId: z.number().optional().nullable(),
  isSmart: z.boolean().optional(),
  smartRules: z.string().optional().nullable(),
});
const AddPhotosSchema = z.object({
  albumId: z.number(),
  photoIds: z.array(z.number()).min(1),
});
const RemovePhotosSchema = z.object({
  albumId: z.number(),
  photoIds: z.array(z.number()).min(1),
});
const ReorderPhotosSchema = z.object({
  albumId: z.number(),
  photoIds: z.array(z.number()),
});
const ListAlbumsSchema = z.object({
  isSmart: z.boolean().optional(),
});

/**
 * 刷新智能相册封面：评估规则 → 取匹配的第一张照片（按 fileDate DESC）
 * 仅在封面需要变更时才写入数据库（当前封面不再匹配规则 或 当前封面为 null）
 */
function refreshSmartAlbumCover(albumId: number): void {
  const db = getDatabase();
  const album = db
    .select({
      coverPhotoId: albums.coverPhotoId,
      smartRules: albums.smartRules,
    })
    .from(albums)
    .where(and(eq(albums.id, albumId), eq(albums.isSmart, true)))
    .get();

  if (!album?.smartRules) {
    return;
  }

  try {
    const rules = JSON.parse(album.smartRules);
    const photoIds = evaluateSmartAlbum(rules);

    let newCoverId: number | null = null;
    if (photoIds.length > 0) {
      const firstPhoto = db
        .select({ id: photos.id })
        .from(photos)
        .where(and(inArray(photos.id, photoIds), isNull(photos.deletedAt)))
        .orderBy(desc(photos.fileDate))
        .limit(1)
        .get();
      newCoverId = firstPhoto?.id ?? null;
    }

    // 仅在封面需要变更时写入
    if (newCoverId !== (album.coverPhotoId ?? null)) {
      db.update(albums)
        .set({ coverPhotoId: newCoverId })
        .where(eq(albums.id, albumId))
        .run();
    }
  } catch {
    // 规则解析失败，跳过
  }
}

export const listAlbums = os.input(ListAlbumsSchema).handler(({ input }) => {
  const db = getDatabase();
  let query = db
    .select()
    .from(albums)
    .orderBy(desc(albums.createdAt))
    .$dynamic();
  if (input.isSmart !== undefined) {
    query = query.where(eq(albums.isSmart, input.isSmart));
  }
  const list = query.all();

  // 始终刷新智能相册封面（refreshSmartAlbumCover 内部做"仅变更时写入"短路）
  for (const album of list) {
    if (album.isSmart && album.smartRules) {
      try {
        refreshSmartAlbumCover(album.id);
        // 重新读取更新后的 coverPhotoId
        const refreshed = db
          .select({ coverPhotoId: albums.coverPhotoId })
          .from(albums)
          .where(eq(albums.id, album.id))
          .get();
        album.coverPhotoId = refreshed?.coverPhotoId ?? null;
      } catch {
        /* skip */
      }
    }
  }

  // 批量查询封面缩略图路径，避免前端 N+1 查询
  const coverIds = list
    .filter((a) => a.coverPhotoId !== null)
    .map((a) => a.coverPhotoId as number);

  const coverThumbnailMap = new Map<number, string>();
  if (coverIds.length > 0) {
    const coverRows = db
      .select({
        id: photos.id,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
      })
      .from(photos)
      .where(inArray(photos.id, coverIds))
      .all();
    for (const row of coverRows) {
      coverThumbnailMap.set(row.id, row.thumbnailPath || row.path);
    }
  }

  return list.map((album) => ({
    ...album,
    coverThumbnailPath: album.coverPhotoId
      ? (coverThumbnailMap.get(album.coverPhotoId) ?? null)
      : null,
  }));
});

export const getAlbum = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const album = db.select().from(albums).where(eq(albums.id, input.id)).get();

  if (!album) {
    throw new Error("相册不存在");
  }

  // Smart album: evaluate rules dynamically
  if (album.isSmart && album.smartRules) {
    try {
      refreshSmartAlbumCover(album.id);
      const refreshed = db
        .select({ coverPhotoId: albums.coverPhotoId })
        .from(albums)
        .where(eq(albums.id, album.id))
        .get();
      album.coverPhotoId = refreshed?.coverPhotoId ?? null;

      const rules = JSON.parse(album.smartRules);
      const photoIds = evaluateSmartAlbum(rules);
      if (photoIds.length > 0) {
        const photoRows = db
          .select({
            id: photos.id,
            filename: photos.filename,
            path: photos.path,
            width: photos.width,
            height: photos.height,
            fileSize: photos.fileSize,
            format: photos.format,
            thumbnailPath: photos.thumbnailPath,
            fileDate: photos.fileDate,
            isIndexed: photos.isIndexed,
          })
          .from(photos)
          .where(and(inArray(photos.id, photoIds), isNull(photos.deletedAt)))
          .orderBy(desc(photos.fileDate))
          .all();

        return {
          ...album,
          photos: photoRows,
          matchCount: photoIds.length,
        };
      }
    } catch {
      // Rules parse error — fall through to return empty
    }
    return { ...album, photos: [], matchCount: 0 };
  }

  const photoRows = db
    .select({
      id: photos.id,
      filename: photos.filename,
      path: photos.path,
      width: photos.width,
      height: photos.height,
      fileSize: photos.fileSize,
      format: photos.format,
      thumbnailPath: photos.thumbnailPath,
      fileDate: photos.fileDate,
      isIndexed: photos.isIndexed,
      sortOrder: albumPhotos.sortOrder,
    })
    .from(albumPhotos)
    .innerJoin(photos, eq(albumPhotos.photoId, photos.id))
    .where(eq(albumPhotos.albumId, input.id))
    .orderBy(asc(albumPhotos.sortOrder), desc(photos.fileDate))
    .all();

  return { ...album, photos: photoRows };
});

export const createAlbum = os.input(CreateAlbumSchema).handler(({ input }) => {
  const db = getDatabase();
  const result = db
    .insert(albums)
    .values({
      name: input.name,
      description: input.description,
      coverPhotoId: input.coverPhotoId,
      isSmart: input.isSmart ?? false,
      smartRules: input.smartRules,
    })
    .run();
  const created = db
    .select()
    .from(albums)
    .where(eq(albums.id, Number(result.lastInsertRowid)))
    .get();
  return created;
});

export const updateAlbum = os.input(UpdateAlbumSchema).handler(({ input }) => {
  const db = getDatabase();
  const { id, ...fields } = input;

  const existing = db.select().from(albums).where(eq(albums.id, id)).get();
  if (!existing) {
    throw new Error("相册不存在");
  }

  const updates: Record<string, unknown> = {};
  if (fields.name !== undefined) {
    updates.name = fields.name;
  }
  if (fields.description !== undefined) {
    updates.description = fields.description;
  }
  if (fields.coverPhotoId !== undefined) {
    updates.coverPhotoId = fields.coverPhotoId;
  }
  if (fields.isSmart !== undefined) {
    updates.isSmart = fields.isSmart;
  }
  if (fields.smartRules !== undefined) {
    updates.smartRules = fields.smartRules;
  }

  if (Object.keys(updates).length > 0) {
    db.update(albums).set(updates).where(eq(albums.id, id)).run();
  }

  // 智能相册规则变更后刷新封面
  if (fields.smartRules !== undefined && existing.isSmart) {
    refreshSmartAlbumCover(id);
  }

  return db.select().from(albums).where(eq(albums.id, id)).get();
});

export const deleteAlbum = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const existing = db
    .select()
    .from(albums)
    .where(eq(albums.id, input.id))
    .get();
  if (!existing) {
    throw new Error("相册不存在");
  }

  // Cascade: delete album_photos entries first, then album
  db.delete(albumPhotos).where(eq(albumPhotos.albumId, input.id)).run();
  db.delete(albums).where(eq(albums.id, input.id)).run();
  return { success: true };
});

export const addPhotosToAlbum = os
  .input(AddPhotosSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const { albumId, photoIds } = input;

    // Verify album exists
    const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
    if (!album) {
      throw new Error("相册不存在");
    }
    if (album.isSmart) {
      throw new Error("智能相册的图片由规则自动匹配，无法手动添加");
    }

    const maxOrder = db
      .select({
        maxOrder: sql<number>`COALESCE(MAX(${albumPhotos.sortOrder}), -1)`,
      })
      .from(albumPhotos)
      .where(eq(albumPhotos.albumId, albumId))
      .get();

    let nextOrder = (maxOrder?.maxOrder ?? -1) + 1;
    let addedCount = 0;

    for (const photoId of photoIds) {
      try {
        db.insert(albumPhotos)
          .values({
            albumId,
            photoId,
            sortOrder: nextOrder,
          })
          .run();
        nextOrder++;
        addedCount++;
      } catch {
        // Skip duplicates (unique constraint on albumId+photoId)
      }
    }

    if (!album.coverPhotoId && addedCount > 0) {
      // 选择最新添加的照片作为封面
      const bestCover = db
        .select({ id: photos.id })
        .from(photos)
        .where(and(inArray(photos.id, photoIds), isNull(photos.deletedAt)))
        .orderBy(desc(photos.fileDate))
        .limit(1)
        .get();
      if (bestCover) {
        db.update(albums)
          .set({ coverPhotoId: bestCover.id })
          .where(eq(albums.id, albumId))
          .run();
      }
    }

    return { success: true, addedCount };
  });

export const removePhotosFromAlbum = os
  .input(RemovePhotosSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const { albumId, photoIds } = input;

    if (photoIds.length === 0) {
      return { success: true, removedCount: 0 };
    }

    const result = db
      .delete(albumPhotos)
      .where(
        and(
          eq(albumPhotos.albumId, albumId),
          inArray(albumPhotos.photoId, photoIds)
        )
      )
      .run();

    // If cover photo was removed, pick a new one
    const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
    if (album && photoIds.includes(album.coverPhotoId ?? -1)) {
      const nextCover = db
        .select({ photoId: albumPhotos.photoId })
        .from(albumPhotos)
        .innerJoin(photos, eq(albumPhotos.photoId, photos.id))
        .where(and(eq(albumPhotos.albumId, albumId), isNull(photos.deletedAt)))
        .orderBy(asc(albumPhotos.sortOrder))
        .get();
      db.update(albums)
        .set({ coverPhotoId: nextCover?.photoId ?? null })
        .where(eq(albums.id, albumId))
        .run();
    }

    return { success: true, removedCount: result.changes };
  });

export const reorderAlbumPhotos = os
  .input(ReorderPhotosSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const { albumId, photoIds } = input;

    const album = db.select().from(albums).where(eq(albums.id, albumId)).get();
    if (album?.isSmart) {
      throw new Error("智能相册不支持手动排序");
    }

    for (let i = 0; i < photoIds.length; i++) {
      db.update(albumPhotos)
        .set({ sortOrder: i })
        .where(
          sql`${albumPhotos.albumId} = ${albumId} AND ${albumPhotos.photoId} = ${photoIds[i]}`
        )
        .run();
    }

    return { success: true };
  });

export const evaluateSmartAlbumHandler = os
  .input(z.object({ albumId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    const album = db
      .select()
      .from(albums)
      .where(eq(albums.id, input.albumId))
      .get();
    if (!album) {
      throw new Error("相册不存在");
    }
    if (!album.smartRules) {
      return { photos: [], total: 0 };
    }

    const rules = JSON.parse(album.smartRules);
    const photoIds = evaluateSmartAlbum(rules);

    if (!photoIds.length) {
      return { photos: [], total: 0 };
    }

    const photoRows = db
      .select({
        id: photos.id,
        filename: photos.filename,
        path: photos.path,
        width: photos.width,
        height: photos.height,
        fileSize: photos.fileSize,
        format: photos.format,
        thumbnailPath: photos.thumbnailPath,
        thumbnailSize: photos.thumbnailSize,
        fileDate: photos.fileDate,
      })
      .from(photos)
      .where(and(inArray(photos.id, photoIds), isNull(photos.deletedAt)))
      .orderBy(desc(photos.fileDate))
      .all();

    return { photos: photoRows, total: photoIds.length };
  });

export const validateSmartAlbumRules = os
  .input(z.object({ smartRules: z.string() }))
  .handler(({ input }) => {
    return validateSmartRules(input.smartRules);
  });
