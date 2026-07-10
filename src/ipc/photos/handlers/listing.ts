import fs from "node:fs";
import path from "node:path";
import { ORPCError, os } from "@orpc/server";
import { and, desc, eq, inArray, isNull, like, sql } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import {
  exifData,
  faceIdentities,
  faceIdentityMembers,
  folders,
  photos,
  photoTags,
  tags,
} from "@/db/schema";

const GLOB_WILDCARD_RE = /[*?[]/;
import { deletePhotoVectors } from "@/services/ai-embedder";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import {
  cancelAllImports,
  cancelQueuedImports,
  enqueueImport,
  getImportQueueStatus,
} from "@/services/import-queue";
import { deletePhotoThumbnails } from "@/services/thumbnailer";
import { FolderSchema, IdSchema, ListSchema } from "./shared";

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

// ── Import Queue — sequential folder import ───────────────────────

/**
 * Enqueue a folder for import. Returns immediately so the frontend
 * is not blocked while scanning and AI embedding run in the background.
 */
export const scanFolder = os.input(FolderSchema).handler(({ input }) => {
  try {
    const resolved = path.resolve(input.path);
    if (!fs.existsSync(resolved)) {
      throw new ORPCError("BAD_REQUEST", {
        message: `Folder does not exist: ${resolved}`,
      });
    }

    const task = enqueueImport(resolved);
    return { status: task.status, position: task.position, id: task.id };
  } catch (err) {
    logIpcError("scanFolder", err);
    const message = (err as Error)?.message ?? String(err);
    if (err instanceof ORPCError) {
      throw err;
    }
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message });
  }
});

export const stopScanning = os.handler(() => {
  cancelAllImports();
  return { stopped: true };
});

/** Get current import queue status (pending, running, history). */
export const getImportQueueStatus_h = os.handler(() => {
  return getImportQueueStatus();
});

/** Cancel all queued (not-yet-started) imports without affecting the running one. */
export const cancelQueuedImports_h = os.handler(() => {
  const cancelled = cancelQueuedImports();
  return { cancelled: cancelled.length };
});

