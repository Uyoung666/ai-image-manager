import { os } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  folders,
  photos,
} from "@/db/schema";
import { BKTree, hammingDistance } from "@/services/bk-tree";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import { getSetting } from "@/services/settings-manager";
import {
  generateDuelPreview,
  getDuelPreviewStrategy,
} from "@/services/thumbnailer";
import {
  bkTreeCaches,
  clearCullCaches,
  clearCullPairCaches,
  comparedPairCaches,
  curateOrderCaches,
  type SimPair,
  setBoundedCullCache,
  similarityCaches,
} from "./cache";

import { computeElo, PK_MODE_CONFIG } from "./elo";
import {
  buildPairItem,
  loadPendingWithMetadata,
  type PendingRow,
  selectPhotoFields,
} from "./queries";
import {
  BatchUpdatePhotoStatusSchema,
  CreateSessionSchema,
  GetNextPairSchema,
  RecordSkipSchema,
  SessionIdSchema,
  SubmitComparisonSchema,
  UpdatePhotoStatusSchema,
} from "./schemas";
import { getCullProgressDelta } from "./state";

const SQLITE_ID_CHUNK_SIZE = 500;

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function loadActivePhotoIds(ids: number[]): number[] {
  const db = getDatabase();
  const result: number[] = [];
  for (let index = 0; index < ids.length; index += SQLITE_ID_CHUNK_SIZE) {
    const chunk = ids.slice(index, index + SQLITE_ID_CHUNK_SIZE);
    result.push(
      ...db
        .select({ id: photos.id })
        .from(photos)
        .where(and(inArray(photos.id, chunk), isNull(photos.deletedAt)))
        .all()
        .map((photo) => photo.id)
    );
  }
  return result;
}

function syncKeptWithFavorites(): boolean {
  return getSetting("cull.syncKeptWithFavorites") !== "false";
}

export const createSession = os
  .input(CreateSessionSchema)
  .handler(({ input }) => {
    const db = getDatabase();

    let allPhotoIds = uniqueIds(input.photoIds);

    // If folderId is provided, load non-deleted photos from its entire subtree.
    if (input.folderId && allPhotoIds.length === 0) {
      const folderHierarchy = db
        .select({ id: folders.id, parentId: folders.parentId })
        .from(folders)
        .all();
      const folderIds = getFolderSubtreeIds(folderHierarchy, input.folderId);
      const folderPhotos = db
        .select({ id: photos.id })
        .from(photos)
        .where(
          and(
            folderIds.length > 0
              ? inArray(photos.folderId, folderIds)
              : eq(photos.folderId, input.folderId),
            isNull(photos.deletedAt)
          )
        )
        .all();
      allPhotoIds = folderPhotos.map((p) => p.id);
    } else if (allPhotoIds.length > 0) {
      // Exclude soft-deleted photos from explicit photoIds
      allPhotoIds = loadActivePhotoIds(allPhotoIds);
    }

    if (allPhotoIds.length < 2) {
      throw new Error("至少需要 2 张照片才能创建选片会话");
    }

    const sessionId = db.transaction(() => {
      const result = db
        .insert(cullSessions)
        .values({
          name: input.name,
          mode: input.mode,
          pkMode: input.pkMode,
          sortStrategy: input.sortStrategy,
          totalPhotos: allPhotoIds.length,
        })
        .run();
      const createdSessionId = Number(result.lastInsertRowid);

      for (
        let index = 0;
        index < allPhotoIds.length;
        index += SQLITE_ID_CHUNK_SIZE
      ) {
        const batch = allPhotoIds.slice(index, index + SQLITE_ID_CHUNK_SIZE);
        db.insert(cullSessionPhotos)
          .values(
            batch.map((photoId) => ({ sessionId: createdSessionId, photoId }))
          )
          .run();
      }
      return createdSessionId;
    });

    return db
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, sessionId))
      .get();
  });

