import fs from "node:fs";
import path from "node:path";
import { ORPCError, os } from "@orpc/server";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { app, BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags, tags } from "@/db/schema";
import { deletePhotoVectors, embedAllPhotos } from "@/services/ai-embedder";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import { deletePhotoThumbnails } from "@/services/thumbnailer";
import {
  scanFolder as scanFolderService,
  watchFolder,
} from "@/services/indexer";
import { FolderSchema, IdSchema, ListSchema } from "./shared";
import { invalidateStatsCache } from "./stats";

function logIpcError(handlerName: string, err: unknown): void {
  try {
    const logDir = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDir, { recursive: true });
    const e = err as { message?: string; stack?: string };
    const detail = e?.stack ?? e?.message ?? String(err);
    fs.writeFileSync(
      path.join(logDir, "ipc-error.log"),
      `${new Date().toISOString()} [${handlerName}] ${detail}\n\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

// Folder management
export const scanFolder = os.input(FolderSchema).handler(async ({ input }) => {
  try {
    const result = await scanFolderService(input.path, (progress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("scan-progress", progress);
      }
    });

    watchFolder(input.path, (photoId, event) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("file-change", { type: event, photoId });
      }
    });

    if (result.photoIds.length > 0) {
      embedAllPhotos((aiProgress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("ai-progress", aiProgress);
        }
      })
        .then((count) => {
          if (count > 0) {
            console.log(
              `[AI] Auto-embedding after scan: ${count} photos processed`
            );
          }
        })
        .catch((err) => {
          console.warn("[AI] Auto-embedding after scan failed:", err?.message);
        });
    }

    invalidateStatsCache();
    return result;
  } catch (err) {
    logIpcError("scanFolder", err);
    const message = (err as Error)?.message ?? String(err);
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
  }
});

export const getFolders = os.handler(() => {
  const db = getDatabase();
  const allFolders = db.select().from(folders).orderBy(desc(folders.lastScannedAt)).all();

  // Build children map for recursive count computation
  const childrenMap = new Map<number, number[]>();
  for (const f of allFolders) {
    if (f.parentId != null) {
      const list = childrenMap.get(f.parentId);
      if (list) {
        list.push(f.id);
      } else {
        childrenMap.set(f.parentId, [f.id]);
      }
    }
  }

  // Compute recursive totalPhotoCount per folder
  const recursiveCache = new Map<number, number>();
  function computeRecursive(folderId: number): number {
    const cached = recursiveCache.get(folderId);
    if (cached !== undefined) return cached;

    const folder = allFolders.find((f) => f.id === folderId);
    if (!folder) return 0;

    let total = folder.photoCount;
    const children = childrenMap.get(folderId);
    if (children) {
      for (const childId of children) {
        total += computeRecursive(childId);
      }
    }
    recursiveCache.set(folderId, total);
    return total;
  }

  return allFolders.map((f) => ({
    ...f,
    totalPhotoCount: computeRecursive(f.id),
  }));
});

export const deleteFolder = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const folder = db
    .select({ id: folders.id, path: folders.path })
    .from(folders)
    .where(eq(folders.id, input.id))
    .get();
  if (!folder) {
    return { success: true };
  }

  // 1) Recursively collect all descendant folder IDs via parentId chain (BFS + cycle detection)
  const descendantIds: number[] = [];
  const visited = new Set<number>([input.id]);
  const queue = [input.id];
  while (queue.length > 0) {
    const currentId = queue.shift()!;
    const children = db
      .select({ id: folders.id })
      .from(folders)
      .where(eq(folders.parentId, currentId))
      .all();
    for (const child of children) {
      if (visited.has(child.id)) continue; // cycle guard
      visited.add(child.id);
      descendantIds.push(child.id);
      queue.push(child.id);
    }
  }

  const allFolderIds = [input.id, ...descendantIds];

  // 2) Collect all photos belonging to any of these folders
  const folderPhotos = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(inArray(photos.folderId, allFolderIds))
    .all();
  const folderPhotoIds = folderPhotos.map((p) => p.id);

  // 3) Also catch orphan photos under the folder path that have no valid folderId
  const escapedPath = folder.path.replace(/'/g, "''");
  const normalizedPath = escapedPath.replace(/\\/g, "/");
  const orphanPhotos = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(
      sql`(${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (
        SELECT id FROM folders
      )) AND REPLACE(${photos.path}, '\\', '/') LIKE ${normalizedPath + "/%"}`
    )
    .all();
  const orphanPhotoIds = orphanPhotos.map((p) => p.id);

  const allPhotoIds = [...new Set([...folderPhotoIds, ...orphanPhotoIds])];
  const allPhotoPaths = [...folderPhotos, ...orphanPhotos].map((p) => p.path);

  // 4) Execute deletions in a transaction
  // parent_id FK uses ON DELETE SET NULL, so deletion order is safe in any direction
  db.transaction(() => {
    if (allPhotoIds.length > 0) {
      db.delete(exifData).where(inArray(exifData.photoId, allPhotoIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, allPhotoIds)).run();
      db.delete(photos).where(inArray(photos.id, allPhotoIds)).run();
    }

    for (const fid of descendantIds) {
      db.delete(folders).where(eq(folders.id, fid)).run();
    }

    db.delete(folders).where(eq(folders.id, input.id)).run();
  });

  // 5) Clean up thumbnails, AI vectors (outside transaction, best-effort)
  for (const p of allPhotoPaths) {
    deletePhotoThumbnails(p);
  }
  if (allPhotoIds.length > 0) {
    deletePhotoVectors(allPhotoIds).catch((err) =>
      console.error("[AI] deleteFolder vector cleanup failed:", err)
    );
  }

  // 6) Reload folder matcher so watchers pick up the change
  reloadFolderMatcher();

  return { success: true };
});

// Photo listing
export const listPhotos = os.input(ListSchema).handler(({ input }) => {
  const db = getDatabase();
  const { folderId, tagId, search, favoriteOnly, sort, order, offset, limit } =
    input;

  let query = db.select().from(photos).$dynamic();

  // Always exclude soft-deleted photos
  const conditions: ReturnType<typeof isNull>[] = [isNull(photos.deletedAt)];

  if (folderId) {
    conditions.push(eq(photos.folderId, folderId) as any);
  }
  if (tagId) {
    // Collect all descendant tag IDs (self + children recursively)
    const allTags = db.select().from(tags).all();
    const childrenMap = new Map<number, number[]>();
    for (const t of allTags) {
      if (t.parentId != null) {
        const list = childrenMap.get(t.parentId);
        if (list) {
          list.push(t.id);
        } else {
          childrenMap.set(t.parentId, [t.id]);
        }
      }
    }
    const descendantIds: number[] = [];
    const visited = new Set<number>();
    (function collect(pid: number) {
      if (visited.has(pid)) {
        return;
      }
      visited.add(pid);
      descendantIds.push(pid);
      const kids = childrenMap.get(pid);
      if (kids) {
        for (const kid of kids) {
          collect(kid);
        }
      }
    })(tagId);

    const idList = descendantIds.join(",");
    conditions.push(
      sql`${photos.id} IN (SELECT pt.photo_id FROM photo_tags pt WHERE pt.tag_id IN (${sql.raw(idList)}))` as any
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
