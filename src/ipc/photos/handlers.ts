import fs from "node:fs";
import nodeOs from "node:os";
import path from "node:path";
import { os } from "@orpc/server";
import { desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags, tags, appSettings } from "@/db/schema";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
  suggestTags as aiSuggestTags,
  checkAiHealth,
  deletePhotoVectors,
  embedAllPhotos,
  getEmbeddingProgress,
  getPhotoVectors,
  stopEmbedding,
} from "@/services/ai-embedder";
import { scanFolder as scanFolderService } from "@/services/indexer";
import { clearThumbnailDiskCache } from "@/services/thumbnailer";

const FolderSchema = z.object({ path: z.string().min(1) });
const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().optional().default(50),
});

// Time-decay scoring: blends vector similarity with photo recency.
// Newer photos get a moderate boost; older photos are not penalized below their vector score.
const TIME_DECAY_ALPHA = 0.1; // Light recency boost — prioritizes semantic relevance over freshness
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

function applyTimeDecay<
  T extends { similarity: number; fileDate?: number | null },
>(results: T[]): Array<T & { score: number }> {
  const now = Date.now();
  const scored = results.map((r) => {
    const age = r.fileDate == null ? 0 : Math.max(0, now - r.fileDate);
    const recency = Math.max(0, 1 - age / MAX_AGE_MS);
    const score = r.similarity * (1 + TIME_DECAY_ALPHA * recency);
    return { ...r, score: Math.round(score * 10_000) / 10_000 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}
const ImageSearchSchema = z.object({
  imagePath: z.string().min(1),
  limit: z.number().optional().default(20),
});
const ListSchema = z.object({
  folderId: z.number().optional(),
  search: z.string().optional(),
  sort: z.enum(["date", "name", "size"]).optional().default("date"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  offset: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});
const IdSchema = z.object({ id: z.number() });

// Folder management
export const scanFolder = os.input(FolderSchema).handler(async ({ input }) => {
  const result = await scanFolderService(input.path);
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
    // Collect photo IDs for both folder-linked and orphan records
    const folderPhotoIds = db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.folderId, input.id))
      .all()
      .map((p) => p.id);

    // Also find orphan photos (folderId=NULL or dangling) whose path is under this folder.
    // Normalize both path separators so the LIKE matches on Windows (backslash) and Unix.
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
  const { folderId, search, sort, order, offset, limit } = input;

  let query = db.select().from(photos).$dynamic();

  if (folderId) {
    query = query.where(eq(photos.folderId, folderId));
  }
  if (search) {
    query = query.where(like(photos.filename, `%${search}%`));
  }

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
  if (folderId) {
    countQuery = countQuery.where(eq(photos.folderId, folderId));
  }
  if (search) {
    countQuery = countQuery.where(like(photos.filename, `%${search}%`));
  }
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

// Statistics for dashboard
export const getStats = os.handler(() => {
  const db = getDatabase();

  const totalPhotos =
    db.select({ count: sql<number>`count(*)` }).from(photos).get()?.count || 0;
  const aiProcessed =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(eq(photos.isAiProcessed, true))
      .get()?.count || 0;

  const cameraStats = db
    .select({
      model: exifData.cameraModel,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .groupBy(exifData.cameraModel)
    .orderBy(desc(sql`count(*)`))
    .limit(5)
    .all();

  const focalStats = db
    .select({
      focalLength: exifData.focalLength,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.focalLength} IS NOT NULL`)
    .groupBy(exifData.focalLength)
    .orderBy(desc(sql`count(*)`))
    .limit(10)
    .all();

  const apertureStats = db
    .select({
      aperture: exifData.aperture,
      count: sql<number>`count(*)`,
    })
    .from(exifData)
    .where(sql`${exifData.aperture} IS NOT NULL`)
    .groupBy(exifData.aperture)
    .orderBy(exifData.aperture)
    .all();

  // ISO distribution by common ranges
  const isoRanges = db
    .select({
      iso: exifData.iso,
    })
    .from(exifData)
    .where(sql`${exifData.iso} IS NOT NULL`)
    .all();

  const isoBuckets = {
    "50-200": 0,
    "200-400": 0,
    "400-800": 0,
    "800-1600": 0,
    "1600+": 0,
  };
  for (const row of isoRanges) {
    const iso = row.iso ?? 0;
    if (iso <= 200) {
      isoBuckets["50-200"]++;
    } else if (iso <= 400) {
      isoBuckets["200-400"]++;
    } else if (iso <= 800) {
      isoBuckets["400-800"]++;
    } else if (iso <= 1600) {
      isoBuckets["800-1600"]++;
    } else {
      isoBuckets["1600+"]++;
    }
  }

  // Shooting time heatmap (hour of day)
  const hourData = db
    .select({
      dateTaken: exifData.dateTaken,
    })
    .from(exifData)
    .where(sql`${exifData.dateTaken} IS NOT NULL`)
    .all();

  const hourBuckets: Record<string, number> = {};
  for (const row of hourData) {
    const hour = new Date(row.dateTaken!).getHours();
    const period =
      hour < 6 ? "夜间" : hour < 12 ? "上午" : hour < 18 ? "下午" : "傍晚";
    hourBuckets[period] = (hourBuckets[period] || 0) + 1;
  }

  const dateRange = db
    .select({
      earliest: sql<number>`min(${exifData.dateTaken})`,
      latest: sql<number>`max(${exifData.dateTaken})`,
    })
    .from(exifData)
    .get();

  const avgIso =
    db
      .select({ avgIso: sql<number>`avg(${exifData.iso})` })
      .from(exifData)
      .where(sql`${exifData.iso} IS NOT NULL`)
      .get()?.avgIso || 0;

  return {
    totalPhotos,
    aiProcessed,
    cameraStats: cameraStats.filter((c) => c.model),
    focalStats: focalStats.filter((f) => f.focalLength),
    apertureStats: apertureStats.filter((a) => a.aperture),
    isoDistribution: Object.entries(isoBuckets).map(([range, count]) => ({
      range,
      count,
    })),
    timeHeatmap: Object.entries(hourBuckets).map(([period, count]) => ({
      period,
      count,
    })),
    dateRange,
    avgIso,
  };
});

// AI Search
export const searchByText = os
  .input(SearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results = await aiSearchByText(input.query, input.limit);

    const photoIds = results.map((r) => r.photoId);
    if (photoIds.length === 0) {
      return { results: [], query: input.query };
    }

    const photoList = db
      .select()
      .from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    const photoMap = new Map(photoList.map((p) => [p.id, p]));
    const merged = results
      .map((r) => {
        const photo = photoMap.get(r.photoId);
        if (!photo) {
          return null;
        }
        return { ...photo, similarity: r.similarity, fileDate: photo.fileDate };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    // Apply time-decay scoring
    const scored = applyTimeDecay(merged);
    return { results: scored, query: input.query };
  });

export const searchByImage = os
  .input(ImageSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results = await aiSearchByImage(input.imagePath, input.limit);

    const photoIds = results.map((r) => r.photoId);
    if (photoIds.length === 0) {
      return { results: [] };
    }

    const photoList = db
      .select()
      .from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    const photoMap = new Map(photoList.map((p) => [p.id, p]));
    const merged = results
      .map((r) => {
        const photo = photoMap.get(r.photoId);
        if (!photo) {
          return null;
        }
        return { ...photo, similarity: r.similarity, fileDate: photo.fileDate };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    const scored = applyTimeDecay(merged);
    return { results: scored };
  });

// Compound search: text + EXIF filters
const CompoundSearchSchema = z.object({
  query: z.string().optional(),
  dateFrom: z.number().optional(),
  dateTo: z.number().optional(),
  cameraModel: z.string().optional(),
  focalMin: z.number().optional(),
  focalMax: z.number().optional(),
  apertureMin: z.number().optional(),
  apertureMax: z.number().optional(),
  isoMin: z.number().optional(),
  isoMax: z.number().optional(),
  limit: z.number().optional().default(100),
});

export const searchCompound = os
  .input(CompoundSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const {
      query,
      dateFrom,
      dateTo,
      cameraModel,
      focalMin,
      focalMax,
      apertureMin,
      apertureMax,
      isoMin,
      isoMax,
      limit,
    } = input;

    const hasExifFilters =
      dateFrom ||
      dateTo ||
      cameraModel ||
      focalMin ||
      focalMax ||
      apertureMin ||
      apertureMax ||
      isoMin ||
      isoMax;

    // If text query: AI search first, then apply EXIF filters on the results
    if (query?.trim()) {
      const aiResults = await aiSearchByText(query.trim(), 200);
      const photoIds = aiResults.map((r) => r.photoId);

      if (photoIds.length === 0) {
        return { results: [], query: query.trim(), total: 0 };
      }

      if (!hasExifFilters) {
        const photoList = db
          .select()
          .from(photos)
          .where(inArray(photos.id, photoIds))
          .all();
        const photoMap = new Map(photoList.map((p) => [p.id, p]));
        const merged = aiResults
          .map((r) => {
            const photo = photoMap.get(r.photoId);
            if (!photo) {
              return null;
            }
            return {
              ...photo,
              similarity: r.similarity,
              fileDate: photo.fileDate,
            };
          })
          .filter(
            (p): p is NonNullable<typeof p> => p !== null && p.id != null
          );

        const scored = applyTimeDecay(merged);
        return {
          results: scored.slice(0, limit),
          query: query.trim(),
          total: scored.length,
        };
      }

      // Apply EXIF filters on AI results
      let exifQuery = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(inArray(exifData.photoId, photoIds))
        .$dynamic();

      if (dateFrom) {
        exifQuery = exifQuery.where(sql`${exifData.dateTaken} >= ${dateFrom}`);
      }
      if (dateTo) {
        exifQuery = exifQuery.where(sql`${exifData.dateTaken} <= ${dateTo}`);
      }
      if (cameraModel) {
        exifQuery = exifQuery.where(
          like(exifData.cameraModel, `%${cameraModel}%`)
        );
      }
      if (focalMin !== undefined) {
        exifQuery = exifQuery.where(
          sql`CAST(${exifData.focalLength} AS REAL) >= ${focalMin}`
        );
      }
      if (focalMax !== undefined) {
        exifQuery = exifQuery.where(
          sql`CAST(${exifData.focalLength} AS REAL) <= ${focalMax}`
        );
      }
      if (apertureMin !== undefined) {
        exifQuery = exifQuery.where(
          sql`${exifData.aperture} >= ${apertureMin}`
        );
      }
      if (apertureMax !== undefined) {
        exifQuery = exifQuery.where(
          sql`${exifData.aperture} <= ${apertureMax}`
        );
      }
      if (isoMin !== undefined) {
        exifQuery = exifQuery.where(gte(exifData.iso, isoMin));
      }
      if (isoMax !== undefined) {
        exifQuery = exifQuery.where(lte(exifData.iso, isoMax));
      }

      const filteredExif = exifQuery.all();
      const validIds = new Set(filteredExif.map((e) => e.photoId!));

      const filtered = aiResults.filter((r) => validIds.has(r.photoId));

      if (filtered.length === 0) {
        return { results: [], query: query.trim(), total: 0 };
      }

      const filteredIds = filtered.map((r) => r.photoId);
      const photoList = db
        .select()
        .from(photos)
        .where(inArray(photos.id, filteredIds))
        .all();
      const photoMap = new Map(photoList.map((p) => [p.id, p]));
      const merged = filtered
        .map((r) => {
          const photo = photoMap.get(r.photoId);
          if (!photo) {
            return null;
          }
          return {
            ...photo,
            similarity: r.similarity,
            fileDate: photo.fileDate,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

      const scored = applyTimeDecay(merged);
      return {
        results: scored.slice(0, limit),
        query: query.trim(),
        total: scored.length,
      };
    }

    // No text query: EXIF-only filter
    if (!hasExifFilters) {
      const items = db
        .select()
        .from(photos)
        .orderBy(desc(photos.fileDate))
        .limit(limit)
        .all();
      return { results: items, total: items.length };
    }

    let exifQuery = db
      .select({ photoId: exifData.photoId })
      .from(exifData)
      .$dynamic();

    if (dateFrom) {
      exifQuery = exifQuery.where(sql`${exifData.dateTaken} >= ${dateFrom}`);
    }
    if (dateTo) {
      exifQuery = exifQuery.where(sql`${exifData.dateTaken} <= ${dateTo}`);
    }
    if (cameraModel) {
      exifQuery = exifQuery.where(
        like(exifData.cameraModel, `%${cameraModel}%`)
      );
    }
    if (focalMin !== undefined) {
      exifQuery = exifQuery.where(
        sql`CAST(${exifData.focalLength} AS REAL) >= ${focalMin}`
      );
    }
    if (focalMax !== undefined) {
      exifQuery = exifQuery.where(
        sql`CAST(${exifData.focalLength} AS REAL) <= ${focalMax}`
      );
    }
    if (apertureMin !== undefined) {
      exifQuery = exifQuery.where(sql`${exifData.aperture} >= ${apertureMin}`);
    }
    if (apertureMax !== undefined) {
      exifQuery = exifQuery.where(sql`${exifData.aperture} <= ${apertureMax}`);
    }
    if (isoMin !== undefined) {
      exifQuery = exifQuery.where(gte(exifData.iso, isoMin));
    }
    if (isoMax !== undefined) {
      exifQuery = exifQuery.where(lte(exifData.iso, isoMax));
    }

    const filteredExif = exifQuery.limit(limit).all();
    const exifPhotoIds = filteredExif.map((e) => e.photoId!).filter(Boolean);

    if (exifPhotoIds.length === 0) {
      return { results: [], total: 0 };
    }

    const photoList = db
      .select()
      .from(photos)
      .where(inArray(photos.id, exifPhotoIds))
      .limit(limit)
      .all();

    return { results: photoList, total: photoList.length };
  });

export const startAiIndexing = os.handler(() => {
  // Fire-and-forget: launch embedding in background, poll progress via getAiProgress
  embedAllPhotos()
    .then((count) => {
      console.log(`[AI] Embedding complete: ${count} photos processed`);
    })
    .catch((err) => {
      console.error("[AI] Embedding error:", err);
    });
  return { started: true };
});

export const stopAiIndexing = os.handler(() => {
  stopEmbedding();
  return { stopped: true };
});

export const deletePhoto = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path, folderId: photos.folderId })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (photo) {
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
    // Collect folderId info before deletion for count updates
    const deletedPhotos = db
      .select({ id: photos.id, folderId: photos.folderId })
      .from(photos)
      .where(inArray(photos.id, input.ids))
      .all();
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

function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64; // Different lengths → max distance
  }
  try {
    const va = BigInt(`0x${a}`);
    const vb = BigInt(`0x${b}`);
    let xor = va ^ vb;
    let dist = 0;
    while (xor > 0n) {
      dist += Number(xor & 1n);
      xor >>= 1n;
    }
    return dist;
  } catch {
    return 64;
  }
}

export const findDuplicates = os
  .input(z.object({ threshold: z.number().optional().default(8) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const allPhotos = db
      .select({
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        phash: photos.phash,
      })
      .from(photos)
      .where(sql`${photos.phash} IS NOT NULL`)
      .all();

    // Phase 1: pHash screening — chunked async to avoid blocking the main process.
    // Each chunk runs a subset of pairwise comparisons then yields via setImmediate.
    const CHUNK_SIZE = 300;
    const candidates: Array<{
      photoA: { id: number; path: string; filename: string };
      photoB: { id: number; path: string; filename: string };
      distance: number;
    }> = [];

    let compared = 0;
    const totalPairs = (allPhotos.length * (allPhotos.length - 1)) / 2;

    for (let ci = 0; ci < allPhotos.length; ci += CHUNK_SIZE) {
      const chunkEnd = Math.min(ci + CHUNK_SIZE, allPhotos.length);
      const chunk = allPhotos.slice(ci, chunkEnd);

      // Offload each chunk's work into a microtask to keep the UI responsive
      await new Promise<void>((resolve) => {
        setImmediate(() => {
          for (const photoA of chunk) {
            for (const photoB of allPhotos) {
              if (photoA.id >= photoB.id) continue;
              compared++;
              if (photoA.phash && photoB.phash) {
                const dist = hammingDistance(photoA.phash, photoB.phash);
                if (dist <= input.threshold) {
                  candidates.push({
                    photoA: {
                      id: photoA.id,
                      path: photoA.path,
                      filename: photoA.filename,
                    },
                    photoB: {
                      id: photoB.id,
                      path: photoB.path,
                      filename: photoB.filename,
                    },
                    distance: dist,
                  });
                }
              }
            }
          }
          resolve();
        });
      });

      // Log progress periodically
      if (
        ci % (CHUNK_SIZE * 5) === 0 ||
        ci + CHUNK_SIZE >= allPhotos.length
      ) {
        const pct =
          totalPairs > 0
            ? Math.round((compared / totalPairs) * 100)
            : 0;
        console.log(
          `[Dedup] pHash screening: ~${pct}% (${compared}/${totalPairs} pairs, ${candidates.length} candidates)`
        );
      }
    }

    // Phase 2: CLIP vector verification for top candidates.
    // PDR §7.3: candidates → CLIP cosine similarity > 0.95 → confirmed duplicate.
    const topCandidates = candidates.slice(0, 200);
    const duplicates: Array<{
      photoA: { id: number; path: string; filename: string };
      photoB: { id: number; path: string; filename: string };
      distance: number;
      clipSimilarity?: number;
    }> = [];

    if (topCandidates.length > 0) {
      // Collect unique photo IDs from all candidates
      const uniqueIds = new Set<number>();
      for (const c of topCandidates) {
        uniqueIds.add(c.photoA.id);
        uniqueIds.add(c.photoB.id);
      }

      // Batch-fetch CLIP vectors
      let vectors: Map<number, number[]> = new Map();
      try {
        vectors = await getPhotoVectors(Array.from(uniqueIds));
      } catch {
        // LanceDB unavailable — fall through to pHash-only results
      }

      for (const c of topCandidates) {
        const vecA = vectors.get(c.photoA.id);
        const vecB = vectors.get(c.photoB.id);

        if (vecA && vecB && vecA.length === vecB.length) {
          // Both vectors available — CLIP verification
          let dot = 0;
          let normA = 0;
          let normB = 0;
          for (let k = 0; k < vecA.length; k++) {
            dot += vecA[k] * vecB[k];
            normA += vecA[k] * vecA[k];
            normB += vecB[k] * vecB[k];
          }
          const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);

          if (sim > 0.95) {
            duplicates.push({
              ...c,
              clipSimilarity: Math.round(sim * 10_000) / 10_000,
            });
          }
          // else: pHash false positive — drop it
        } else {
          // Vectors not available for one or both — keep pHash result unverified
          duplicates.push(c);
        }
      }
    }

    return { duplicates };
  });

export const renamePhotos = os
  .input(
    z.object({
      ids: z.array(z.number()),
      pattern: z.string().min(1),
    })
  )
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
        fs.renameSync(photo.path, newPath);
        db.update(photos)
          .set({ path: newPath, filename: newFilename })
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
      input.outputDir ||
      path.join(nodeOs.tmpdir(), `convert-${Date.now()}`);
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

export const getAiProgress = os.handler(() => {
  return getEmbeddingProgress();
});

export const getAiHealth = os.handler(async () => {
  return checkAiHealth();
});

export const clearThumbCache = os.handler(() => {
  return clearThumbnailDiskCache();
});

// AI tag suggestion
export const suggestTags = os.input(IdSchema).handler(async ({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (!photo) {
    return { photoId: input.id, suggestions: [] };
  }
  try {
    const suggestions = await aiSuggestTags(photo.path, 0.22, input.id);
    return { photoId: input.id, suggestions };
  } catch {
    return { photoId: input.id, suggestions: [] };
  }
});

// Tags
export const getTags = os.handler(() => {
  const db = getDatabase();
  return db.select().from(tags).orderBy(tags.name).all();
});

export const getPhotoTags = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  return db
    .select({
      id: tags.id,
      name: tags.name,
      color: tags.color,
      confidence: photoTags.confidence,
      isConfirmed: photoTags.isConfirmed,
    })
    .from(photoTags)
    .innerJoin(tags, eq(photoTags.tagId, tags.id))
    .where(eq(photoTags.photoId, input.id))
    .all();
});

export const addTag = os
  .input(
    z.object({ name: z.string().min(1).max(50), color: z.string().optional() })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const existing = db
      .select()
      .from(tags)
      .where(eq(tags.name, input.name))
      .get();
    if (existing) {
      return existing;
    }
    const result = db
      .insert(tags)
      .values({ name: input.name, color: input.color || null })
      .returning({ insertedId: tags.id })
      .get();
    return {
      id: result?.insertedId,
      name: input.name,
      color: input.color || null,
    };
  });

export const setPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.insert(photoTags)
      .values({
        photoId: input.photoId,
        tagId: input.tagId,
        isConfirmed: true,
      })
      .onConflictDoNothing()
      .run();
    return { ok: true };
  });

export const removePhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.delete(photoTags)
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    return { ok: true };
  });

export const confirmPhotoTag = os
  .input(z.object({ photoId: z.number(), tagId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(photoTags)
      .set({ isConfirmed: true })
      .where(
        sql`${photoTags.photoId} = ${input.photoId} AND ${photoTags.tagId} = ${input.tagId}`
      )
      .run();
    return { ok: true };
  });

export const deleteTag = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  db.delete(photoTags).where(eq(photoTags.tagId, input.id)).run();
  db.delete(tags).where(eq(tags.id, input.id)).run();
  return { ok: true };
});

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

function buildHtmlGallery(
  photos: Array<{
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
  }>
): string {
  const itemsJson = JSON.stringify(
    photos.map((p) => ({
      src: `photos/${p.filename}`,
      w: p.width,
      h: p.height,
      tags: p.tags,
      exif: p.exif
        ? {
            c: p.exif.camera,
            l: p.exif.lens,
            f: p.exif.focalLength,
            a: p.exif.aperture,
            s: p.exif.shutter,
            i: p.exif.iso,
            d: p.exif.dateTaken,
          }
        : null,
    }))
  );

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>AI Image Manager — Gallery Export</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#08090a;--surface:#1c1e22;--surface-hover:#25272d;
  --fg:#f7f8f8;--fg2:#a1a1aa;--fg3:#6b6b75;
  --accent:#5e6ad2;--border:rgba(255,255,255,0.06);--radius:8px;
}
body{font-family:'Inter Variable',system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);min-height:100vh}
header{position:sticky;top:0;z-index:10;background:rgba(8,9,10,0.85);backdrop-filter:blur(12px);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;align-items:center;gap:12px;flex-wrap:wrap}
header h1{font-size:16px;font-weight:590;white-space:nowrap}
header .count{font-size:12px;color:var(--fg3)}
#search{flex:1;min-width:180px;max-width:400px;height:32px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--fg);padding:0 12px;font-size:13px;outline:none}
#search:focus{border-color:var(--accent)}
#search::placeholder{color:var(--fg3)}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:4px;padding:4px}
.card{position:relative;aspect-ratio:1;overflow:hidden;border-radius:4px;cursor:pointer;background:var(--surface)}
.card img{width:100%;height:100%;object-fit:cover;transition:transform .3s ease}
.card:hover img{transform:scale(1.03)}
.card .overlay{position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,0.7) 0%,transparent 50%);opacity:0;transition:opacity .2s;display:flex;align-items:flex-end;padding:12px}
.card:hover .overlay{opacity:1}
.card .overlay .info{font-size:11px;color:#ccc}
.card .overlay .info .exif{font-size:10px;color:#999;margin-top:2px}
.lightbox{position:fixed;inset:0;z-index:100;background:rgba(0,0,0,0.92);display:none;align-items:center;justify-content:center;cursor:pointer}
.lightbox.open{display:flex}
.lightbox img{max-width:92vw;max-height:92vh;object-fit:contain;border-radius:4px;box-shadow:0 8px 60px rgba(0,0,0,0.6)}
.lightbox .close{position:absolute;top:16px;right:16px;width:36px;height:36px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:#fff;font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.lightbox .close:hover{background:rgba(255,255,255,0.2)}
.lightbox .nav{position:absolute;top:50%;transform:translateY(-50%);width:44px;height:44px;border-radius:50%;border:none;background:rgba(255,255,255,0.1);color:#fff;font-size:20px;cursor:pointer;display:flex;align-items:center;justify-content:center}
.lightbox .nav:hover{background:rgba(255,255,255,0.2)}
.lightbox .nav.prev{left:16px}
.lightbox .nav.next{right:16px}
.lightbox .meta{position:absolute;bottom:24px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,0.7);border-radius:8px;padding:8px 16px;font-size:12px;color:var(--fg2);text-align:center;backdrop-filter:blur(8px)}
.lightbox .meta .tags{margin-top:4px;display:flex;gap:4px;justify-content:center;flex-wrap:wrap}
.lightbox .meta .tags span{padding:1px 6px;border-radius:4px;background:var(--accent);color:#fff;font-size:10px}
.empty-state{display:flex;flex-direction:column;align-items:center;justify-content:center;height:50vh;color:var(--fg3);gap:8px}
.empty-state svg{width:48px;height:48px;opacity:0.3}
footer{text-align:center;padding:16px;font-size:11px;color:var(--fg3);border-top:1px solid var(--border);margin-top:16px}
footer a{color:var(--accent);text-decoration:none}
@media(max-width:600px){.grid{grid-template-columns:repeat(auto-fill,minmax(140px,1fr))}}
</style>
</head>
<body>
<header>
  <h1>Gallery Export</h1>
  <span class="count" id="count">${photos.length} photos</span>
  <input id="search" type="text" placeholder="Filter by tag or EXIF...">
</header>
<div class="grid" id="grid"></div>
<div class="lightbox" id="lightbox">
  <button class="close" id="lb-close">&times;</button>
  <button class="nav prev" id="lb-prev">&larr;</button>
  <button class="nav next" id="lb-next">&rarr;</button>
  <img id="lb-img" src="" alt="">
  <div class="meta" id="lb-meta"></div>
</div>
<footer>
  Generated by <a href="https://github.com/Uyoung/ai-image-manager">AI Image Manager</a>
</footer>
<script>
(function(){
  var data=${itemsJson};
  var grid=document.getElementById("grid");
  var search=document.getElementById("search");
  var lb=document.getElementById("lightbox");
  var lbImg=document.getElementById("lb-img");
  var lbMeta=document.getElementById("lb-meta");
  var currentIdx=-1;
  var filteredData=data.slice();

  function render(items){
    grid.innerHTML="";
    if(items.length===0){
      grid.innerHTML='<div class="empty-state"><svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="m21 15-5-5L5 21"/></svg><span>No matching photos</span></div>';
      return;
    }
    items.forEach(function(p,i){
      var card=document.createElement("div");
      card.className="card";
      card.innerHTML='<img src="'+p.src+'" alt="" loading="lazy"><div class="overlay"><div class="info">'+p.exif.d||''+'</div></div>';
      card.addEventListener("click",function(){openLightbox(i);});
      grid.appendChild(card);
    });
    document.getElementById("count").textContent=items.length+" photos";
  }

  function openLightbox(idx){
    currentIdx=idx;
    var p=filteredData[idx];
    lbImg.src=p.src;
    var meta="";
    if(p.exif){
      var parts=[];
      if(p.exif.d) parts.push(p.exif.d);
      if(p.exif.c) parts.push(p.exif.c);
      if(p.exif.l) parts.push(p.exif.l);
      if(p.exif.f) parts.push(p.exif.f+"mm");
      if(p.exif.a) parts.push("f/"+p.exif.a);
      if(p.exif.s) parts.push(p.exif.s+"s");
      if(p.exif.i) parts.push("ISO "+p.exif.i);
      meta=parts.join(" &middot; ");
    }
    if(p.tags.length) meta+='<div class="tags">'+p.tags.map(function(t){return '<span>'+t+'</span>';}).join("")+'</div>';
    lbMeta.innerHTML=meta;
    lb.classList.add("open");
  }

  function closeLightbox(){lb.classList.remove("open");currentIdx=-1;}
  function navLightbox(dir){
    var n=currentIdx+dir;
    if(n>=0&&n<filteredData.length) openLightbox(n);
  }

  document.getElementById("lb-close").addEventListener("click",function(e){e.stopPropagation();closeLightbox();});
  document.getElementById("lb-prev").addEventListener("click",function(e){e.stopPropagation();navLightbox(-1);});
  document.getElementById("lb-next").addEventListener("click",function(e){e.stopPropagation();navLightbox(1);});
  lb.addEventListener("click",function(e){if(e.target===lb)closeLightbox();});
  document.addEventListener("keydown",function(e){
    if(!lb.classList.contains("open")) return;
    if(e.key==="Escape") closeLightbox();
    if(e.key==="ArrowLeft") navLightbox(-1);
    if(e.key==="ArrowRight") navLightbox(1);
  });

  search.addEventListener("input",function(){
    var q=search.value.toLowerCase().trim();
    if(!q){filteredData=data.slice();}
    else{
      filteredData=data.filter(function(p){
        var text=(p.tags.join(" ")+" "+(p.exif?Object.values(p.exif).join(" "):"")).toLowerCase();
        return text.indexOf(q)>-1;
      });
    }
    render(filteredData);
    currentIdx=-1;
  });

  render(filteredData);
})();
</script>
</body>
</html>`;
}

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
    const os = await import("node:os");
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
              // JPG → JPG (no alpha to preserve), PNG → PNG, else → PNG safe fallback
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

      // Create ZIP
      const archiverModule = await import("archiver");
      const createArchive = archiverModule.default || archiverModule;
      const zipPath =
        outputPath ||
        path.join(
          nodeOs.tmpdir(),
          `gallery-${new Date().toISOString().slice(0, 10)}.zip`
        );
      const output = fs.createWriteStream(zipPath);
      const archive = createArchive("zip", { zlib: { level: 9 } });

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