export const addPhotosToSession = os
  .input(
    z.object({
      sessionId: z.number().int().positive(),
      photoIds: z.array(z.number().int().positive()).min(1),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const session = db
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (!session) {
      throw new Error("选片会话不存在");
    }
    if (session.status === "completed") {
      throw new Error("请先恢复已完成的选片会话");
    }

    let added = 0;
    db.transaction(() => {
      const existingPhotos = db
        .select({ photoId: cullSessionPhotos.photoId })
        .from(cullSessionPhotos)
        .where(eq(cullSessionPhotos.sessionId, input.sessionId))
        .all();
      const existingSet = new Set(existingPhotos.map((p) => p.photoId));

      const requestedIds = uniqueIds(input.photoIds);
      const activeIds = new Set(loadActivePhotoIds(requestedIds));
      const newPhotoIds = requestedIds.filter(
        (id) => activeIds.has(id) && !existingSet.has(id)
      );

      const batchSize = 500;
      for (let i = 0; i < newPhotoIds.length; i += batchSize) {
        const batch = newPhotoIds.slice(i, i + batchSize);
        db.insert(cullSessionPhotos)
          .values(
            batch.map((photoId) => ({ sessionId: input.sessionId, photoId }))
          )
          .run();
      }

      added = newPhotoIds.length;
      if (added > 0) {
        db.update(cullSessions)
          .set({ totalPhotos: sql`${cullSessions.totalPhotos} + ${added}` })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    });

    if (added > 0) {
      clearCullCaches(input.sessionId);
    }

    return { success: true, addedCount: added };
  });

export const recordSkip = os.input(RecordSkipSchema).handler(({ input }) => {
  const db = getDatabase();
  const session = db
    .select({ status: cullSessions.status })
    .from(cullSessions)
    .where(eq(cullSessions.id, input.sessionId))
    .get();
  if (session?.status === "completed") {
    return { success: false, reason: "选片会话已结束" };
  }
  const pairRows = db
    .select({ id: cullSessionPhotos.id })
    .from(cullSessionPhotos)
    .where(
      and(
        eq(cullSessionPhotos.sessionId, input.sessionId),
        inArray(cullSessionPhotos.id, [input.photoAId, input.photoBId])
      )
    )
    .all();
  if (pairRows.length !== 2) {
    throw new Error("照片不在当前选片会话中");
  }
  db.insert(cullActionLogs)
    .values({
      sessionId: input.sessionId,
      action: "skip",
      payload: JSON.stringify({
        photoAId: input.photoAId,
        photoBId: input.photoBId,
      }),
    })
    .run();
  return { success: true };
});

export const listSessions = os.handler(() => {
  const db = getDatabase();
  const sessions = db
    .select()
    .from(cullSessions)
    .orderBy(desc(cullSessions.createdAt))
    .all();
  const counts = db
    .select({
      sessionId: cullSessionPhotos.sessionId,
      count: sql<number>`count(case when ${photos.deletedAt} is null then 1 end)`,
    })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .groupBy(cullSessionPhotos.sessionId)
    .all();
  const countBySession = new Map(
    counts.map((row) => [row.sessionId, row.count])
  );
  return sessions.map((session) => ({
    ...session,
    totalPhotos: countBySession.get(session.id) ?? 0,
  }));
});

export const getSession = os.input(SessionIdSchema).handler(({ input }) => {
  const db = getDatabase();
  const session = db
    .select()
    .from(cullSessions)
    .where(eq(cullSessions.id, input.sessionId))
    .get();
  if (!session) {
    throw new Error("选片会话不存在");
  }

  const items = db
    .select({
      id: cullSessionPhotos.id,
      rating: cullSessionPhotos.rating,
      comparisons: cullSessionPhotos.comparisons,
      wins: cullSessionPhotos.wins,
      losses: cullSessionPhotos.losses,
      status: cullSessionPhotos.status,
      photo: selectPhotoFields(),
    })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .where(
      and(
        eq(cullSessionPhotos.sessionId, input.sessionId),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(desc(cullSessionPhotos.rating))
    .all();

  // Dynamic COUNT — the static cullSessions.totalPhotos drifts when
  // photos are cascade-deleted externally (e.g. file-system removal)
  // or soft-deleted (moved to trash).
  const actualCount = db
    .select({ count: sql<number>`count(*)` })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .where(
      and(
        eq(cullSessionPhotos.sessionId, input.sessionId),
        isNull(photos.deletedAt)
      )
    )
    .get();

  return { ...session, totalPhotos: actualCount?.count ?? 0, items };
});

export const getSessionSummary = os
  .input(SessionIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const session = db
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (!session) {
      throw new Error("选片会话不存在");
    }
    const counts = db
      .select({
        totalPhotos: sql<number>`count(*)`,
        keptCount: sql<number>`sum(case when ${cullSessionPhotos.status} = 'kept' then 1 else 0 end)`,
        rejectedCount: sql<number>`sum(case when ${cullSessionPhotos.status} = 'rejected' then 1 else 0 end)`,
        pendingCount: sql<number>`sum(case when ${cullSessionPhotos.status} = 'pending' then 1 else 0 end)`,
      })
      .from(cullSessionPhotos)
      .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
      .where(
        and(
          eq(cullSessionPhotos.sessionId, input.sessionId),
          isNull(photos.deletedAt)
        )
      )
      .get();
    return {
      ...session,
      totalPhotos: counts?.totalPhotos ?? 0,
      keptCount: counts?.keptCount ?? 0,
      rejectedCount: counts?.rejectedCount ?? 0,
      pendingCount: counts?.pendingCount ?? 0,
    };
  });

export const deleteSession = os.input(SessionIdSchema).handler(({ input }) => {
  const db = getDatabase();
  db.transaction(() => {
    db.delete(cullSessions).where(eq(cullSessions.id, input.sessionId)).run();
  });
  clearCullCaches(input.sessionId);
  return { success: true };
});

// ── 对比预览懒生成 ──────────────────────────────────────────────

export const ensureDuelPreview = os
  .input(z.object({ photoId: z.number().int().positive() }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const photo = db
      .select({
        path: photos.path,
        width: photos.width,
        height: photos.height,
        format: photos.format,
        duelPreviewPath: photos.duelPreviewPath,
      })
      .from(photos)
      .where(and(eq(photos.id, input.photoId), isNull(photos.deletedAt)))
      .get();

    if (!photo) {
      throw new Error("照片不存在");
    }

    // 已有对比预览（或已标记为直接用原图）→ 直接返回
    if (photo.duelPreviewPath) {
      return { duelPreviewPath: photo.duelPreviewPath };
    }

    const _longEdge = Math.max(photo.width ?? 0, photo.height ?? 0);
    const strategy = getDuelPreviewStrategy(
      photo.path,
      photo.width ?? 0,
      photo.height ?? 0,
      photo.format ?? ""
    );

    if (strategy === "use_original") {
      // 小文件直接用原图，无需生成预览
      return { duelPreviewPath: null, strategy: "use_original" };
    }

    const preview = await generateDuelPreview(photo.path);
    if (preview) {
      db.update(photos)
        .set({ duelPreviewPath: preview.previewPath })
        .where(eq(photos.id, input.photoId))
        .run();
      return { duelPreviewPath: preview.previewPath };
    }

    return { duelPreviewPath: null };
  });

function sortBySimilarityGroups(pending: PendingRow[]): PendingRow[] {
  const withPHash = pending.filter(
    (p): p is PendingRow & { phash: NonNullable<PendingRow["phash"]> } =>
      p.phash != null
  );
  if (withPHash.length < 2) {
    return pending.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0));
  }

  const groups: PendingRow[][] = [];
  const visited = new Set<number>();
  const tree = new BKTree();
  const byId = new Map<number, PendingRow>();
  for (const photo of withPHash) {
    tree.insert(photo.id, photo.phash);
    byId.set(photo.id, photo);
  }

  for (const photo of withPHash) {
    if (visited.has(photo.id)) {
      continue;
    }
    const group: PendingRow[] = [photo];
    visited.add(photo.id);

    for (const match of tree.query(photo.phash, 8)) {
      if (visited.has(match.photoId)) {
        continue;
      }
      const other = byId.get(match.photoId);
      if (other) {
        group.push(other);
        visited.add(other.id);
      }
    }
    groups.push(group);
  }

  // 无 pHash 的照片单独一组（排在最后）
  const noPHash = pending.filter((p) => p.phash == null);
  if (noPHash.length > 0) {
    groups.push(noPHash);
  }

  // 组间按首张照片时间排序，组内按时间排序
  return groups
    .sort((a, b) => (a[0].fileDate ?? 0) - (b[0].fileDate ?? 0))
    .flatMap((g) => g.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0)));
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: This handler coordinates the culling pair-selection phases.
export const getNextPair = os.input(GetNextPairSchema).handler(({ input }) => {
  const db = getDatabase();
  const session = db
    .select()
    .from(cullSessions)
    .where(eq(cullSessions.id, input.sessionId))
    .get();
  if (!session) {
    throw new Error("选片会话不存在");
  }

  const pkMode = session.pkMode ?? "standard";
  const config = PK_MODE_CONFIG[pkMode] ?? PK_MODE_CONFIG.standard;

  let pending = loadPendingWithMetadata(input.sessionId);

  // Filter out photos the frontend can't load (prevents infinite retry loop)
  const excludeIds = input.excludeSessionPhotoIds ?? [];
  if (excludeIds.length > 0) {
    const excludeSet = new Set(excludeIds);
    const before = pending.length;
    pending = pending.filter((p) => !excludeSet.has(p.id));
    if (pending.length < before) {
      console.log(
        `[Cull] getNextPair: excluded ${before - pending.length} unloadable photo(s), ${pending.length} remaining`
      );
    }
  }

  const curateTotal =
    session.mode === "curate"
      ? (db
          .select({ count: sql<number>`count(*)` })
          .from(cullSessionPhotos)
          .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
          .where(
            and(
              eq(cullSessionPhotos.sessionId, input.sessionId),
              isNull(photos.deletedAt)
            )
          )
          .get()?.count ?? 0)
      : pending.length;
  const stats = {
    total: curateTotal,
    completed: session.completedComparisons,
    remaining: pending.length,
  };

  // Completed sessions always return done
  if (session.status === "completed") {
    return { done: true, stats };
  }

  if (session.mode === "curate") {
    if (pending.length === 0) {
      return { done: true, stats };
    }

    const strategy = session.sortStrategy ?? "time";
    let sorted = [...pending];

    if (strategy === "similarity") {
      let orderCache = curateOrderCaches.get(input.sessionId);
      if (!orderCache) {
        orderCache = {
          orderedIds: sortBySimilarityGroups([...pending]).map(
            (photo) => photo.id
          ),
        };
        setBoundedCullCache(curateOrderCaches, input.sessionId, orderCache);
      }
      const pendingById = new Map(pending.map((photo) => [photo.id, photo]));
      sorted = orderCache.orderedIds
        .map((id) => pendingById.get(id))
        .filter((photo): photo is PendingRow => photo !== undefined);
      if (sorted.length !== pending.length) {
        clearCullCaches(input.sessionId);
        sorted = sortBySimilarityGroups([...pending]);
        setBoundedCullCache(curateOrderCaches, input.sessionId, {
          orderedIds: sorted.map((photo) => photo.id),
        });
      }
    } else {
      sorted.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0));
    }

    const item = sorted[0];

    let similarCount = 0;
    const itemPHash = item.phash;
    if (itemPHash) {
      similarCount = pending.filter((p) => {
        const pHash = p.phash;
        return (
          pHash != null &&
          p.id !== item.id &&
          hammingDistance(itemPHash, pHash) <= 8
        );
      }).length;
    }

    return {
      done: false,
      single: {
        sessionPhotoId: item.id,
        photo: {
          id: item.photoId,
          filename: item.filename,
          path: item.path,
          width: item.width,
          height: item.height,
          fileSize: item.fileSize,
          format: item.format,
          thumbnailPath: item.thumbnailPath,
          duelPreviewPath: item.duelPreviewPath,
          fileDate: item.fileDate,
          isFavorite: item.isFavorite,
          isIndexed: item.isIndexed,
        },
        rating: item.rating,
        comparisons: item.comparisons,
        wins: item.wins,
        losses: item.losses,
      },
      similarCount,
      stats,
    };
  }

  // Duel mode: find best pair
  if (pending.length < 2) {
    return { done: true, stats };
  }

  const readyCount = pending.filter(
    (p) => p.comparisons >= config.minComparisons
  ).length;

  // All photos compared enough — done (unless recompare is enabled)
  if (readyCount === pending.length && !config.allowRecompare) {
    return {
      done: true,
      stats: { ...stats, ready: readyCount },
    };
  }

  // Incremental comparedPairs cache: only load new logs since last check.
  // Uses cullActionLogs.id (auto-increment) to avoid re-loading the entire
  // log history on every getNextPair call — critical for fine-mode sessions
  // with thousands of comparisons.
  let pairCache = comparedPairCaches.get(input.sessionId);
  const minLogId = pairCache ? pairCache.maxLogId : 0;

  interface LogRow {
    id: number;
    payload: string;
  }
  const newComparedLogs = db
    .select({ id: cullActionLogs.id, payload: cullActionLogs.payload })
    .from(cullActionLogs)
    .where(
      and(
        eq(cullActionLogs.sessionId, input.sessionId),
        sql`${cullActionLogs.action} IN ('compare', 'draw')`,
        pairCache ? sql`${cullActionLogs.id} > ${minLogId}` : undefined
      )
    )
    .orderBy(asc(cullActionLogs.id))
    .all() as LogRow[];

  if (pairCache) {
    // Append new pairs to existing cache
    for (const log of newComparedLogs) {
      try {
        const p = JSON.parse(log.payload);
        const idA = p.winnerId;
        const idB = p.loserId;
        if (!(idA && idB)) {
          continue;
        }
        pairCache.set.add(`${idA}-${idB}`);
        pairCache.set.add(`${idB}-${idA}`);
        pairCache.latestKey = `${idA}-${idB}`;
        pairCache.maxLogId = Math.max(pairCache.maxLogId, log.id);
      } catch {
        /* skip */
      }
    }
  } else {
    // First call: load all existing logs
    const allLogs = db
      .select({ id: cullActionLogs.id, payload: cullActionLogs.payload })
      .from(cullActionLogs)
      .where(
        and(
          eq(cullActionLogs.sessionId, input.sessionId),
          sql`${cullActionLogs.action} IN ('compare', 'draw')`
        )
      )
      .orderBy(asc(cullActionLogs.id))
      .all() as LogRow[];

    const set = new Set<string>();
    let latestKey: string | null = null;
    let maxId = 0;
    for (const log of allLogs) {
      try {
        const p = JSON.parse(log.payload);
        const idA = p.winnerId;
        const idB = p.loserId;
        if (!(idA && idB)) {
          continue;
        }
        latestKey = `${idA}-${idB}`;
        set.add(latestKey);
        set.add(`${idB}-${idA}`);
        maxId = Math.max(maxId, log.id);
      } catch {
        /* skip */
      }
    }
    pairCache = { set, latestKey, maxLogId: maxId };
    setBoundedCullCache(comparedPairCaches, input.sessionId, pairCache);
  }

  const comparedPairs = pairCache.set;
  const latestActionPair = pairCache.latestKey;

  // b) Payload-only query for recent skips with cooldown limit
  const baseCooldown = Math.min(pending.length * 2, config.minComparisons * 4);
  const skipPayloads = db
    .select({ payload: cullActionLogs.payload })
    .from(cullActionLogs)
    .where(
      and(
        eq(cullActionLogs.sessionId, input.sessionId),
        eq(cullActionLogs.action, "skip")
      )
    )
    .orderBy(desc(cullActionLogs.createdAt))
    .limit(baseCooldown)
    .all();

  const recentSkipPairs = new Set<string>();
  for (const log of skipPayloads) {
    try {
      const p = JSON.parse(log.payload);
      if (p.photoAId && p.photoBId) {
        recentSkipPairs.add(`${p.photoAId}-${p.photoBId}`);
        recentSkipPairs.add(`${p.photoBId}-${p.photoAId}`);
      }
    } catch {
      // Ignore malformed historical skip payloads.
    }
  }

  function isPairUnavailable(aId: number, bId: number) {
    const key = `${aId}-${bId}`;
    return comparedPairs.has(key) || recentSkipPairs.has(key);
  }

  function isLatestPair(aId: number, bId: number) {
    return (
      latestActionPair === `${aId}-${bId}` ||
      latestActionPair === `${bId}-${aId}`
    );
  }

  // Phase 0: Burst grouping by fileDate (< 2s apart)
  const withDate = pending.filter((p) => p.fileDate != null);
  withDate.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0));
  const burstGroup = new Map<number, number>();
  let groupId = 0;
  for (let i = 0; i < withDate.length; i++) {
    if (i > 0) {
      const prev = withDate[i - 1].fileDate ?? 0;
      const curr = withDate[i].fileDate ?? 0;
      if (curr - prev > 2000) {
        groupId++;
      }
    }
    burstGroup.set(withDate[i].id, groupId);
  }

  // Phase 1: Similarity pairing using pre-computed cache.
  // All similar pairs (distance ≤ 8) are discovered once when the pending
  // phash set is stable, then scanned in O(candidates) per call — eliminating
  // the ~38,000 hammingDistance calls that dominated getNextPair latency.
  const withPHash = pending.filter(
    (p): p is PendingRow & { phash: NonNullable<PendingRow["phash"]> } =>
      p.phash != null
  );
  if (withPHash.length >= 2) {
    const idsHash = withPHash
      .map((p) => p.id)
      .sort((a, b) => a - b)
      .join(",");

    let simCache = similarityCaches.get(input.sessionId);

    if (!simCache || simCache.idsHash !== idsHash) {
      // Build / rebuild: BK-tree query for all photos, collect deduplicated pairs
      let bkCache = bkTreeCaches.get(input.sessionId);
      let bkTree: BKTree;
      let _photoMap: Map<number, PendingRow>;

      if (bkCache && bkCache.idsHash === idsHash) {
        bkTree = bkCache.tree;
        _photoMap = bkCache.photoMap;
      } else {
        const tree = new BKTree();
        const map = new Map<number, PendingRow>();
        for (const photo of withPHash) {
          tree.insert(photo.id, photo.phash);
          map.set(photo.id, photo);
        }
        bkCache = { tree, photoMap: map, idsHash };
        setBoundedCullCache(bkTreeCaches, input.sessionId, bkCache);
        bkTree = tree;
        _photoMap = map;
      }

      // Query all photos once, collect deduplicated similar pairs
      const pairs: SimPair[] = [];
      const seen = new Set<string>();
      for (const photo of withPHash) {
        for (const n of bkTree.query(photo.phash, 8)) {
          if (n.photoId <= photo.id) {
            continue;
          }
          const key = `${photo.id}-${n.photoId}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          pairs.push({ aId: photo.id, bId: n.photoId, distance: n.distance });
        }
      }
      simCache = { pairs, idsHash };
      setBoundedCullCache(similarityCaches, input.sessionId, simCache);
    }

    // Fast path: scan pre-computed pairs, score only valid ones
    interface SimCandidate {
      a: PendingRow;
      b: PendingRow;
      distance: number;
      sameBurst: boolean;
    }
    const candidates: SimCandidate[] = [];
    // Build id→row map for fast lookup (only for photos in the pending set)
    const idToRow = new Map<number, PendingRow>();
    for (const p of withPHash) {
      idToRow.set(p.id, p);
    }

    for (const pair of simCache.pairs) {
      const a = idToRow.get(pair.aId);
      const b = idToRow.get(pair.bId);
      if (!(a && b)) {
        continue; // photo may have dropped out of pending
      }

      if (isPairUnavailable(pair.aId, pair.bId)) {
        continue;
      }
      if (
        a.comparisons >= config.minComparisons &&
        b.comparisons >= config.minComparisons
      ) {
        continue;
      }

      const sameBurst =
        burstGroup.has(pair.aId) &&
        burstGroup.has(pair.bId) &&
        burstGroup.get(pair.aId) === burstGroup.get(pair.bId);

      candidates.push({ a, b, distance: pair.distance, sameBurst });
    }

    if (candidates.length > 0) {
      candidates.sort((x, y) => {
        const burstX = x.sameBurst ? 1 : 0;
        const burstY = y.sameBurst ? 1 : 0;
        if (burstX !== burstY) {
          return burstY - burstX;
        }
        // Prioritize pairs where at least one photo is far from minComparisons
        const needX = Math.max(
          0,
          config.minComparisons - Math.min(x.a.comparisons, x.b.comparisons)
        );
        const needY = Math.max(
          0,
          config.minComparisons - Math.min(y.a.comparisons, y.b.comparisons)
        );
        if (needX !== needY) {
          return needY - needX;
        }
        const scoreX =
          config.similarityWeight * (1 - x.distance / 8) +
          config.ratingWeight * (1 - Math.abs(x.a.rating - x.b.rating) / 400);
        const scoreY =
          config.similarityWeight * (1 - y.distance / 8) +
          config.ratingWeight * (1 - Math.abs(y.a.rating - y.b.rating) / 400);
        return scoreY - scoreX;
      });
      const best = candidates[0];
      console.log(
        `[Cull] Phase 1 (similarity dist=${best.distance}${best.sameBurst ? ", burst" : ""}): paired #${best.a.photoId} vs #${best.b.photoId}`
      );
      return {
        done: false,
        pair: [buildPairItem(best.a), buildPairItem(best.b)],
        stats: { ...stats, ready: readyCount },
        reason: "similarity",
        phase: "similarity",
      };
    }
  }

  // Phase 2: Pair under-compared photos first to reach minComparisons quickly
  {
    const byComps = [...pending].sort(
      (a, b) => a.comparisons - b.comparisons || b.rating - a.rating
    );
    for (let offset = 1; offset < byComps.length; offset++) {
      for (let i = 0; i < byComps.length - offset; i++) {
        const a = byComps[i];
        const b = byComps[i + offset];
        if (
          a.comparisons >= config.minComparisons &&
          b.comparisons >= config.minComparisons
        ) {
          continue;
        }
        if (isPairUnavailable(a.id, b.id)) {
          continue;
        }
        console.log(
          `[Cull] Phase 2 (under-compared, offset=${offset}): paired #${a.photoId}(c=${a.comparisons}) vs #${b.photoId}(c=${b.comparisons})`
        );
        return {
          done: false,
          pair: [buildPairItem(a), buildPairItem(b)],
          stats: { ...stats, ready: readyCount },
          reason: "fill",
          phase: "fill",
        };
      }
    }
  }

  // No pair found by Phase 1/2 (all possible pairs are either already compared
  // or within the skip cooldown).  If there are still under-compared photos,
  // force-pair the two with lowest comparison counts, ignoring skip cooldown.
  {
    const under = pending.filter((p) => p.comparisons < config.minComparisons);
    if (under.length >= 2) {
      under.sort(
        (a, b) => a.comparisons - b.comparisons || b.rating - a.rating
      );
      const a = under[0];
      // Pick the first candidate not in the already-compared set, or fall back to under[1]
      let b = under[1];
      for (let i = 1; i < under.length; i++) {
        if (!comparedPairs.has(`${a.id}-${under[i].id}`)) {
          b = under[i];
          break;
        }
      }
      console.log(
        `[Cull] Phase 2 fallback (all-pairs-blocked, force-repair, pending=${pending.length} under=${under.length}): #${a.photoId}(c=${a.comparisons}) vs #${b.photoId}(c=${b.comparisons})`
      );
      return {
        done: false,
        pair: [buildPairItem(a), buildPairItem(b)],
        stats: { ...stats, ready: readyCount },
        reason: "fill",
        phase: "fill",
      };
    }
  }

  // Phase 3: Swiss-system rating refinement (only while some photos still need comparisons)
  if (
    readyCount >= pending.length * config.swissThreshold &&
    readyCount < pending.length
  ) {
    const byRating = [...pending].sort(
      (a, b) => b.rating - a.rating || a.comparisons - b.comparisons
    );
    for (let offset = 1; offset < byRating.length; offset++) {
      for (let i = 0; i < byRating.length - offset; i++) {
        const a = byRating[i];
        const b = byRating[i + offset];
        if (isPairUnavailable(a.id, b.id)) {
          continue;
        }
        console.log(
          `[Cull] Phase 3 (swiss rating, offset=${offset}): paired #${a.photoId}(r=${a.rating}) vs #${b.photoId}(r=${b.rating})`
        );
        return {
          done: false,
          pair: [buildPairItem(a), buildPairItem(b)],
          stats: { ...stats, ready: readyCount },
          reason: "rating",
          phase: "swiss",
        };
      }
    }
  }

  // Phase 4: Recompare top photos (standard/fine only, when all have enough comparisons)
  if (config.allowRecompare && readyCount === pending.length) {
    // Budget: limit excess comparisons beyond minComparisons requirement.
    // Each recompare pair adds 2 excess (two photos each +1 comparison).
    const totalMin = pending.length * config.minComparisons;
    const totalActual = pending.reduce((sum, p) => sum + p.comparisons, 0);
    const excessComparisons = totalActual - totalMin;
    const maxExcessComparisons =
      Math.ceil(pending.length * config.recompareFactor) * 2;
    if (excessComparisons < maxExcessComparisons) {
      const byRating = [...pending].sort(
        (a, b) => b.rating - a.rating || a.comparisons - b.comparisons
      );
      if (byRating.length >= 2) {
        const a = byRating[0];
        // Find the highest-rated candidate that wasn't the last compared pair
        let b: PendingRow | undefined;
        for (let i = 1; i < byRating.length; i++) {
          if (!isLatestPair(a.id, byRating[i].id)) {
            b = byRating[i];
            break;
          }
        }
        // Fallback: if no non-latest pair found (e.g., only 2 photos),
        // re-compare the only available pair as long as budget allows.
        if (!b && byRating.length >= 2) {
          b = byRating[1];
          console.log(
            `[Cull] Phase 4 (recompare fallback): only ${byRating.length} photos, re-comparing latest pair #${a.photoId} vs #${b.photoId}`
          );
        }
        if (b) {
          console.log(
            `[Cull] Phase 4 (recompare, excess=${excessComparisons}/${maxExcessComparisons}): re-comparing #${a.photoId} vs #${b.photoId}`
          );
          return {
            done: false,
            pair: [buildPairItem(a), buildPairItem(b)],
            stats: { ...stats, ready: readyCount },
            reason: "recompare",
            phase: "recompare",
          };
        }
      }
    }
  }

  return { done: true, stats: { ...stats, ready: readyCount } };
});

