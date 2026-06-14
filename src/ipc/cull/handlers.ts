import { os } from "@orpc/server";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  photos,
} from "@/db/schema";
import { BKTree, hammingDistance } from "@/services/bk-tree";

// ── Per-session caches to avoid redundant work on every getNextPair call ──

interface ComparedPairCache {
  latestKey: string | null;
  maxLogId: number;
  set: Set<string>;
}
const comparedPairCaches = new Map<number, ComparedPairCache>();

interface BkTreeCache {
  idsHash: string;
  photoMap: Map<number, PendingRow>;
  tree: BKTree;
}
const bkTreeCaches = new Map<number, BkTreeCache>();

// Pre-computed similarity pair cache — avoids BK-tree query on every getNextPair.
// Built once when the pending phash set is stable, scanned O(candidates) thereafter.
interface SimPair {
  aId: number;
  bId: number;
  distance: number;
}
interface SimilarityCache {
  idsHash: string;
  pairs: SimPair[];
}
const similarityCaches = new Map<number, SimilarityCache>();

function clearCullCaches(sessionId: number) {
  comparedPairCaches.delete(sessionId);
  bkTreeCaches.delete(sessionId);
  similarityCaches.delete(sessionId);
}

const SessionIdSchema = z.object({ sessionId: z.number() });
const GetNextPairSchema = z.object({
  sessionId: z.number(),
  /** Photo IDs that the frontend reports as unloadable (corrupt / externally deleted).
   *  These are excluded from pairing to prevent infinite retry loops. */
  excludeIds: z.array(z.number()).optional().default([]),
});
const CreateSessionSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["duel", "curate"]).default("duel"),
  pkMode: z.enum(["quick", "standard", "fine"]).default("standard"),
  sortStrategy: z.enum(["time", "similarity"]).default("time"),
  photoIds: z.array(z.number()).default([]),
  folderId: z.number().optional(),
});
const SubmitComparisonSchema = z.object({
  sessionId: z.number(),
  winnerId: z.number(),
  loserId: z.number(),
  isDraw: z.boolean().default(false),
});
const UpdatePhotoStatusSchema = z.object({
  sessionId: z.number(),
  photoId: z.number(),
  status: z.enum(["pending", "kept", "rejected"]),
});

function computeElo(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  comparisonsA: number,
  comparisonsB: number
): { newRatingA: number; newRatingB: number } {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const avgComparisons = (comparisonsA + comparisonsB) / 2;
  const k = 32 / (1 + avgComparisons / 10);
  const newRatingA = Math.round(ratingA + k * (scoreA - expectedA));
  const newRatingB = Math.round(ratingB + k * (expectedA - scoreA));
  return { newRatingA, newRatingB };
}

const PK_MODE_CONFIG: Record<
  string,
  {
    minComparisons: number;
    allowRecompare: boolean;
    recompareFactor: number;
    similarityWeight: number;
    ratingWeight: number;
    swissThreshold: number;
  }
> = {
  quick: {
    minComparisons: 5,
    allowRecompare: false,
    recompareFactor: 0,
    similarityWeight: 0.3,
    ratingWeight: 0.2,
    swissThreshold: 0.6,
  },
  standard: {
    minComparisons: 8,
    allowRecompare: true,
    recompareFactor: 0.15,
    similarityWeight: 0.5,
    ratingWeight: 0.3,
    swissThreshold: 0.55,
  },
  fine: {
    minComparisons: 12,
    allowRecompare: true,
    recompareFactor: 0.3,
    similarityWeight: 0.7,
    ratingWeight: 0.4,
    swissThreshold: 0.4,
  },
};

function selectPhotoFields() {
  return {
    id: photos.id,
    filename: photos.filename,
    path: photos.path,
    width: photos.width,
    height: photos.height,
    fileSize: photos.fileSize,
    format: photos.format,
    thumbnailPath: photos.thumbnailPath,
    fileDate: photos.fileDate,
    isFavorite: photos.isFavorite,
    isIndexed: photos.isIndexed,
  };
}

