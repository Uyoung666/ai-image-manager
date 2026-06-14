import crypto from "node:crypto";
import fs from "node:fs";
import { os } from "@orpc/server";
import {
  and,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { getDatabase, getDbPath } from "@/db";
import { detectionRuns, duplicatePairs, exifData, photos } from "@/db/schema";
import { getPhotoVectors } from "@/services/ai-embedder";
import { BKTree } from "@/services/bk-tree";
import {
  aggregateFromStoredColors,
  computeColorDistribution,
  extractDominantColors,
  invalidateColorCache,
  type PaletteColor,
} from "@/services/color-extractor";
import { getThumbnailDiskUsage } from "@/services/thumbnailer";

// Module-level cache for getStats (invalidate on photo/EXIF changes)
interface StatsCacheEntry {
  data: any;
  timestamp: number;
}

let statsCache: StatsCacheEntry | null = null;
const STATS_CACHE_TTL = 30_000; // 30 seconds

export function invalidateStatsCache(): void {
  statsCache = null;
  invalidateColorCache();
}

// Lightweight: distinct EXIF values for smart album autocomplete
export const getExifCandidates = os.handler(() => {
  const db = getDatabase();

  const cameraModels = db
    .selectDistinct({ val: exifData.cameraModel })
    .from(exifData)
    .where(
      sql`${exifData.cameraModel} IS NOT NULL AND ${exifData.cameraModel} != ''`
    )
    .orderBy(exifData.cameraModel)
    .all()
    .map((r) => r.val);

  const lensModels = db
    .select({ val: exifData.lensModel })
    .from(exifData)
    .where(
      sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`
    )
    .groupBy(exifData.lensModel)
    .orderBy(desc(sql`count(*)`))
    .all()
    .map((r) => r.val);

  const focalLengths = db
    .selectDistinct({ val: exifData.focalLength })
    .from(exifData)
    .where(sql`${exifData.focalLength} IS NOT NULL`)
    .orderBy(exifData.focalLength)
    .all()
    .map((r) => r.val);

  const apertures = db
    .selectDistinct({ val: exifData.aperture })
    .from(exifData)
    .where(sql`${exifData.aperture} IS NOT NULL`)
    .orderBy(exifData.aperture)
    .all()
    .map((r) => r.val);

  const isos = db
    .selectDistinct({ val: exifData.iso })
    .from(exifData)
    .where(sql`${exifData.iso} IS NOT NULL`)
    .orderBy(exifData.iso)
    .all()
    .map((r) => r.val);

  const formats = db
    .selectDistinct({ val: photos.format })
    .from(photos)
    .where(sql`${photos.format} IS NOT NULL AND ${photos.format} != ''`)
    .orderBy(photos.format)
    .all()
    .map((r) => r.val ?? "");

  return { cameraModels, lensModels, focalLengths, apertures, isos, formats };
});

// Shared color-distribution helper — reused by getColorDistribution and getStats
async function computeDashboardColors() {
  const db = getDatabase();

  // Primary path: aggregate from pre-extracted dominant_colors
  const rows = db
    .select({ dominantColors: photos.dominantColors })
    .from(photos)
    .where(and(isNull(photos.deletedAt), isNotNull(photos.dominantColors)))
    .all();

  const allColors = rows
    .map((r) => {
      try {
        return r.dominantColors ? JSON.parse(r.dominantColors) : null;
      } catch {
        return null;
      }
    })
    .filter((c): c is PaletteColor[] => Array.isArray(c) && c.length > 0);

  if (allColors.length >= 10) {
    const result = aggregateFromStoredColors(allColors);
    return {
      globalPalette: result.palette,
      hueDistribution: result.hueDistribution,
      saturationDistribution: [
        { level: "vivid" as const, count: result.saturationCounts.vivid },
        { level: "moderate" as const, count: result.saturationCounts.moderate },
        { level: "muted" as const, count: result.saturationCounts.muted },
      ],
      sampled: result.totalPhotos,
      totalPhotos: result.totalPhotos,
      source: "db" as const,
    };
  }

  // Fallback: real-time histogram sampling
  console.log(
    `[Stats] Not enough dominant_colors data (${allColors.length}), falling back to sampling`
  );

  const totalCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(
        sql`${photos.deletedAt} IS NULL AND ${photos.thumbnailPath} IS NOT NULL`
      )
      .get()?.count ?? 0;

  const samplePhotos = db
    .select({ path: photos.path, thumbnailPath: photos.thumbnailPath })
    .from(photos)
    .where(
      sql`${photos.deletedAt} IS NULL AND ${photos.thumbnailPath} IS NOT NULL`
    )
    .orderBy(sql`random()`)
    .limit(200)
    .all();

  return computeColorDistribution(samplePhotos, totalCount);
}

// Color distribution (standalone — also available merged into getStats)
export const getColorDistribution = os.handler(async () => {
  return computeDashboardColors();
});

// Statistics for dashboard (optionally includes color distribution)
export const getStats = os
  .input(z.object({ includeColors: z.boolean().optional().default(false) }))
  .handler(async ({ input }) => {
    // Return cached stats if fresh (and colors already included if requested)
    if (
      statsCache &&
      Date.now() - statsCache.timestamp < STATS_CACHE_TTL &&
      (!input.includeColors || statsCache.data.colorDistribution)
    ) {
      return statsCache.data;
    }

    const db = getDatabase();

    // Single query for total + AI-processed counts
    const photoCounts = db
      .select({
        total: sql<number>`count(*)`,
        aiProcessed: sql<number>`sum(case when ${photos.isAiProcessed} = 1 then 1 else 0 end)`,
      })
      .from(photos)
      .get();
    const totalPhotos = photoCounts?.total ?? 0;
    const aiProcessed = photoCounts?.aiProcessed ?? 0;

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
      .orderBy(exifData.focalLengthNum)
      .limit(20)
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
    // ISO distribution by common ranges (SQL-level bucketing)
    const isoBuckets = db
      .select({
        b1: sql<number>`COUNT(CASE WHEN ${exifData.iso} <= 200 THEN 1 END)`,
        b2: sql<number>`COUNT(CASE WHEN ${exifData.iso} > 200 AND ${exifData.iso} <= 400 THEN 1 END)`,
        b3: sql<number>`COUNT(CASE WHEN ${exifData.iso} > 400 AND ${exifData.iso} <= 800 THEN 1 END)`,
        b4: sql<number>`COUNT(CASE WHEN ${exifData.iso} > 800 AND ${exifData.iso} <= 1600 THEN 1 END)`,
        b5: sql<number>`COUNT(CASE WHEN ${exifData.iso} > 1600 THEN 1 END)`,
      })
      .from(exifData)
      .where(sql`${exifData.iso} IS NOT NULL`)
      .get();

    const isoResult = [
      { range: "50-200", count: isoBuckets?.b1 || 0 },
      { range: "200-400", count: isoBuckets?.b2 || 0 },
      { range: "400-800", count: isoBuckets?.b3 || 0 },
      { range: "800-1600", count: isoBuckets?.b4 || 0 },
      { range: "1600+", count: isoBuckets?.b5 || 0 },
    ];

    // Lens model distribution
    const lensStats = db
      .select({
        model: exifData.lensModel,
        count: sql<number>`count(*)`,
      })
      .from(exifData)
      .where(
        sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`
      )
      .groupBy(exifData.lensModel)
      .orderBy(desc(sql`count(*)`))
      .limit(8)
      .all();

    // Shutter speed distribution (SQL-level bucketing)
    const shutterBuckets = db
      .select({
        b1: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} < 0.001 THEN 1 END)`,
        b2: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.001 AND ${exifData.shutterSpeedNum} < 0.002 THEN 1 END)`,
        b3: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.002 AND ${exifData.shutterSpeedNum} < 0.004 THEN 1 END)`,
        b4: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.004 AND ${exifData.shutterSpeedNum} < 0.008 THEN 1 END)`,
        b5: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.008 AND ${exifData.shutterSpeedNum} < 0.0167 THEN 1 END)`,
        b6: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.0167 AND ${exifData.shutterSpeedNum} < 0.0333 THEN 1 END)`,
        b7: sql<number>`COUNT(CASE WHEN ${exifData.shutterSpeedNum} >= 0.0333 THEN 1 END)`,
      })
      .from(exifData)
      .where(sql`${exifData.shutterSpeedNum} IS NOT NULL`)
      .get();

    const shutterResult = [
      { range: ">1/1000s", count: shutterBuckets?.b1 || 0 },
      { range: "1/1000s-1/500s", count: shutterBuckets?.b2 || 0 },
      { range: "1/500s-1/250s", count: shutterBuckets?.b3 || 0 },
      { range: "1/250s-1/125s", count: shutterBuckets?.b4 || 0 },
      { range: "1/125s-1/60s", count: shutterBuckets?.b5 || 0 },
      { range: "1/60s-1/30s", count: shutterBuckets?.b6 || 0 },
      { range: "<1/30s", count: shutterBuckets?.b7 || 0 },
    ];

    // Single pass over dateTaken for hour buckets, yearly stats, monthly stats and date range
    const allDates = db
      .select({ dateTaken: exifData.dateTaken })
      .from(exifData)
      .where(sql`${exifData.dateTaken} IS NOT NULL`)
      .all();

    const hourBuckets24 = new Array(24).fill(0);
    const yearCount = new Map<string, number>();
    const monthCount = new Map<string, number>();
    let earliest = Number.POSITIVE_INFINITY;
    let latest = Number.NEGATIVE_INFINITY;

    for (const row of allDates) {
      const ts = row.dateTaken!;
      const d = new Date(ts);
      hourBuckets24[d.getHours()]++;

      const yearStr = d.getFullYear().toString();
      yearCount.set(yearStr, (yearCount.get(yearStr) || 0) + 1);

      const monthStr = String(d.getMonth() + 1).padStart(2, "0");
      monthCount.set(monthStr, (monthCount.get(monthStr) || 0) + 1);

      if (ts < earliest) {
        earliest = ts;
      }
      if (ts > latest) {
        latest = ts;
      }
    }

    const yearlyStats = Array.from(yearCount.entries())
      .map(([year, count]) => ({ year, count }))
      .sort((a, b) => a.year.localeCompare(b.year));

    const monthlyStats = Array.from(monthCount.entries())
      .map(([month, count]) => ({ month, count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    const dateRange =
      earliest < Number.POSITIVE_INFINITY
        ? { earliest, latest }
        : {
            earliest: null as unknown as number,
            latest: null as unknown as number,
          };

    const avgIso =
      db
        .select({ avgIso: sql<number>`avg(${exifData.iso})` })
        .from(exifData)
        .where(sql`${exifData.iso} IS NOT NULL`)
        .get()?.avgIso || 0;

    // GPS geo-locations for map display
    const geoLocations = db
      .select({
        photoId: exifData.photoId,
        latitude: exifData.gpsLatitude,
        longitude: exifData.gpsLongitude,
        filename: photos.filename,
        path: photos.path,
        width: photos.width,
        height: photos.height,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        sql`${exifData.gpsLatitude} IS NOT NULL AND ${exifData.gpsLongitude} IS NOT NULL AND ${photos.deletedAt} IS NULL`
      )
      .all();

    const result = {
      totalPhotos,
      aiProcessed,
      cameraStats: cameraStats.filter((c) => c.model),
      lensStats: lensStats.filter((l) => l.model),
      focalStats: focalStats.filter((f) => f.focalLength),
      apertureStats: apertureStats.filter((a) => a.aperture),
      isoDistribution: isoResult,
      timeHeatmap: hourBuckets24.map((count, hour) => ({
        period: `${hour.toString().padStart(2, "0")}:00`,
        count,
      })),
      shutterSpeedDistribution: shutterResult,
      yearlyStats,
      monthlyStats,
      dateRange,
      avgIso,
      geoLocations: geoLocations.map((g) => ({
        photoId: g.photoId!,
        latitude: g.latitude!,
        longitude: g.longitude!,
        filename: g.filename,
        path: g.path,
        width: g.width,
        height: g.height,
      })),
    };

    // Optionally include color distribution in the same IPC call
    if (input.includeColors) {
      try {
        (result as any).colorDistribution = await computeDashboardColors();
      } catch (err) {
        console.error("[getStats] colorDistribution failed:", err);
        (result as any).colorDistribution = null;
      }
    }

    statsCache = { data: result, timestamp: Date.now() };
    return result;
  });

async function computeFileHash(filePath: string): Promise<string | null> {
  try {
    const fd = await fs.promises.open(filePath, "r");
    const stat = await fd.stat();
    const size = stat.size;
    const hash = crypto.createHash("sha256");

    if (size <= 8192) {
      const buf = Buffer.alloc(size);
      await fd.read(buf, 0, size, 0);
      hash.update(buf);
    } else {
      const head = Buffer.alloc(4096);
      await fd.read(head, 0, 4096, 0);
      hash.update(head);
      const tail = Buffer.alloc(4096);
      await fd.read(tail, 0, 4096, size - 4096);
      hash.update(tail);
      const sizeBuffer = Buffer.alloc(8);
      sizeBuffer.writeBigInt64LE(BigInt(size));
      hash.update(sizeBuffer);
    }
    await fd.close();
    return hash.digest("hex");
  } catch {
    return null;
  }
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let k = 0; k < a.length; k++) {
    dot += a[k] * b[k];
    normA += a[k] * a[k];
    normB += b[k] * b[k];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) || 1);
}