export const submitComparison = os
  .input(SubmitComparisonSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const { sessionId, winnerId, loserId, isDraw } = input;

    const result = db.transaction(() => {
      const winner = db
        .select()
        .from(cullSessionPhotos)
        .where(
          and(
            eq(cullSessionPhotos.sessionId, sessionId),
            eq(cullSessionPhotos.id, winnerId)
          )
        )
        .get();
      const loser = db
        .select()
        .from(cullSessionPhotos)
        .where(
          and(
            eq(cullSessionPhotos.sessionId, sessionId),
            eq(cullSessionPhotos.id, loserId)
          )
        )
        .get();

      if (!(winner && loser)) {
        throw new Error("照片不在会话中");
      }

      // Check session status — reject submissions after session is completed
      const session = db
        .select({ status: cullSessions.status })
        .from(cullSessions)
        .where(eq(cullSessions.id, sessionId))
        .get();
      if (session?.status === "completed") {
        throw new Error("选片会话已结束");
      }

      const scoreA = isDraw ? 0.5 : 1;
      const { newRatingA: newWinnerRating, newRatingB: newLoserRating } =
        computeElo(
          winner.rating,
          loser.rating,
          scoreA,
          winner.comparisons,
          loser.comparisons
        );

      if (isDraw) {
        db.update(cullSessionPhotos)
          .set({
            rating: newWinnerRating,
            comparisons: winner.comparisons + 1,
          })
          .where(eq(cullSessionPhotos.id, winnerId))
          .run();

        db.update(cullSessionPhotos)
          .set({
            rating: newLoserRating,
            comparisons: loser.comparisons + 1,
          })
          .where(eq(cullSessionPhotos.id, loserId))
          .run();

        db.insert(cullActionLogs)
          .values({
            sessionId,
            action: "draw",
            payload: JSON.stringify({
              photoAId: winnerId,
              photoBId: loserId,
              photoAOldRating: winner.rating,
              photoBOldRating: loser.rating,
            }),
          })
          .run();
      } else {
        db.update(cullSessionPhotos)
          .set({
            rating: newWinnerRating,
            comparisons: winner.comparisons + 1,
            wins: winner.wins + 1,
          })
          .where(eq(cullSessionPhotos.id, winnerId))
          .run();

        db.update(cullSessionPhotos)
          .set({
            rating: newLoserRating,
            comparisons: loser.comparisons + 1,
            losses: loser.losses + 1,
          })
          .where(eq(cullSessionPhotos.id, loserId))
          .run();

        const delta = newWinnerRating - winner.rating;
        db.insert(cullActionLogs)
          .values({
            sessionId,
            action: "compare",
            payload: JSON.stringify({
              winnerId,
              loserId,
              winnerOldRating: winner.rating,
              loserOldRating: loser.rating,
              ratingDelta: delta,
            }),
          })
          .run();
      }

      db.update(cullSessions)
        .set({
          completedComparisons: sql`completed_comparisons + 1`,
        })
        .where(eq(cullSessions.id, sessionId))
        .run();

      const delta = newWinnerRating - winner.rating;
      return { newWinnerRating, newLoserRating, ratingDelta: delta };
    });

    return result;
  });