function loadPendingWithMetadata(sessionId: number) {
  const db = getDatabase();
  return db
    .select({
      id: cullSessionPhotos.id,
      photoId: cullSessionPhotos.photoId,
      rating: cullSessionPhotos.rating,
      comparisons: cullSessionPhotos.comparisons,
      wins: cullSessionPhotos.wins,
      losses: cullSessionPhotos.losses,
      status: cullSessionPhotos.status,
      phash: photos.phash,
      fileDate: photos.fileDate,
      filename: photos.filename,
      path: photos.path,
      width: photos.width,
      height: photos.height,
      fileSize: photos.fileSize,
      format: photos.format,
      thumbnailPath: photos.thumbnailPath,
      isFavorite: photos.isFavorite,
      isIndexed: photos.isIndexed,
    })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .where(
      and(
        eq(cullSessionPhotos.sessionId, sessionId),
        eq(cullSessionPhotos.status, "pending")
      )
    )
    .orderBy(asc(photos.fileDate))
    .all();
}

type PendingRow = ReturnType<typeof loadPendingWithMetadata>[number];

function buildPairItem(row: PendingRow) {
  return {
    sessionPhotoId: row.id,
    photo: {
      id: row.photoId,
      filename: row.filename,
      path: row.path,
      width: row.width,
      height: row.height,
      fileSize: row.fileSize,
      format: row.format,
      thumbnailPath: row.thumbnailPath,
      fileDate: row.fileDate,
      isFavorite: row.isFavorite,
      isIndexed: row.isIndexed,
    },
    rating: row.rating,
    comparisons: row.comparisons,
    wins: row.wins,
    losses: row.losses,
  };
}

export const createSession = os
  .input(CreateSessionSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();

    let allPhotoIds = [...input.photoIds];

    // If folderId is provided, load photos from that folder
    if (input.folderId && allPhotoIds.length === 0) {
      const folderPhotos = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.folderId, input.folderId))
        .all();
      allPhotoIds = folderPhotos.map((p) => p.id);
    }

    if (allPhotoIds.length < 2) {
      throw new Error("至少需要 2 张照片才能创建选片会话");
    }

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

    const sessionId = Number(result.lastInsertRowid);

    db.transaction(() => {
      // Filter out already-existing photos (safety, though session is new)
      const existingPhotos = db
        .select({ photoId: cullSessionPhotos.photoId })
        .from(cullSessionPhotos)
        .where(eq(cullSessionPhotos.sessionId, sessionId))
        .all();
      const existingSet = new Set(existingPhotos.map((p) => p.photoId));
      const newPhotoIds = allPhotoIds.filter((id) => !existingSet.has(id));

      const batchSize = 500;
      for (let i = 0; i < newPhotoIds.length; i += batchSize) {
        const batch = newPhotoIds.slice(i, i + batchSize);
        for (const photoId of batch) {
          db.insert(cullSessionPhotos).values({ sessionId, photoId }).run();
        }
      }
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
      sessionId: z.number(),
      photoIds: z.array(z.number()).min(1),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const session = db
      .select()
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (!session) {
      throw new Error("选片会话不存在");
    }

    let added = 0;
    db.transaction(() => {
      const existingPhotos = db
        .select({ photoId: cullSessionPhotos.photoId })
        .from(cullSessionPhotos)
        .where(eq(cullSessionPhotos.sessionId, input.sessionId))
        .all();
      const existingSet = new Set(existingPhotos.map((p) => p.photoId));
      const newPhotoIds = input.photoIds.filter((id) => !existingSet.has(id));

      const batchSize = 500;
      for (let i = 0; i < newPhotoIds.length; i += batchSize) {
        const batch = newPhotoIds.slice(i, i + batchSize);
        for (const photoId of batch) {
          db.insert(cullSessionPhotos)
            .values({ sessionId: input.sessionId, photoId })
            .run();
          added++;
        }
      }
    });

    if (added > 0) {
      db.update(cullSessions)
        .set({ totalPhotos: session.totalPhotos + added })
        .where(eq(cullSessions.id, input.sessionId))
        .run();
    }

    return { success: true, addedCount: added };
  });

const RecordSkipSchema = z.object({
  sessionId: z.number(),
  photoAId: z.number(),
  photoBId: z.number(),
});