export const findDuplicates = os
  .input(
    z.object({
      threshold: z.number().optional().default(8),
      forceRescan: z.boolean().optional().default(false),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();

    // If not forcing rescan, return persisted results
    if (!input.forceRescan) {
      const existing = db
        .select()
        .from(duplicatePairs)
        .where(
          or(
            eq(duplicatePairs.status, "pending"),
            eq(duplicatePairs.status, "confirmed")
          )
        )
        .all();

      if (existing.length > 0) {
        const photoIds = new Set<number>();
        for (const pair of existing) {
          photoIds.add(pair.photoAId);
          photoIds.add(pair.photoBId);
        }
        const photoMap = new Map<
          number,
          {
            id: number;
            path: string;
            filename: string;
            fileSize: number | null;
            width: number | null;
            height: number | null;
            createdAt: number;
            thumbnailPath: string | null;
          }
        >();
        const photoRows = db
          .select({
            id: photos.id,
            path: photos.path,
            filename: photos.filename,
            fileSize: photos.fileSize,
            width: photos.width,
            height: photos.height,
            createdAt: photos.createdAt,
            thumbnailPath: photos.thumbnailPath,
          })
          .from(photos)
          .where(inArray(photos.id, Array.from(photoIds)))
          .all();
        for (const p of photoRows) {
          photoMap.set(p.id, p);
        }

        const duplicates = existing
          .map((pair) => {
            const a = photoMap.get(pair.photoAId);
            const b = photoMap.get(pair.photoBId);
            if (!(a && b)) {
              return null;
            }
            return {
              pairId: pair.id,
              photoA: {
                id: a.id,
                path: a.path,
                filename: a.filename,
                fileSize: a.fileSize,
                width: a.width,
                height: a.height,
                createdAt: a.createdAt,
                thumbnailPath: a.thumbnailPath,
              },
              photoB: {
                id: b.id,
                path: b.path,
                filename: b.filename,
                fileSize: b.fileSize,
                width: b.width,
                height: b.height,
                createdAt: b.createdAt,
                thumbnailPath: b.thumbnailPath,
              },
              matchType: pair.matchType as "exact" | "phash" | "clip_confirmed",
              distance: pair.phashDistance ?? 0,
              clipSimilarity: pair.clipSimilarity,
              status: pair.status as "pending" | "confirmed",
            };
          })
          .filter(Boolean);

        return { duplicates, fromCache: true };
      }
    }

    // Full detection scan
    const allPhotos = db
      .select({
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        fileSize: photos.fileSize,
        phash: photos.phash,
        contentHash: photos.contentHash,
        width: photos.width,
        height: photos.height,
        createdAt: photos.createdAt,
        thumbnailPath: photos.thumbnailPath,
      })
      .from(photos)
      .where(isNull(photos.deletedAt))
      .all();

    if (allPhotos.length === 0) {
      return { duplicates: [], fromCache: false };
    }

    // --- Phase 0: Exact duplicate detection via content hash ---
    const sizeGroups = new Map<number, typeof allPhotos>();
    for (const p of allPhotos) {
      if (p.fileSize && p.fileSize > 0) {
        const group = sizeGroups.get(p.fileSize);
        if (group) {
          group.push(p);
        } else {
          sizeGroups.set(p.fileSize, [p]);
        }
      }
    }

    interface CandidatePair {
      clipSimilarity: number | null;
      matchType: "exact" | "phash" | "clip_confirmed";
      phashDistance: number;
      photoAId: number;
      photoBId: number;
    }

    const candidates: CandidatePair[] = [];
    const seenPairs = new Set<string>();

    // Collect all photos across all size-groups that are missing a content hash
    const needsHash: (typeof allPhotos)[0][] = [];
    for (const group of sizeGroups.values()) {
      if (group.length < 2) {
        continue;
      }
      for (const p of group) {
        if (!p.contentHash) {
          needsHash.push(p);
        }
      }
    }

    // Compute missing hashes (file I/O — the bottleneck, not DB writes)
    for (const p of needsHash) {
      const hash = await computeFileHash(p.path);
      if (hash) {
        p.contentHash = hash;
      }
    }

    // Batch UPDATE in a single transaction
    if (needsHash.length > 0) {
      db.transaction(() => {
        for (const p of needsHash) {
          if (p.contentHash) {
            db.update(photos)
              .set({ contentHash: p.contentHash })
              .where(eq(photos.id, p.id))
              .run();
          }
        }
      });
    }

    for (const group of sizeGroups.values()) {
      if (group.length < 2) {
        continue;
      }

      // Group by content hash
      const hashGroups = new Map<string, typeof group>();
      for (const p of group) {
        if (!p.contentHash) {
          continue;
        }
        const hg = hashGroups.get(p.contentHash);
        if (hg) {
          hg.push(p);
        } else {
          hashGroups.set(p.contentHash, [p]);
        }
      }

      for (const hGroup of hashGroups.values()) {
        if (hGroup.length < 2) {
          continue;
        }
        for (let i = 0; i < hGroup.length; i++) {
          for (let j = i + 1; j < hGroup.length; j++) {
            const aId = Math.min(hGroup[i].id, hGroup[j].id);
            const bId = Math.max(hGroup[i].id, hGroup[j].id);
            const key = `${aId}_${bId}`;
            if (seenPairs.has(key)) {
              continue;
            }
            seenPairs.add(key);
            candidates.push({
              photoAId: aId,
              photoBId: bId,
              matchType: "exact",
              phashDistance: 0,
              clipSimilarity: null,
            });
          }
        }
      }
    }

    // --- Phase 1: BK-Tree pHash near-neighbor search ---
    const photosWithHash = allPhotos.filter((p) => p.phash);
    const bkTree = new BKTree();
    for (const p of photosWithHash) {
      bkTree.insert(p.id, p.phash!);
    }

    let phashProcessed = 0;
    for (const p of photosWithHash) {
      phashProcessed++;
      const neighbors = bkTree.query(p.phash!, input.threshold);
      for (const n of neighbors) {
        if (n.photoId === p.id) {
          continue;
        }
        const aId = Math.min(p.id, n.photoId);
        const bId = Math.max(p.id, n.photoId);
        const key = `${aId}_${bId}`;
        if (seenPairs.has(key)) {
          continue;
        }
        seenPairs.add(key);
        candidates.push({
          photoAId: aId,
          photoBId: bId,
          matchType: "phash",
          phashDistance: n.distance,
          clipSimilarity: null,
        });
      }

      // Yield event loop every 500 photos
      if (phashProcessed % 500 === 0) {
        await new Promise<void>((r) => setImmediate(r));
      }
    }

    // --- Phase 2: CLIP vector verification ---
    // Sort by distance (lower = more likely duplicate)
    candidates.sort((a, b) => a.phashDistance - b.phashDistance);

    const uniqueIds = new Set<number>();
    for (const c of candidates) {
      uniqueIds.add(c.photoAId);
      uniqueIds.add(c.photoBId);
    }

    let vectors: Map<number, number[]> = new Map();
    try {
      vectors = await getPhotoVectors(Array.from(uniqueIds));
    } catch {
      // LanceDB unavailable
    }

    const confirmedPairs: CandidatePair[] = [];

    for (const c of candidates) {
      if (c.matchType === "exact") {
        // Exact SHA-256 match �?no CLIP needed
        confirmedPairs.push(c);
        continue;
      }

      const vecA = vectors.get(c.photoAId);
      const vecB = vectors.get(c.photoBId);

      if (vecA && vecB && vecA.length === vecB.length) {
        const sim = cosineSimilarity(vecA, vecB);
        if (sim > 0.95) {
          c.clipSimilarity = Math.round(sim * 10_000) / 10_000;
          c.matchType = "clip_confirmed";
          confirmedPairs.push(c);
        }
      } else {
        // No vectors: use distance-based confidence
        if (c.phashDistance <= 3) {
          // High confidence without CLIP
          confirmedPairs.push(c);
        } else if (c.phashDistance <= input.threshold) {
          // distance 4-8 without vectors: keep as pending for manual review
          c.matchType = "phash";
          confirmedPairs.push(c);
        }
      }
    }

    // --- Persist results ---
    // Clear old results before inserting new ones
    db.transaction(() => {
      db.delete(duplicatePairs).run();

      if (confirmedPairs.length > 0) {
        for (const pair of confirmedPairs) {
          db.insert(duplicatePairs)
            .values({
              photoAId: pair.photoAId,
              photoBId: pair.photoBId,
              matchType: pair.matchType,
              phashDistance: pair.phashDistance,
              clipSimilarity: pair.clipSimilarity,
              status:
                pair.matchType === "exact" ||
                pair.matchType === "clip_confirmed"
                  ? "confirmed"
                  : "pending",
            })
            .onConflictDoNothing()
            .run();
        }
      }
    });

    // Record detection run
    const maxId = allPhotos.reduce((max, p) => Math.max(max, p.id), 0);
    db.insert(detectionRuns)
      .values({
        lastPhotoId: maxId,
        photosProcessed: allPhotos.length,
        pairsFound: confirmedPairs.length,
      })
      .run();

    // Build response with photo metadata
    const photoMap = new Map<number, (typeof allPhotos)[0]>();
    for (const p of allPhotos) {
      photoMap.set(p.id, p);
    }

    const duplicates = confirmedPairs
      .map((pair) => {
        const a = photoMap.get(pair.photoAId);
        const b = photoMap.get(pair.photoBId);
        if (!(a && b)) {
          return null;
        }
        return {
          pairId: null as number | null,
          photoA: {
            id: a.id,
            path: a.path,
            filename: a.filename,
            fileSize: a.fileSize,
            width: a.width,
            height: a.height,
            createdAt: a.createdAt,
            thumbnailPath: a.thumbnailPath,
          },
          photoB: {
            id: b.id,
            path: b.path,
            filename: b.filename,
            fileSize: b.fileSize,
            width: b.width,
            height: b.height,
            createdAt: b.createdAt,
            thumbnailPath: b.thumbnailPath,
          },
          matchType: pair.matchType as "exact" | "phash" | "clip_confirmed",
          distance: pair.phashDistance,
          clipSimilarity: pair.clipSimilarity,
          status: (pair.matchType === "exact" ||
          pair.matchType === "clip_confirmed"
            ? "confirmed"
            : "pending") as "pending" | "confirmed",
        };
      })
      .filter(Boolean);

    return { duplicates, fromCache: false };
  });

export const dismissDuplicate = os
  .input(z.object({ pairId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(duplicatePairs)
      .set({ status: "dismissed", resolvedAt: Date.now() })
      .where(eq(duplicatePairs.id, input.pairId))
      .run();
    return { success: true };
  });

export const getDuplicateStats = os.handler(() => {
  const db = getDatabase();
  // Single conditional-aggregation query instead of 4 separate COUNTs
  const stats = db
    .select({
      total: sql<number>`count(*)`,
      pending: sql<number>`sum(case when ${duplicatePairs.status} = 'pending' then 1 else 0 end)`,
      confirmed: sql<number>`sum(case when ${duplicatePairs.status} = 'confirmed' then 1 else 0 end)`,
      dismissed: sql<number>`sum(case when ${duplicatePairs.status} = 'dismissed' then 1 else 0 end)`,
    })
    .from(duplicatePairs)
    .get();
  const lastRun = db
    .select()
    .from(detectionRuns)
    .orderBy(desc(detectionRuns.completedAt))
    .limit(1)
    .get();
  return {
    total: stats?.total ?? 0,
    pending: stats?.pending ?? 0,
    confirmed: stats?.confirmed ?? 0,
    dismissed: stats?.dismissed ?? 0,
    lastRun,
  };
});

// Index info for the settings page: thumbnail cache location/size,
// database file location, and counts of valid vs invalid photo records.
// "Invalid" matches cleanupOrphanPhotos: photos whose folderId is NULL or
// points at a folder that no longer exists.
export const getIndexStats = os.input(z.object({}).optional()).handler(() => {
  const db = getDatabase();

  const thumb = getThumbnailDiskUsage();
  const databasePath = getDbPath();

  const validPhotoCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(sql`${photos.deletedAt} IS NULL`)
      .get()?.count || 0;

  const invalidPhotoCount =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(
        sql`${photos.deletedAt} IS NULL AND (${photos.folderId} IS NULL OR ${photos.folderId} NOT IN (SELECT id FROM folders))`
      )
      .get()?.count || 0;

  return {
    thumbnailCacheDir: thumb.dir,
    thumbnailCacheBytes: thumb.bytes,
    thumbnailCacheFileCount: thumb.fileCount,
    databasePath,
    validPhotoCount,
    invalidPhotoCount,
  };
});

// ── Color migration: backfill dominant_colors for existing photos ─────
// Exported as a plain function so main.ts can call it directly on startup,
// and also exposed as an oRPC handler for manual trigger from the frontend.

export async function runColorMigration(
  force = false
): Promise<{ processed: number; total: number; complete: boolean }> {
  const db = getDatabase();

  if (force) {
    // Clear existing color data for re-extraction
    db.run(
      sql`UPDATE photos SET dominant_colors = NULL WHERE deleted_at IS NULL`
    );
  }

  const photoRows = db
    .select({ id: photos.id, thumbnailPath: photos.thumbnailPath })
    .from(photos)
    .where(
      and(
        isNull(photos.deletedAt),
        isNotNull(photos.thumbnailPath),
        isNull(photos.dominantColors)
      )
    )
    .all();

  const total = photoRows.length;
  let processed = 0;

  for (const photo of photoRows) {
    try {
      const colors = await extractDominantColors(photo.thumbnailPath!);
      if (colors) {
        db.run(
          sql`UPDATE photos SET dominant_colors = ${colors} WHERE id = ${photo.id}`
        );
      }
    } catch (err) {
      console.warn(`[ColorMigration] Failed for photo ${photo.id}:`, err);
    }
    processed++;

    if (processed % 10 === 0 || processed === total) {
      console.log(`[ColorMigration] Progress: ${processed}/${total}`);
    }
  }

  // Mark migration complete so startup skip works on subsequent launches
  console.log("[ColorMigration] Writing completion marker...");
  try {
    db.run(
      sql`INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES ('colors_migrated', 'true', ${Date.now()})`
    );
    console.log("[ColorMigration] Completion marker written.");
  } catch (err) {
    console.error("[ColorMigration] Failed to write completion marker:", err);
  }

  // Invalidate cached color distribution so the dashboard picks up fresh data
  try {
    invalidateColorCache();
    console.log("[ColorMigration] Color cache invalidated.");
  } catch (err) {
    console.warn("[ColorMigration] Failed to invalidate cache:", err);
  }

  console.log("[ColorMigration] Background backfill complete.");
  return { processed, total, complete: true };
}

export const migrateColors = os
  .input(z.object({ force: z.boolean().optional().default(false) }))
  .handler(({ input }) => {
    return runColorMigration(input.force);
  });