export const undoLastAction = os.input(SessionIdSchema).handler(({ input }) => {
  const db = getDatabase();
  const session = db
    .select({ status: cullSessions.status })
    .from(cullSessions)
    .where(eq(cullSessions.id, input.sessionId))
    .get();
  const lastLog = db
    .select()
    .from(cullActionLogs)
    .where(
      and(
        eq(cullActionLogs.sessionId, input.sessionId),
        sql`${cullActionLogs.action} != 'undo'`
      )
    )
    .orderBy(desc(cullActionLogs.id))
    .limit(1)
    .get();

  if (!lastLog) {
    return { success: false, reason: "没有可撤销的操作" };
  }
  if (
    session?.status === "completed" &&
    lastLog.action !== "status" &&
    lastLog.action !== "batchStatus" &&
    lastLog.action !== "kept" &&
    lastLog.action !== "rejected"
  ) {
    return { success: false, reason: "请先恢复会话再撤销对决操作" };
  }

  const payload = JSON.parse(lastLog.payload) as Record<string, unknown>;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Undoing historical actions requires preserving each action format.
  const result = db.transaction(() => {
    if (lastLog.action === "compare" && payload.winnerId && payload.loserId) {
      db.update(cullSessionPhotos)
        .set({
          rating: Number(payload.winnerOldRating),
          comparisons: sql`MAX(comparisons - 1, 0)`,
          wins: sql`MAX(wins - 1, 0)`,
        })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, Number(payload.winnerId))
          )
        )
        .run();
      db.update(cullSessionPhotos)
        .set({
          rating: Number(payload.loserOldRating),
          comparisons: sql`MAX(comparisons - 1, 0)`,
          losses: sql`MAX(losses - 1, 0)`,
        })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, Number(payload.loserId))
          )
        )
        .run();
      db.update(cullSessions)
        .set({ completedComparisons: sql`MAX(completed_comparisons - 1, 0)` })
        .where(eq(cullSessions.id, input.sessionId))
        .run();
    } else if (lastLog.action === "draw") {
      const photoAId = Number(payload.photoAId ?? payload.winnerId);
      const photoBId = Number(payload.photoBId ?? payload.loserId);
      if (!(photoAId && photoBId)) {
        return { success: false, reason: "撤销记录无效" };
      }
      db.update(cullSessionPhotos)
        .set({
          rating: Number(payload.photoAOldRating ?? payload.winnerOldRating),
          comparisons: sql`MAX(comparisons - 1, 0)`,
        })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, photoAId)
          )
        )
        .run();
      db.update(cullSessionPhotos)
        .set({
          rating: Number(payload.photoBOldRating ?? payload.loserOldRating),
          comparisons: sql`MAX(comparisons - 1, 0)`,
        })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, photoBId)
          )
        )
        .run();
      db.update(cullSessions)
        .set({ completedComparisons: sql`MAX(completed_comparisons - 1, 0)` })
        .where(eq(cullSessions.id, input.sessionId))
        .run();
    } else if (lastLog.action === "batchStatus") {
      const entries = (payload.entries ?? []) as Array<{
        id: number;
        photoRefId: number;
        previousStatus: "pending" | "kept" | "rejected";
        newStatus: "pending" | "kept" | "rejected";
        previousFavorite: boolean;
      }>;
      let progressDelta = 0;
      for (const entry of entries) {
        db.update(cullSessionPhotos)
          .set({ status: entry.previousStatus })
          .where(
            and(
              eq(cullSessionPhotos.sessionId, input.sessionId),
              eq(cullSessionPhotos.id, entry.id)
            )
          )
          .run();
        db.update(photos)
          .set({ isFavorite: entry.previousFavorite })
          .where(eq(photos.id, entry.photoRefId))
          .run();
        if (
          entry.newStatus === "pending" &&
          entry.previousStatus !== "pending"
        ) {
          progressDelta += 1;
        } else if (
          entry.newStatus !== "pending" &&
          entry.previousStatus === "pending"
        ) {
          progressDelta -= 1;
        }
      }
      if (progressDelta !== 0) {
        db.update(cullSessions)
          .set({
            completedComparisons: sql`MAX(completed_comparisons + ${progressDelta}, 0)`,
          })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    } else if (lastLog.action === "skipSimilar") {
      const entries = (payload.skippedEntries ?? []) as Array<{
        id: number;
        previousStatus: "pending" | "kept" | "rejected";
      }>;
      for (const entry of entries) {
        db.update(cullSessionPhotos)
          .set({ status: entry.previousStatus })
          .where(
            and(
              eq(cullSessionPhotos.sessionId, input.sessionId),
              eq(cullSessionPhotos.id, entry.id)
            )
          )
          .run();
      }
      const restoredPending = entries.filter(
        (entry) => entry.previousStatus === "pending"
      ).length;
      if (restoredPending > 0) {
        db.update(cullSessions)
          .set({
            completedComparisons: sql`MAX(completed_comparisons - ${restoredPending}, 0)`,
          })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    } else if (
      (lastLog.action === "status" ||
        lastLog.action === "kept" ||
        lastLog.action === "rejected") &&
      payload.photoId
    ) {
      const previousStatus = String(payload.previousStatus);
      const newStatus = String(payload.newStatus ?? lastLog.action);
      db.update(cullSessionPhotos)
        .set({ status: previousStatus })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, Number(payload.photoId))
          )
        )
        .run();
      if (payload.photoRefId && typeof payload.previousFavorite === "boolean") {
        db.update(photos)
          .set({ isFavorite: payload.previousFavorite })
          .where(eq(photos.id, Number(payload.photoRefId)))
          .run();
      }
      let progressDelta = 0;
      if (newStatus === "pending" && previousStatus !== "pending") {
        progressDelta = 1;
      } else if (newStatus !== "pending" && previousStatus === "pending") {
        progressDelta = -1;
      }
      if (progressDelta !== 0) {
        db.update(cullSessions)
          .set({
            completedComparisons: sql`MAX(completed_comparisons + ${progressDelta}, 0)`,
          })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    }

    db.delete(cullActionLogs).where(eq(cullActionLogs.id, lastLog.id)).run();
    return { success: true };
  });
  clearCullPairCaches(input.sessionId);
  return result;
});

