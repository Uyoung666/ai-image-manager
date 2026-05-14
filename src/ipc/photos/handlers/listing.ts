import { os } from "@orpc/server";
import { BrowserWindow } from "electron";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags } from "@/db/schema";
import { deletePhotoVectors, embedAllPhotos } from "@/services/ai-embedder";
import { scanFolder as scanFolderService, watchFolder } from "@/services/indexer";
import { FolderSchema, IdSchema, ListSchema } from "./shared";

// Folder management
export const scanFolder = os.input(FolderSchema).handler(async ({ input }) => {
  // Send scan progress to all renderer windows
  const result = await scanFolderService(input.path, (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scan-progress", progress);
    }
  });

  // Start watching the newly added folder for future file changes
  watchFolder(input.path, (photoId, event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("file-change", { type: event, photoId });
    }
  });

  // Auto-trigger AI embedding for newly scanned photos (fire-and-forget)
  if (result.photoIds.length > 0) {
    embedAllPhotos()
      .then((count) => {
        if (count > 0) {
          console.log(`[AI] Auto-embedding after scan: ${count} photos processed`);
        }
      })
      .catch((err) => {
        console.warn("[AI] Auto-embedding after scan failed:", err?.message);
      });
  }

  return result;
});

export const getFolders = os.handler(() => {
  const db = getDatabase();
  return db.select().from(folders).orderBy(desc(folders.lastScannedAt)).all();
});

export const deleteFolder = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const folder = db
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.id, input.id))
    .get();
  if (folder) {
    const folderPhotoIds = db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.folderId, input.id))
      .all()
      .map((p) => p.id);

    const escapedPath = folder.path.replace(/'/g, "''");
    const normalizedPath = escapedPath.replace(/\\/g, "/");
    const orphanPhotoIds = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        sql`(${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (
          SELECT id FROM folders
        )) AND REPLACE(${photos.path}, '\\', '/') LIKE ${normalizedPath + "/%"}`
      )
      .all()
      .map((p) => p.id);
    const allPhotoIds = [...new Set([...folderPhotoIds, ...orphanPhotoIds])];

    if (allPhotoIds.length > 0) {
      db.delete(exifData).where(inArray(exifData.photoId, allPhotoIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, allPhotoIds)).run();
      db.delete(photos).where(inArray(photos.id, allPhotoIds)).run();
      deletePhotoVectors(allPhotoIds).catch((err) =>
        console.error("[AI] deleteFolder vector cleanup failed:", err)
      );
    }

    db.delete(folders).where(eq(folders.id, input.id)).run();
  }
  return { success: true };
});

// Photo listing
export const listPhotos = os.input(ListSchema).handler(({ input }) => {
  const db = getDatabase();
  const { folderId, tagId, search, favoriteOnly, sort, order, offset, limit } = input;

  let query = db.select().from(photos).$dynamic();

  // Always exclude soft-deleted photos
  const conditions: ReturnType<typeof isNull>[] = [isNull(photos.deletedAt)];

  if (folderId) {
    conditions.push(eq(photos.folderId, folderId) as any);
  }
  if (tagId) {
    conditions.push(
      sql`${photos.id} IN (SELECT photo_id FROM photo_tags WHERE tag_id = ${tagId})` as any
    );
  }
  if (search) {
    conditions.push(like(photos.filename, `%${search}%`) as any);
  }
  if (favoriteOnly) {
    conditions.push(eq(photos.isFavorite, true) as any);
  }

  query = query.where(and(...conditions));

  const sortCol =
    sort === "name"
      ? photos.filename
      : sort === "size"
        ? photos.fileSize
        : photos.fileDate;
  query = query.orderBy(order === "asc" ? sortCol : desc(sortCol));

  // Build filtered count query with same conditions
  let countQuery = db
    .select({ count: sql<number>`count(*)` })
    .from(photos)
    .$dynamic();
  countQuery = countQuery.where(and(...conditions));
  const total = countQuery.get()?.count || 0;
  const items = query.limit(limit).offset(offset).all();

  return { items, total, offset, limit };
});

// Photo detail
export const getPhotoDetail = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const photo = db.select().from(photos).where(eq(photos.id, input.id)).get();
  return photo || null;
});

export const getPhotoExif = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  return (
    db.select().from(exifData).where(eq(exifData.photoId, input.id)).get() ||
    null
  );
});