export const getFolders = os.handler(() => {
  const db = getDatabase();
  const allFolders = db
    .select()
    .from(folders)
    .orderBy(desc(folders.lastScannedAt))
    .all();

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
    if (cached !== undefined) {
      return cached;
    }

    const folder = allFolders.find((f) => f.id === folderId);
    if (!folder) {
      return 0;
    }

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
      if (visited.has(child.id)) {
        continue; // cycle guard
      }
      visited.add(child.id);
      descendantIds.push(child.id);
      queue.push(child.id);
    }
  }

  const allFolderIds = [input.id, ...descendantIds];

  // 2) Collect all photos belonging to any of these folders.
  //    This includes both active and soft-deleted photos — when the original
  //    folder is removed, trashed photos have nothing to restore, so they are
  //    hard-deleted together with active ones.
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
      )) AND REPLACE(${photos.path}, '\\', '/') LIKE ${`${normalizedPath}/%`}`
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

  // 4b) Clean up face identities orphaned by cascade deletion
  if (allPhotoIds.length > 0) {
    // Delete identities that no longer have any members
    const emptyIds = db
      .select({ id: faceIdentities.id })
      .from(faceIdentities)
      .leftJoin(
        faceIdentityMembers,
        eq(faceIdentityMembers.identityId, faceIdentities.id)
      )
      .where(sql`${faceIdentityMembers.faceVectorId} IS NULL`)
      .all()
      .map((r) => r.id);
    if (emptyIds.length > 0) {
      db.delete(faceIdentities)
        .where(inArray(faceIdentities.id, emptyIds))
        .run();
    }
    // Recalculate faceCount for identities that still have members
    db.run(
      sql`UPDATE face_identities SET face_count = (
        SELECT COUNT(DISTINCT fv.photo_id) FROM face_identity_members fim
        JOIN face_vectors fv ON fv.id = fim.face_vector_id
        WHERE fim.identity_id = face_identities.id
      )`
    );
  }

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

  // 7) Flush COUNT cache so the frontend sees the updated total immediately
  invalidateCountCache();

  return { success: true };
});

// ── Total COUNT cache ───────────────────────────────────────────────
// 避免每次翻页在数十万行表上执行 COUNT(*)，TTL 10 秒内复用上次结果。
// 大规模导入完成后应调用 invalidateCountCache() 立即刷新。
const COUNT_CACHE_TTL = 10_000;
const MAX_COUNT_CACHE = 50;

/** 清空 COUNT 缓存，在导入/删除大批量照片后调用以确保计数即时准确。 */
export function invalidateCountCache(): void {
  totalCache.clear();
}
const totalCache = new Map<string, { value: number; timestamp: number }>();

// Photo listing
export const listPhotos = os.input(ListSchema).handler(({ input }) => {
  const db = getDatabase();
  const {
    folderId,
    tagId,
    tagIds,
    tagMode,
    search,
    favoriteOnly,
    sort,
    order,
    offset,
    limit,
  } = input;

  // 显式字段选择：排除 phash / contentHash / vectorId 等瀑布流不用的重型字段，
  // 每条照片节省约 116+ bytes 的结构化克隆传输
  let query = db
    .select({
      id: photos.id,
      path: photos.path,
      folderId: photos.folderId,
      filename: photos.filename,
      fileSize: photos.fileSize,
      fileDate: photos.fileDate,
      width: photos.width,
      height: photos.height,
      format: photos.format,
      thumbnailPath: photos.thumbnailPath,
      dominantColors: photos.dominantColors,
      isFavorite: photos.isFavorite,
      isIndexed: photos.isIndexed,
      isAiProcessed: photos.isAiProcessed,
      isFaceProcessed: photos.isFaceProcessed,
    })
    .from(photos)
    .$dynamic();

  // Always exclude soft-deleted photos
  const conditions: ReturnType<typeof isNull>[] = [isNull(photos.deletedAt)];

  if (folderId) {
    conditions.push(eq(photos.folderId, folderId) as any);
  }

  // Multi-tag filtering with AND/OR support
  // Backward compat: if tagId is provided without tagIds, treat as single-tag OR
  const effectiveTagIds =
    tagIds && tagIds.length > 0 ? tagIds : tagId == null ? null : [tagId];
  const effectiveTagMode =
    tagIds && tagIds.length > 0 ? (tagMode ?? "or") : "or";

  if (effectiveTagIds && effectiveTagIds.length > 0) {
    // Collect all descendant tag IDs for each root tag
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

    // Collect descendants for each root tag ID
    const rootDescendantSets: Set<number>[] = [];
    for (const rootId of effectiveTagIds) {
      const descendantIds = new Set<number>();
      const visited = new Set<number>();
      (function collect(pid: number) {
        if (visited.has(pid)) {
          return;
        }
        visited.add(pid);
        descendantIds.add(pid);
        const kids = childrenMap.get(pid);
        if (kids) {
          for (const kid of kids) {
            collect(kid);
          }
        }
      })(rootId);
      rootDescendantSets.push(descendantIds);
    }

    if (effectiveTagMode === "or") {
      // OR mode: photo must have at least one tag from the merged descendant set
      const allDescendantIds = new Set<number>();
      for (const set of rootDescendantSets) {
        for (const id of set) {
          allDescendantIds.add(id);
        }
      }
      const idList = [...allDescendantIds].join(",");
      conditions.push(
        sql`${photos.id} IN (SELECT pt.photo_id FROM photo_tags pt WHERE pt.tag_id IN (${sql.raw(idList)}))` as any
      );
    } else {
      // AND mode: photo must have at least one tag from each root tag's descendant set
      for (const descendantSet of rootDescendantSets) {
        const idList = [...descendantSet].join(",");
        conditions.push(
          sql`EXISTS (SELECT 1 FROM photo_tags pt WHERE pt.photo_id = ${photos.id} AND pt.tag_id IN (${sql.raw(idList)}))` as any
        );
      }
    }
  }
  if (search) {
    if (GLOB_WILDCARD_RE.test(search)) {
      conditions.push(
        sql`LOWER(${photos.filename}) GLOB LOWER(${search})` as any
      );
    } else {
      conditions.push(like(photos.filename, `%${search}%`) as any);
    }
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

  // Build cache key from filter-relevant params (excluding sort/order/offset/limit)
  const countCacheKey = JSON.stringify({
    folderId: folderId ?? null,
    tagId: tagId ?? null,
    tagIds: effectiveTagIds ?? null,
    tagMode: effectiveTagMode,
    search: search ?? null,
    favoriteOnly: favoriteOnly ?? null,
  });

  let total: number;
  const cachedTotal = totalCache.get(countCacheKey);
  if (cachedTotal && Date.now() - cachedTotal.timestamp < COUNT_CACHE_TTL) {
    total = cachedTotal.value;
  } else {
    // Build filtered count query with same conditions
    let countQuery = db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .$dynamic();
    countQuery = countQuery.where(and(...conditions));
    total = countQuery.get()?.count || 0;

    // Evict oldest entry if at capacity, then store
    if (totalCache.size >= MAX_COUNT_CACHE) {
      const lru = totalCache.keys().next().value;
      if (lru !== undefined) {
        totalCache.delete(lru);
      }
    }
    totalCache.set(countCacheKey, { value: total, timestamp: Date.now() });
  }
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