export const updatePhotoStatus = os
  .input(UpdatePhotoStatusSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const result = db.transaction(() => {
      const existing = db
        .select({
          id: cullSessionPhotos.id,
          photoId: cullSessionPhotos.photoId,
          status: cullSessionPhotos.status,
          isFavorite: photos.isFavorite,
        })
        .from(cullSessionPhotos)
        .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, input.photoId)
          )
        )
        .get();
      if (!existing) {
        throw new Error("照片不在会话中");
      }
      if (existing.status === input.status) {
        return { success: true, changed: false };
      }

      const session = db
        .select({ mode: cullSessions.mode })
        .from(cullSessions)
        .where(eq(cullSessions.id, input.sessionId))
        .get();
      if (!session) {
        throw new Error("选片会话不存在");
      }

      db.update(cullSessionPhotos)
        .set({ status: input.status })
        .where(eq(cullSessionPhotos.id, existing.id))
        .run();

      if (input.status === "kept" && syncKeptWithFavorites()) {
        db.update(photos)
          .set({ isFavorite: true })
          .where(eq(photos.id, existing.photoId))
          .run();
      }

      let progressDelta = 0;
      if (session.mode === "curate") {
        progressDelta = getCullProgressDelta(existing.status, input.status);
        if (progressDelta !== 0) {
          db.update(cullSessions)
            .set({
              completedComparisons: sql`MAX(completed_comparisons + ${progressDelta}, 0)`,
            })
            .where(eq(cullSessions.id, input.sessionId))
            .run();
        }
      }

      db.insert(cullActionLogs)
        .values({
          sessionId: input.sessionId,
          action: "status",
          payload: JSON.stringify({
            photoId: existing.id,
            photoRefId: existing.photoId,
            previousStatus: existing.status,
            newStatus: input.status,
            previousFavorite: Boolean(existing.isFavorite),
          }),
        })
        .run();
      return { success: true, changed: true };
    });
    clearCullPairCaches(input.sessionId);
    return result;
  });

