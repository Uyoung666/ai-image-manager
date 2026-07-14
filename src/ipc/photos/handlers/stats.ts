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
  includesColors: boolean;
  includesGeo: boolean;
  timestamp: number;
}

let statsCache: StatsCacheEntry | null = null;
const STATS_CACHE_TTL = 30_000; // 30 seconds

export function invalidateStatsCache(): void {
  statsCache = null;
  invalidateColorCache();
}

// Cache for getExifCandidates — EXIF values only change on import/delete
interface ExifCandidatesCacheEntry {
  data: {
    cameraModels: (string | null)[];
    lensModels: (string | null)[];
    focalLengths: string[];
    apertures: number[];
    isos: (number | null)[];
    formats: string[];
  };
  timestamp: number;
}
let exifCandidatesCache: ExifCandidatesCacheEntry | null = null;
const EXIF_CANDIDATES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export function invalidateExifCandidatesCache(): void {
  exifCandidatesCache = null;
}

// Lightweight: distinct EXIF values for smart album autocomplete
export const getExifCandidates = os.handler(() => {
  // Return cached result if fresh
  if (
    exifCandidatesCache &&
    Date.now() - exifCandidatesCache.timestamp < EXIF_CANDIDATES_CACHE_TTL
  ) {
    return exifCandidatesCache.data;
  }

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

  // Round to prevent precision artifacts from EXIF rational conversion
  const focalLengths = db
    .selectDistinct({
      val: sql<string>`CAST(ROUND(${exifData.focalLengthNum}, 0) AS TEXT)`,
    })
    .from(exifData)
    .where(sql`${exifData.focalLengthNum} IS NOT NULL`)
    .orderBy(sql`ROUND(${exifData.focalLengthNum}, 0)`)
    .all()
    .map((r) => r.val);

  const apertures = db
    .selectDistinct({
      val: sql<number>`ROUND(${exifData.aperture}, 1)`,
    })
    .from(exifData)
    .where(sql`${exifData.aperture} IS NOT NULL`)
    .orderBy(sql`ROUND(${exifData.aperture}, 1)`)
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

  const result = { cameraModels, lensModels, focalLengths, apertures, isos, formats };
  exifCandidatesCache = { data: result, timestamp: Date.now() };
  return result;
});

// Shared color-distribution helper — reused by getColorDistribution and getStats
function computeDashboardColors() {
  const db = getDatabase();

  const totalPhotos =
    db
      .select({ count: sql<number>`count(*)` })
      .from(photos)
      .where(isNull(photos.deletedAt))
      .get()?.count ?? 0;

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
      totalPhotos,
      source: "db" as const,
    };
  }

  // Fallback: real-time histogram sampling
  console.log(
    `[Stats] Not enough dominant_colors data (${allColors.length}), falling back to sampling`
  );

  const samplePhotos = db
    .select({ path: photos.path, thumbnailPath: photos.thumbnailPath })
    .from(photos)
    .where(
      sql`${photos.deletedAt} IS NULL AND ${photos.thumbnailPath} IS NOT NULL`
    )
    .orderBy(sql`random()`)
    .limit(200)
    .all();

  return computeColorDistribution(samplePhotos, totalPhotos);
}

// Color distribution (standalone — also available merged into getStats)
export const getColorDistribution = os.handler(() => computeDashboardColors());

function getDashboardGeoLocations() {
  const db = getDatabase();
  return db
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
      and(
        isNull(photos.deletedAt),
        isNotNull(exifData.gpsLatitude),
        isNotNull(exifData.gpsLongitude)
      )
    )
    .limit(2000)
    .all()
    .filter(
      (
        location
      ): location is typeof location & {
        latitude: number;
        longitude: number;
        photoId: number;
      } =>
        location.photoId !== null &&
        location.latitude !== null &&
        location.longitude !== null
    )
    .map((location) => ({
      photoId: location.photoId,
      latitude: location.latitude,
      longitude: location.longitude,
      filename: location.filename,
      path: location.path,
      width: location.width,
      height: location.height,
    }));
}