export const recordSkip = os
  .input(RecordSkipSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const session = db
      .select({ status: cullSessions.status })
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (session?.status === "completed") {
      return { success: false, reason: "选片会话已结束" };
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

export const listSessions = os.handler(async () => {
  const db = getDatabase();
  const sessions = db
    .select()
    .from(cullSessions)
    .orderBy(desc(cullSessions.createdAt))
    .all();

  // Replace static cullSessions.totalPhotos with live COUNT from
  // cullSessionPhotos. The static column drifts when photos are
  // cascade-deleted externally — causing stale card counts and
  // progress bars that can never reach 100%.
  // N+1 queries, but session count is typically < 50 — acceptable.
  return sessions.map((s) => {
    const countResult = db
      .select({ count: sql<number>`count(*)` })
      .from(cullSessionPhotos)
      .where(eq(cullSessionPhotos.sessionId, s.id))
      .get();
    return { ...s, totalPhotos: countResult?.count ?? 0 };
  });
});

export const getSession = os
  .input(SessionIdSchema)
  .handler(async ({ input }) => {
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
      .where(eq(cullSessionPhotos.sessionId, input.sessionId))
      .orderBy(desc(cullSessionPhotos.rating))
      .all();

    // Dynamic COUNT — the static cullSessions.totalPhotos drifts when
    // photos are cascade-deleted externally (e.g. file-system removal).
    const actualCount = db
      .select({ count: sql<number>`count(*)` })
      .from(cullSessionPhotos)
      .where(eq(cullSessionPhotos.sessionId, input.sessionId))
      .get();

    return { ...session, totalPhotos: actualCount?.count ?? 0, items };
  });

export const deleteSession = os
  .input(SessionIdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    db.delete(cullSessionPhotos)
      .where(eq(cullSessionPhotos.sessionId, input.sessionId))
      .run();
    db.delete(cullActionLogs)
      .where(eq(cullActionLogs.sessionId, input.sessionId))
      .run();
    db.delete(cullSessions).where(eq(cullSessions.id, input.sessionId)).run();
    return { success: true };
  });

function sortBySimilarityGroups(pending: PendingRow[]): PendingRow[] {
  const withPHash = pending.filter((p) => p.phash != null);
  if (withPHash.length < 2) {
    return pending.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0));
  }

  const groups: PendingRow[][] = [];
  const visited = new Set<number>();

  for (const photo of withPHash) {
    if (visited.has(photo.id)) {
      continue;
    }
    const group = [photo];
    visited.add(photo.id);

    for (const other of withPHash) {
      if (visited.has(other.id)) {
        continue;
      }
      if (hammingDistance(photo.phash!, other.phash!) <= 8) {
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

export const getNextPair = os
  .input(GetNextPairSchema)
  .handler(async ({ input }) => {
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
    const excludeIds = input.excludeIds ?? [];
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

    const stats = {
      total: pending.length,
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
        sorted = sortBySimilarityGroups(pending);
      } else {
        sorted.sort((a, b) => (a.fileDate ?? 0) - (b.fileDate ?? 0));
      }

      const item = sorted[0];

      let similarCount = 0;
      if (item.phash) {
        similarCount = pending.filter(
          (p) =>
            p.phash &&
            p.id !== item.id &&
            hammingDistance(item.phash!, p.phash!) <= 8
        ).length;
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
      comparedPairCaches.set(input.sessionId, pairCache);
    }

    const comparedPairs = pairCache.set;
    const latestActionPair = pairCache.latestKey;

    // b) Payload-only query for recent skips with cooldown limit
    const baseCooldown = Math.min(
      pending.length * 2,
      config.minComparisons * 4
    );
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
      } catch {}
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
    const withPHash = pending.filter((p) => p.phash != null);
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
        let photoMap: Map<number, PendingRow>;

        if (bkCache && bkCache.idsHash === idsHash) {
          bkTree = bkCache.tree;
          photoMap = bkCache.photoMap;
        } else {
          const tree = new BKTree();
          const map = new Map<number, PendingRow>();
          for (const photo of withPHash) {
            tree.insert(photo.id, photo.phash!);
            map.set(photo.id, photo);
          }
          bkCache = { tree, photoMap: map, idsHash };
          bkTreeCaches.set(input.sessionId, bkCache);
          bkTree = tree;
          photoMap = map;
        }

        // Query all photos once, collect deduplicated similar pairs
        const pairs: SimPair[] = [];
        const seen = new Set<string>();
        for (const photo of withPHash) {
          for (const n of bkTree.query(photo.phash!, 8)) {
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
        similarityCaches.set(input.sessionId, simCache);
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
      const under = pending.filter(
        (p) => p.comparisons < config.minComparisons
      );
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
  .handler(async ({ input }) => {
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

export const undoLastAction = os
  .input(SessionIdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const session = db
      .select({ status: cullSessions.status })
      .from(cullSessions)
      .where(eq(cullSessions.id, input.sessionId))
      .get();
    if (session?.status === "completed") {
      return { success: false, reason: "选片会话已结束" };
    }

    const lastLog = db
      .select()
      .from(cullActionLogs)
      .where(
        and(
          eq(cullActionLogs.sessionId, input.sessionId),
          sql`${cullActionLogs.action} != 'undo'`
        )
      )
      .orderBy(desc(cullActionLogs.createdAt))
      .limit(1)
      .get();

    if (!lastLog) {
      return { success: false, reason: "没有可撤销的操作" };
    }

    const payload = JSON.parse(lastLog.payload);

    if (lastLog.action === "compare" && payload.winnerId && payload.loserId) {
      // Reverse the Elo update
      db.update(cullSessionPhotos)
        .set({
          rating: payload.winnerOldRating,
          comparisons: sql`MAX(comparisons - 1, 0)`,
          wins: sql`MAX(wins - 1, 0)`,
        })
        .where(eq(cullSessionPhotos.id, payload.winnerId))
        .run();

      db.update(cullSessionPhotos)
        .set({
          rating: payload.loserOldRating,
          comparisons: sql`MAX(comparisons - 1, 0)`,
          losses: sql`MAX(losses - 1, 0)`,
        })
        .where(eq(cullSessionPhotos.id, payload.loserId))
        .run();

      db.update(cullSessions)
        .set({
          completedComparisons: sql`MAX(completed_comparisons - 1, 0)`,
        })
        .where(eq(cullSessions.id, input.sessionId))
        .run();
    } else if (lastLog.action === "draw") {
      const photoAId = payload.photoAId ?? payload.winnerId;
      const photoBId = payload.photoBId ?? payload.loserId;
      if (!(photoAId && photoBId)) {
        return { success: false, reason: "撤销记录无效" };
      }
      db.update(cullSessionPhotos)
        .set({
          rating: payload.photoAOldRating ?? payload.winnerOldRating,
          comparisons: sql`MAX(comparisons - 1, 0)`,
        })
        .where(eq(cullSessionPhotos.id, photoAId))
        .run();

      db.update(cullSessionPhotos)
        .set({
          rating: payload.photoBOldRating ?? payload.loserOldRating,
          comparisons: sql`MAX(comparisons - 1, 0)`,
        })
        .where(eq(cullSessionPhotos.id, photoBId))
        .run();

      db.update(cullSessions)
        .set({
          completedComparisons: sql`MAX(completed_comparisons - 1, 0)`,
        })
        .where(eq(cullSessions.id, input.sessionId))
        .run();
    } else if (lastLog.action === "skipSimilar" && payload.skippedEntries) {
      // Reverse the bulk skip-similar action
      const entries: {
        id: number;
        previousStatus: string;
        photoRefId: number;
      }[] = payload.skippedEntries;
      for (const entry of entries) {
        db.update(cullSessionPhotos)
          .set({ status: entry.previousStatus })
          .where(eq(cullSessionPhotos.id, entry.id))
          .run();
        if (entry.previousStatus === "pending") {
          db.update(cullSessions)
            .set({
              completedComparisons: sql`MAX(completed_comparisons - 1, 0)`,
            })
            .where(eq(cullSessions.id, input.sessionId))
            .run();
        }
      }
    } else if (
      (lastLog.action === "kept" || lastLog.action === "rejected") &&
      payload.photoId
    ) {
      // Reverse the curate status change
      db.update(cullSessionPhotos)
        .set({ status: payload.previousStatus })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            eq(cullSessionPhotos.id, payload.photoId)
          )
        )
        .run();

      // Decrement progress if reverting from pending→kept/rejected back to pending
      if (payload.previousStatus === "pending") {
        db.update(cullSessions)
          .set({ completedComparisons: sql`MAX(completed_comparisons - 1, 0)` })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    }

    // Delete the undone log (don't log undo-of-undo)
    db.delete(cullActionLogs).where(eq(cullActionLogs.id, lastLog.id)).run();

    // Invalidate caches since the log history changed
    clearCullCaches(input.sessionId);

    return { success: true };
  });

export const updatePhotoStatus = os
  .input(UpdatePhotoStatusSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const existing = db
      .select()
      .from(cullSessionPhotos)
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

    db.update(cullSessionPhotos)
      .set({ status: input.status })
      .where(
        and(
          eq(cullSessionPhotos.sessionId, input.sessionId),
          eq(cullSessionPhotos.id, input.photoId)
        )
      )
      .run();

    // For curate sessions, track progress when changing from pending to kept/rejected
    if (existing.status === "pending" && input.status !== "pending") {
      const session = db
        .select({ mode: cullSessions.mode })
        .from(cullSessions)
        .where(eq(cullSessions.id, input.sessionId))
        .get();
      if (session?.mode === "curate") {
        db.update(cullSessions)
          .set({ completedComparisons: sql`completed_comparisons + 1` })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    }

    // Log for undo support
    db.insert(cullActionLogs)
      .values({
        sessionId: input.sessionId,
        action: input.status,
        payload: JSON.stringify({
          photoId: input.photoId,
          previousStatus: existing.status,
          newStatus: input.status,
          photoRefId: existing.photoId,
        }),
      })
      .run();

    return { success: true };
  });

const BatchUpdatePhotoStatusSchema = z.object({
  sessionId: z.number(),
  photoIds: z.array(z.number()).min(1),
  status: z.enum(["pending", "kept", "rejected"]),
});

export const batchUpdatePhotoStatus = os
  .input(BatchUpdatePhotoStatusSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();

    // Batch update all photos in a single SQL statement
    db.transaction(() => {
      db.update(cullSessionPhotos)
        .set({ status: input.status })
        .where(
          and(
            eq(cullSessionPhotos.sessionId, input.sessionId),
            inArray(cullSessionPhotos.id, input.photoIds)
          )
        )
        .run();

      // For curate sessions, track progress
      const session = db
        .select({ mode: cullSessions.mode })
        .from(cullSessions)
        .where(eq(cullSessions.id, input.sessionId))
        .get();

      if (session?.mode === "curate" && input.status !== "pending") {
        // Only count photos that were actually pending -> kept/rejected
        // We use a rough estimate: all updated photos count
        db.update(cullSessions)
          .set({
            completedComparisons: sql`completed_comparisons + ${input.photoIds.length}`,
          })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }

      // Log each for undo support
      for (const photoId of input.photoIds) {
        db.insert(cullActionLogs)
          .values({
            sessionId: input.sessionId,
            action: input.status,
            payload: JSON.stringify({
              photoId,
              previousStatus: "pending", // will be refined below, but OK for batch undo
              newStatus: input.status,
            }),
          })
          .run();
      }
    });

    return { success: true, updatedCount: input.photoIds.length };
  });

export const skipSimilarPhotos = os
  .input(
    z.object({
      sessionId: z.number(),
      photoId: z.number(),
      threshold: z.number().default(8),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();

    const current = db
      .select({ phash: photos.phash })
      .from(cullSessionPhotos)
      .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
      .where(eq(cullSessionPhotos.id, input.photoId))
      .get();

    if (!current?.phash) {
      return { skippedCount: 0 };
    }

    const pending = loadPendingWithMetadata(input.sessionId);
    const similar = pending.filter(
      (p) =>
        p.phash &&
        p.id !== input.photoId &&
        hammingDistance(current.phash!, p.phash!) <= input.threshold
    );

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

    // Bulk UPDATE status using inArray
    if (similar.length > 0) {
      const similarIds = similar.map((p) => p.id);
      db.update(cullSessionPhotos)
        .set({ status: "rejected" })
        .where(inArray(cullSessionPhotos.id, similarIds))
        .run();
    }

    // In curate mode, bulk-update completedComparisons once
    if (session?.mode === "curate") {
      const pendingCount = similar.filter((p) => p.status === "pending").length;
      if (pendingCount > 0) {
        db.update(cullSessions)
          .set({
            completedComparisons: sql`completed_comparisons + ${pendingCount}`,
          })
          .where(eq(cullSessions.id, input.sessionId))
          .run();
      }
    }

    // Log as a single undo-able action
    if (skippedEntries.length > 0) {
      db.insert(cullActionLogs)
        .values({
          sessionId: input.sessionId,
          action: "skipSimilar",
          payload: JSON.stringify({ skippedEntries }),
        })
        .run();
    }

    return { skippedCount: similar.length };
  });

export const completeSession = os
  .input(SessionIdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    db.update(cullSessions)
      .set({ status: "completed", completedAt: Date.now() })
      .where(eq(cullSessions.id, input.sessionId))
      .run();

    clearCullCaches(input.sessionId);
    return { success: true };
  });