export const batchUpdatePhotoStatus = os
  .input(BatchUpdatePhotoStatusSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const requestedIds = uniqueIds(input.photoIds);
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch status updates preserve the existing transaction and progress semantics.
    const result = db.transaction(() => {
      const session = db
        .select({ mode: cullSessions.mode })
        .from(cullSessions)
        .where(eq(cullSessions.id, input.sessionId))
        .get();
      if (!session) {
        throw new Error("选片会话不存在");
      }

      const entries: Array<{
        id: number;
        photoRefId: number;
        previousStatus: string;
        newStatus: string;
        previousFavorite: boolean;
      }> = [];
      for (
        let index = 0;
        index < requestedIds.length;
        index += SQLITE_ID_CHUNK_SIZE
      ) {
        const chunk = requestedIds.slice(index, index + SQLITE_ID_CHUNK_SIZE);
        const rows = db
          .select({
            id: cullSessionPhotos.id,
            photoId: cullSessionPhotos.photoId,
            status: cullSessionPhotos.status,
            isFavorite: photos.isFavorite,
          })
          .from(cullSessionPhotos)
          .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
          .where(
            and(
              eq(cullSessionPhotos.sessionId, input.sessionId),
              inArray(cullSessionPhotos.id, chunk)
            )
          )
          .all();
        for (const row of rows) {
          if (row.status !== input.status) {
            entries.push({
              id: row.id,
              photoRefId: row.photoId,
              previousStatus: row.status,
              newStatus: input.status,
              previousFavorite: Boolean(row.isFavorite),
            });
          }
        }
      }
      if (entries.length === 0) {
        return { success: true, updatedCount: 0 };
      }

      for (
        let index = 0;
        index < entries.length;
        index += SQLITE_ID_CHUNK_SIZE
      ) {
        const chunk = entries.slice(index, index + SQLITE_ID_CHUNK_SIZE);
        db.update(cullSessionPhotos)
          .set({ status: input.status })
          .where(
            inArray(
              cullSessionPhotos.id,
              chunk.map((entry) => entry.id)
            )
          )
          .run();
        if (input.status === "kept" && syncKeptWithFavorites()) {
          db.update(photos)
            .set({ isFavorite: true })
            .where(
              inArray(
                photos.id,
                chunk.map((entry) => entry.photoRefId)
              )
            )
            .run();
        }
      }

      if (session.mode === "curate") {
        const progressDelta = entries.reduce(
          (sum, entry) =>
            sum + getCullProgressDelta(entry.previousStatus, input.status),
          0
        );
        if (progressDelta !== 0) {
          db.update(cullSessions)
            .set({
              completedComparisons: sql`MAX(completed_comparisons + ${progressDelta}, 0)`,
            })
            .where(eq(cullSessions.id, input.sessionId))
            .run();
        }
      }

      db.insert(cullActionLogs)
        .values({
          sessionId: input.sessionId,
          action: "batchStatus",
          payload: JSON.stringify({ entries }),
        })
        .run();
      return { success: true, updatedCount: entries.length };
    });
    clearCullPairCaches(input.sessionId);
    return result;
  });