export const getGeoLocations = os.handler(() => getDashboardGeoLocations());

// Statistics for dashboard (optionally includes color distribution)
export const getStats = os
  .input(
    z.object({
      includeColors: z.boolean().optional().default(false),
      includeGeo: z.boolean().optional().default(true),
    })
  )
  .handler(({ input }) => {
    // Return cached stats if fresh (and colors already included if requested)
    if (
      statsCache &&
      Date.now() - statsCache.timestamp < STATS_CACHE_TTL &&
      (!input.includeColors || statsCache.includesColors) &&
      (!input.includeGeo || statsCache.includesGeo)
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
      .where(isNull(photos.deletedAt))
      .get();
    const totalPhotos = photoCounts?.total ?? 0;
    const aiProcessed = photoCounts?.aiProcessed ?? 0;

    // EXIF completeness: single conditional-aggregation query so every
    // chart can show how many photos are missing each field. This prevents
    // the "silent data loss" where chart totals don't add up to totalPhotos.
    const completeness = db
      .select({
        withExif: sql<number>`count(*)`,
        missingCamera: sql<number>`SUM(CASE WHEN ${exifData.cameraModel} IS NULL OR ${exifData.cameraModel} = '' THEN 1 ELSE 0 END)`,
        missingLens: sql<number>`SUM(CASE WHEN ${exifData.lensModel} IS NULL OR ${exifData.lensModel} = '' THEN 1 ELSE 0 END)`,
        missingFocal: sql<number>`SUM(CASE WHEN ${exifData.focalLength} IS NULL THEN 1 ELSE 0 END)`,
        missingAperture: sql<number>`SUM(CASE WHEN ${exifData.aperture} IS NULL THEN 1 ELSE 0 END)`,
        missingIso: sql<number>`SUM(CASE WHEN ${exifData.iso} IS NULL THEN 1 ELSE 0 END)`,
        missingShutter: sql<number>`SUM(CASE WHEN ${exifData.shutterSpeedNum} IS NULL THEN 1 ELSE 0 END)`,
        missingDate: sql<number>`SUM(CASE WHEN ${exifData.dateTaken} IS NULL THEN 1 ELSE 0 END)`,
        missingGps: sql<number>`SUM(CASE WHEN ${exifData.gpsLatitude} IS NULL OR ${exifData.gpsLongitude} IS NULL THEN 1 ELSE 0 END)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(isNull(photos.deletedAt))
      .get();

    const cameraStats = db
      .select({
        model: exifData.cameraModel,
        count: sql<number>`count(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        and(
          isNull(photos.deletedAt),
          sql`${exifData.cameraModel} IS NOT NULL AND ${exifData.cameraModel} != ''`
        )
      )
      .groupBy(exifData.cameraModel)
      .orderBy(desc(sql`count(*)`))
      .limit(20)
      .all();

    // ROUND(focal_length_num, 0) prevents EXIF rational→float precision
    // artifacts (e.g. 85.00000000001 → 85) from splitting GROUP BY buckets.
    const focalStats = db
      .select({
        focalLength: sql<string>`CAST(ROUND(${exifData.focalLengthNum}, 0) AS TEXT)`,
        count: sql<number>`count(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        and(isNull(photos.deletedAt), isNotNull(exifData.focalLengthNum))
      )
      .groupBy(sql`ROUND(${exifData.focalLengthNum}, 0)`)
      .orderBy(desc(sql`count(*)`))
      .limit(50)
      .all();

    // ROUND(aperture, 1) merges near-identical values from EXIF rational
    // precision artifacts (e.g. 1.9999999713880652 → 2.0 → GROUP BY f/2).
    const apertureStats = db
      .select({
        aperture: sql<number>`ROUND(${exifData.aperture}, 1)`,
        count: sql<number>`count(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.aperture)))
      .groupBy(sql`ROUND(${exifData.aperture}, 1)`)
      .orderBy(desc(sql`count(*)`))
      .limit(50)
      .all();
    // ISO distribution by common ranges (SQL-level bucketing)
    const isoBuckets = db
      .select({
        b1: sql<number>`COUNT(CASE WHEN ${exifData.iso} <= 200 THEN 1 END)`,
        b2: sql<number>`COUNT(CASE WHEN ${exifData.iso} >= 201 AND ${exifData.iso} <= 399 THEN 1 END)`,
        b3: sql<number>`COUNT(CASE WHEN ${exifData.iso} >= 400 AND ${exifData.iso} <= 799 THEN 1 END)`,
        b4: sql<number>`COUNT(CASE WHEN ${exifData.iso} >= 800 AND ${exifData.iso} <= 1599 THEN 1 END)`,
        b5: sql<number>`COUNT(CASE WHEN ${exifData.iso} >= 1600 THEN 1 END)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.iso)))
      .get();

    const isoResult = [
      { range: "≤200", count: isoBuckets?.b1 || 0, max: 200 },
      { range: "201-399", count: isoBuckets?.b2 || 0, min: 201, max: 399 },
      { range: "400-799", count: isoBuckets?.b3 || 0, min: 400, max: 799 },
      { range: "800-1599", count: isoBuckets?.b4 || 0, min: 800, max: 1599 },
      { range: "1600+", count: isoBuckets?.b5 || 0, min: 1600 },
    ];

    // Lens model distribution
    const lensStats = db
      .select({
        model: exifData.lensModel,
        count: sql<number>`count(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        and(
          isNull(photos.deletedAt),
          sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`
        )
      )
      .groupBy(exifData.lensModel)
      .orderBy(desc(sql`count(*)`))
      .limit(20)
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
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        and(isNull(photos.deletedAt), isNotNull(exifData.shutterSpeedNum))
      )
      .get();

    const shutterResult = [
      {
        range: ">1/1000s",
        count: shutterBuckets?.b1 || 0,
        max: 0.000_999_999,
      },
      {
        range: "1/1000s-1/500s",
        count: shutterBuckets?.b2 || 0,
        min: 0.001,
        max: 0.001_999_999,
      },
      {
        range: "1/500s-1/250s",
        count: shutterBuckets?.b3 || 0,
        min: 0.002,
        max: 0.003_999_999,
      },
      {
        range: "1/250s-1/125s",
        count: shutterBuckets?.b4 || 0,
        min: 0.004,
        max: 0.007_999_999,
      },
      {
        range: "1/125s-1/60s",
        count: shutterBuckets?.b5 || 0,
        min: 0.008,
        max: 0.016_699_999,
      },
      {
        range: "1/60s-1/30s",
        count: shutterBuckets?.b6 || 0,
        min: 0.0167,
        max: 0.033_299_999,
      },
      { range: "<1/30s", count: shutterBuckets?.b7 || 0, min: 0.0333 },
    ];

    // Aggregate in the user's local timezone so the chart reflects shooting habits.
    const hourlyRows = db
      .select({
        hour: sql<string>`strftime('%H', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`,
        count: sql<number>`COUNT(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.dateTaken)))
      .groupBy(
        sql`strftime('%H', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`
      )
      .all();
    const hourCountMap = new Map(
      hourlyRows.map((row) => [Number.parseInt(row.hour, 10), row.count])
    );
    const hourBuckets24 = Array.from(
      { length: 24 },
      (_, hour) => hourCountMap.get(hour) ?? 0
    );

    // Yearly stats — GROUP BY in SQL
    const yearlyRows = db
      .select({
        year: sql<string>`CAST(strftime('%Y', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS TEXT)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.dateTaken)))
      .groupBy(
        sql`strftime('%Y', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`
      )
      .all();
    const yearlyStats = yearlyRows
      .map((r) => ({ year: r.year, count: r.count }))
      .sort((a, b) => a.year.localeCompare(b.year));

    // Monthly stats — GROUP BY in SQL
    const monthlyRows = db
      .select({
        month: sql<string>`CAST(strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS TEXT)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.dateTaken)))
      .groupBy(
        sql`strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`
      )
      .all();
    const monthlyStats = monthlyRows
      .map((r) => ({ month: r.month, count: r.count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Date range in SQL
    const rangeRow = db
      .select({
        earliest: sql<number>`MIN(${exifData.dateTaken})`,
        latest: sql<number>`MAX(${exifData.dateTaken})`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(isNull(photos.deletedAt), isNotNull(exifData.dateTaken)))
      .get();

    const dateRange =
      rangeRow?.earliest != null
        ? { earliest: rangeRow.earliest, latest: rangeRow.latest }
        : null;

    const avgIso =
      db
        .select({ avgIso: sql<number>`avg(${exifData.iso})` })
        .from(exifData)
        .innerJoin(photos, eq(exifData.photoId, photos.id))
        .where(and(isNull(photos.deletedAt), isNotNull(exifData.iso)))
        .get()?.avgIso || 0;

    const geoLocations = input.includeGeo ? getDashboardGeoLocations() : [];

    const result = {
      totalPhotos,
      aiProcessed,
      exifCompleteness: completeness
        ? {
            withExif: completeness.withExif,
            missingCamera: completeness.missingCamera,
            missingLens: completeness.missingLens,
            missingFocal: completeness.missingFocal,
            missingAperture: completeness.missingAperture,
            missingIso: completeness.missingIso,
            missingShutter: completeness.missingShutter,
            missingDate: completeness.missingDate,
            missingGps: completeness.missingGps,
            // Photos in the photos table that have no exif_data row at all
            withoutExif: totalPhotos - completeness.withExif,
          }
        : null,
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
      geoLocations,
    };

    // Optionally include color distribution in the same IPC call
    if (input.includeColors) {
      try {
        (result as any).colorDistribution = computeDashboardColors();
      } catch (err) {
        console.error("[getStats] colorDistribution failed:", err);
        (result as any).colorDistribution = null;
      }
    }

    statsCache = {
      data: result,
      includesColors: input.includeColors,
      includesGeo: input.includeGeo,
      timestamp: Date.now(),
    };
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

// ── Index stats cache (mirrors statsCache pattern above) ────────────
let indexStatsCache: {
  value: Awaited<ReturnType<typeof computeIndexStats>>;
  timestamp: number;
} | null = null;
const INDEX_STATS_CACHE_TTL = 120_000; // 2 min — slower to compute (thumbnail dir scan)

async function computeIndexStats() {
  const db = getDatabase();

  const thumb = await getThumbnailDiskUsage();
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
}

// Index info for the settings page: thumbnail cache location/size,
// database file location, and counts of valid vs invalid photo records.
// "Invalid" matches cleanupOrphanPhotos: photos whose folderId is NULL or
// points at a folder that no longer exists.
export const getIndexStats = os.input(z.object({}).optional()).handler(async () => {
  if (
    indexStatsCache &&
    Date.now() - indexStatsCache.timestamp < INDEX_STATS_CACHE_TTL
  ) {
    return indexStatsCache.value;
  }
  const result = await computeIndexStats();
  indexStatsCache = { value: result, timestamp: Date.now() };
  return result;
});

/** Invalidate index stats cache (call after import / bulk delete). */
export function invalidateIndexStatsCache(): void {
  indexStatsCache = null;
}

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
      sql`UPDATE photos SET dominant_colors = NULL, color_bucket = NULL WHERE deleted_at IS NULL`
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
        // Compute hue bucket from the primary color for pre-filter optimization
        let bucketSql = sql`NULL`;
        try {
          const palette = JSON.parse(colors) as Array<{ hue?: number; weight: number }>;
          if (palette.length > 0 && palette[0].hue != null) {
            const bucket = Math.floor(palette[0].hue / 10) % 36;
            bucketSql = sql`${bucket}`;
          }
        } catch { /* keep NULL */ }
        db.run(
          sql`UPDATE photos SET dominant_colors = ${colors}, color_bucket = ${bucketSql} WHERE id = ${photo.id}`
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