export const skipSimilarPhotos = os
  .input(
    z.object({
      sessionId: z.number().int().positive(),
      photoId: z.number().int().positive(),
      threshold: z.number().int().min(0).max(64).default(8),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();

    const current = db
      .select({ phash: photos.phash })
      .from(cullSessionPhotos)
      .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
      .where(
        and(
          eq(cullSessionPhotos.sessionId, input.sessionId),
          eq(cullSessionPhotos.id, input.photoId),
          isNull(photos.deletedAt)
        )
      )
      .get();

    if (!current?.phash) {
      return { skippedCount: 0 };
    }

    const pending = loadPendingWithMetadata(input.sessionId);
    const currentPHash = current.phash;
    const similar = pending.filter((p) => {
      const pHash = p.phash;
      return (
        pHash != null &&
        p.id !== input.photoId &&
        hammingDistance(currentPHash, pHash) <= input.threshold
      );
    });

    // Query session mode once (outside loop, avoids N+1)
    const session = db
      .select({ mode: cullSessions.mode })
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();

    // Collect pre-update statuses and IDs for undo support
    const skippedEntries: {
      id: number;
      previousStatus: string;
      photoRefId: number;
    }[] = [];

    for (const photo of similar) {
      skippedEntries.push({
        id: photo.id,
        previousStatus: photo.status,
        photoRefId: photo.photoId,
      });
    }

    db.transaction(() => {
      if (similar.length > 0) {
        const similarIds = similar.map((p) => p.id);
        db.update(cullSessionPhotos)
          .set({ status: "rejected" })
          .where(
            and(
              eq(cullSessionPhotos.sessionId, input.sessionId),
              inArray(cullSessionPhotos.id, similarIds)
            )
          )
          .run();
      }
      if (session?.mode === "curate") {
        const pendingCount = similar.filter(
          (p) => p.status === "pending"
        ).length;
        if (pendingCount > 0) {
          db.update(cullSessions)
            .set({
              completedComparisons: sql`completed_comparisons + ${pendingCount}`,
            })
            .where(eq(cullSessions.id, input.sessionId))
            .run();
        }
      }
      if (skippedEntries.length > 0) {
        db.insert(cullActionLogs)
          .values({
            sessionId: input.sessionId,
            action: "skipSimilar",
            payload: JSON.stringify({ skippedEntries }),
          })
          .run();
      }
    });
    clearCullPairCaches(input.sessionId);
    return { skippedCount: similar.length };
  });

export const completeSession = os
  .input(SessionIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const result = db
      .update(cullSessions)
      .set({ status: "completed", completedAt: Date.now() })
      .where(eq(cullSessions.id, input.sessionId))
      .run();
    if (result.changes === 0) {
      throw new Error("选片会话不存在");
    }

    clearCullCaches(input.sessionId);
    return { success: true };
  });

export const renameSession = os
  .input(
    z.object({
      sessionId: z.number().int().positive(),
      name: z.string().trim().min(1).max(200),
    })
  )
  .handler(({ input }) => {
    const result = getDatabase()
      .update(cullSessions)
      .set({ name: input.name })
      .where(eq(cullSessions.id, input.sessionId))
      .run();
    if (result.changes === 0) {
      throw new Error("选片会话不存在");
    }
    return { success: true };
  });

export const duplicateSession = os
  .input(SessionIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const source = db
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (!source) {
      throw new Error("选片会话不存在");
    }
    const photoIds = db
      .select({ photoId: cullSessionPhotos.photoId })
      .from(cullSessionPhotos)
      .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
      .where(
        and(
          eq(cullSessionPhotos.sessionId, input.sessionId),
          isNull(photos.deletedAt)
        )
      )
      .all()
      .map((row) => row.photoId);
    if (photoIds.length < 2) {
      throw new Error("至少需要 2 张照片才能复制会话");
    }
    const sessionId = db.transaction(() => {
      const result = db
        .insert(cullSessions)
        .values({
          name: `${source.name} - 副本`,
          mode: source.mode,
          pkMode: source.pkMode,
          sortStrategy: source.sortStrategy,
          totalPhotos: photoIds.length,
        })
        .run();
      const createdId = Number(result.lastInsertRowid);
      for (
        let index = 0;
        index < photoIds.length;
        index += SQLITE_ID_CHUNK_SIZE
      ) {
        const chunk = photoIds.slice(index, index + SQLITE_ID_CHUNK_SIZE);
        db.insert(cullSessionPhotos)
          .values(chunk.map((photoId) => ({ sessionId: createdId, photoId })))
          .run();
      }
      return createdId;
    });
    return { success: true, sessionId };
  });

export const resumeSession = os.input(SessionIdSchema).handler(({ input }) => {
  const db = getDatabase();
  const result = db
    .update(cullSessions)
    .set({ status: "active", completedAt: null })
    .where(eq(cullSessions.id, input.sessionId))
    .run();
  if (result.changes === 0) {
    throw new Error("选片会话不存在");
  }
  clearCullCaches(input.sessionId);
  return { success: true };
});
