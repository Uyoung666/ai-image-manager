import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { os } from "@orpc/server";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { getDatabase, getDbPath } from "@/db";
import {
  advancedExifData,
  detectionRuns,
  duplicateCleanupPlans,
  duplicateDetectionRuns,
  duplicatePairs,
  duplicatePhotoFingerprints,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateRunGroups,
  duplicateRunMembers,
  duplicateRunPairs,
  exifData,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";
import { getActiveEmbeddingAdapterFingerprint } from "@/services/ai/model-config";
import { getThresholdProfileIdentity } from "@/services/ai/threshold-profile";
import { getDuplicateVectorRevision } from "@/services/ai/vector-db";
import { getPhotoVectors } from "@/services/ai-embedder";
import { BKTree } from "@/services/bk-tree";
import {
  aggregateFromStoredColors,
  computeColorDistribution,
  extractDominantColors,
  invalidateColorCache,
  type PaletteColor,
} from "@/services/color-extractor";
import {
  createExactDuplicatePairs,
  type DuplicateGroupPhotosResult,
  type DuplicateGroupSummary,
  type DuplicatePairRecord,
  type DuplicateSequenceSummary,
  groupDuplicatePairs,
} from "@/services/duplicate-groups";
import {
  type DuplicateReviewTransaction,
  syncDuplicateReviewStates,
} from "@/services/duplicate-review";
import {
  cancelDuplicateScan,
  type DuplicateScanContext,
  getDuplicateScanProgress,
  markDuplicateScanActive,
  markDuplicateScanFinished,
  runDuplicateScan,
} from "@/services/duplicate-scan-runtime";
import { getDuplicateSensitivityConfig } from "@/services/duplicate-sensitivity";
import {
  computeFullFileHash,
  computeSampleFileHash,
  FULL_FILE_HASH_VERSION,
  filesHaveSameBytes,
} from "@/services/file-hash";
import {
  cleanupDeletedPhotoSequenceMembers,
  getPhotoSequenceRevision,
  notifySequencesChanged,
} from "@/services/photo-sequences";
import { getSetting, setSetting } from "@/services/settings-manager";
import { getThumbnailDiskUsage } from "@/services/thumbnailer";

type AdvancedCategoryColumn =
  | typeof advancedExifData.vendor
  | typeof advancedExifData.captureMode
  | typeof advancedExifData.exposureProgram
  | typeof advancedExifData.meteringMode
  | typeof advancedExifData.whiteBalance
  | typeof advancedExifData.focusMode
  | typeof advancedExifData.subjectTarget
  | typeof advancedExifData.driveMode
  | typeof advancedExifData.stabilizationMode
  | typeof advancedExifData.computationalMode
  | typeof advancedExifData.inCameraLook
  | typeof advancedExifData.provenanceStatus;

// Module-level cache for getStats (invalidate on photo/EXIF changes)
interface StatsCacheEntry {
  data: unknown;
  includesColors: boolean;
  includesGeo: boolean;
  key?: string;
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
    creators: string[];
    lensModels: (string | null)[];
    focalLengths: string[];
    apertures: number[];
    isos: (number | null)[];
    formats: string[];
    advancedCategories: Record<string, string[]>;
  };
  timestamp: number;
}
let exifCandidatesCache: ExifCandidatesCacheEntry | null = null;
const EXIF_CANDIDATES_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

const DUPLICATE_SCANNED_SEQUENCE_REVISION_KEY =
  "duplicates.scannedSequenceRevision";
const DUPLICATE_SCANNED_SIGNATURE_KEY = "duplicates.scannedSignature";
const DUPLICATE_DETECTION_ALGORITHM_VERSION =
  "duplicate-v3-reframed-candidates";
const DUPLICATE_PHASH_VERSION = "phash-v1";
const DUPLICATE_PREVIEW_LIMIT = 24;
const DUPLICATE_DETAIL_LIMIT = 48;

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

  const basicCreators = db
    .selectDistinct({ val: exifData.artist })
    .from(exifData)
    .where(sql`${exifData.artist} IS NOT NULL AND ${exifData.artist} != ''`)
    .orderBy(exifData.artist)
    .all()
    .map((row) => row.val)
    .filter((value): value is string => Boolean(value));

  const advancedCreator = sql<
    string | null
  >`json_extract(${advancedExifData.normalizedJson}, '$.workflow.artist')`;
  const advancedCreators = db
    .selectDistinct({ val: advancedCreator })
    .from(advancedExifData)
    .where(sql`${advancedCreator} IS NOT NULL AND ${advancedCreator} != ''`)
    .orderBy(advancedCreator)
    .all()
    .map((row) => row.val)
    .filter((value): value is string => Boolean(value));
  const creators = [...new Set([...basicCreators, ...advancedCreators])].sort(
    (left, right) => left.localeCompare(right)
  );

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

  const advancedCandidates = (field: AdvancedCategoryColumn) =>
    db
      .selectDistinct({ val: field })
      .from(advancedExifData)
      .where(isNotNull(field))
      .orderBy(field)
      .all()
      .map((row) => row.val)
      .filter((value): value is string => Boolean(value));

  const advancedCategories = {
    vendor: advancedCandidates(advancedExifData.vendor),
    captureMode: advancedCandidates(advancedExifData.captureMode),
    exposureProgram: advancedCandidates(advancedExifData.exposureProgram),
    meteringMode: advancedCandidates(advancedExifData.meteringMode),
    whiteBalance: advancedCandidates(advancedExifData.whiteBalance),
    focusMode: advancedCandidates(advancedExifData.focusMode),
    subjectTarget: advancedCandidates(advancedExifData.subjectTarget),
    driveMode: advancedCandidates(advancedExifData.driveMode),
    stabilizationMode: advancedCandidates(advancedExifData.stabilizationMode),
    computationalMode: advancedCandidates(advancedExifData.computationalMode),
    inCameraLook: advancedCandidates(advancedExifData.inCameraLook),
    provenanceStatus: advancedCandidates(advancedExifData.provenanceStatus),
  };

  const result = {
    cameraModels,
    creators,
    lensModels,
    focalLengths,
    apertures,
    isos,
    formats,
    advancedCategories,
  };
  exifCandidatesCache = { data: result, timestamp: Date.now() };
  return result;
});

// Shared color-distribution helper — reused by getColorDistribution and getStats
interface DashboardRangeInput {
  from?: number;
  toExclusive?: number;
}

const dashboardRangeSchema = z.object({
  from: z.number().finite().optional(),
  toExclusive: z.number().finite().optional(),
});

function dashboardPhotoWhere(range: DashboardRangeInput) {
  return and(
    isNull(photos.deletedAt),
    range.from === undefined ? undefined : gte(exifData.dateTaken, range.from),
    range.toExclusive === undefined
      ? undefined
      : lt(exifData.dateTaken, range.toExclusive)
  );
}

function computeDashboardColors(range: DashboardRangeInput = {}) {
  const db = getDatabase();

  const isRanged = range.from !== undefined || range.toExclusive !== undefined;
  const totalPhotos = isRanged
    ? (db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .innerJoin(exifData, eq(exifData.photoId, photos.id))
        .where(dashboardPhotoWhere(range))
        .get()?.count ?? 0)
    : (db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(isNull(photos.deletedAt))
        .get()?.count ?? 0);

  // Primary path: aggregate from pre-extracted dominant_colors
  const rows = isRanged
    ? db
        .select({ dominantColors: photos.dominantColors })
        .from(photos)
        .innerJoin(exifData, eq(exifData.photoId, photos.id))
        .where(
          and(dashboardPhotoWhere(range), isNotNull(photos.dominantColors))
        )
        .all()
    : db
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

  const samplePhotos = isRanged
    ? db
        .select({ path: photos.path, thumbnailPath: photos.thumbnailPath })
        .from(photos)
        .innerJoin(exifData, eq(exifData.photoId, photos.id))
        .where(and(dashboardPhotoWhere(range), isNotNull(photos.thumbnailPath)))
        .orderBy(sql`random()`)
        .limit(200)
        .all()
    : db
        .select({ path: photos.path, thumbnailPath: photos.thumbnailPath })
        .from(photos)
        .where(and(isNull(photos.deletedAt), isNotNull(photos.thumbnailPath)))
        .orderBy(sql`random()`)
        .limit(200)
        .all();

  return computeColorDistribution(samplePhotos, totalPhotos);
}

// Color distribution (standalone — also available merged into getStats)
export const getColorDistribution = os
  .input(dashboardRangeSchema.optional().default({}))
  .handler(({ input }) => computeDashboardColors(input));

function getDashboardGeoLocations(range: DashboardRangeInput = {}) {
  const db = getDatabase();
  const total =
    db
      .select({ count: sql<number>`count(*)` })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(
        and(
          dashboardPhotoWhere(range),
          isNotNull(exifData.gpsLatitude),
          isNotNull(exifData.gpsLongitude)
        )
      )
      .get()?.count ?? 0;
  const allLocations = db
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
        dashboardPhotoWhere(range),
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
  return {
    locations: allLocations.slice(0, 2000),
    total,
    truncated: total > 2000,
  };
}

export const getGeoLocations = os
  .input(dashboardRangeSchema.optional().default({}))
  .handler(({ input }) => getDashboardGeoLocations(input));

// Statistics for dashboard (optionally includes color distribution)
export const getStats = os
  .input(
    z.object({
      includeColors: z.boolean().optional().default(false),
      includeGeo: z.boolean().optional().default(true),
      from: z.number().finite().optional(),
      toExclusive: z.number().finite().optional(),
    })
  )
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Dashboard stats combines the existing cached aggregate queries.
  .handler(({ input }) => {
    const cacheKey = JSON.stringify({
      from: input.from,
      includeColors: input.includeColors,
      includeGeo: input.includeGeo,
      toExclusive: input.toExclusive,
    });
    // Return cached stats if fresh (and colors already included if requested)
    if (
      statsCache &&
      Date.now() - statsCache.timestamp < STATS_CACHE_TTL &&
      statsCache.key === cacheKey &&
      (!input.includeColors || statsCache.includesColors) &&
      (!input.includeGeo || statsCache.includesGeo)
    ) {
      return statsCache.data;
    }

    const db = getDatabase();

    // Single query for total + AI-processed counts
    const hasRange =
      input.from !== undefined || input.toExclusive !== undefined;
    const countSelection = {
      total: sql<number>`count(*)`,
      aiProcessed: sql<number>`sum(case when ${photos.isAiProcessed} = 1 then 1 else 0 end)`,
    };
    const photoCounts = hasRange
      ? db
          .select(countSelection)
          .from(photos)
          .innerJoin(exifData, eq(exifData.photoId, photos.id))
          .where(dashboardPhotoWhere(input))
          .get()
      : db
          .select(countSelection)
          .from(photos)
          .where(isNull(photos.deletedAt))
          .get();
    const totalPhotos = photoCounts?.total ?? 0;
    const aiProcessed = photoCounts?.aiProcessed ?? 0;
    const libraryTotal =
      db
        .select({ count: sql<number>`count(*)` })
        .from(photos)
        .where(isNull(photos.deletedAt))
        .get()?.count ?? 0;
    const libraryDated =
      db
        .select({ count: sql<number>`count(*)` })
        .from(exifData)
        .innerJoin(photos, eq(exifData.photoId, photos.id))
        .where(and(isNull(photos.deletedAt), isNotNull(exifData.dateTaken)))
        .get()?.count ?? 0;

    // EXIF completeness: single conditional-aggregation query so every
    // chart can show how many photos are missing each field. This prevents
    // the "silent data loss" where chart totals don't add up to totalPhotos.
    const completeness = db
      .select({
        exifRows: sql<number>`count(*)`,
        withExif: sql<number>`SUM(CASE WHEN
          (${exifData.cameraModel} IS NOT NULL AND TRIM(${exifData.cameraModel}) != '') OR
          (${exifData.lensModel} IS NOT NULL AND TRIM(${exifData.lensModel}) != '') OR
          ${exifData.focalLength} IS NOT NULL OR
          ${exifData.aperture} IS NOT NULL OR
          ${exifData.iso} IS NOT NULL OR
          ${exifData.shutterSpeedNum} IS NOT NULL OR
          ${exifData.dateTaken} IS NOT NULL OR
          ${exifData.gpsLatitude} IS NOT NULL OR
          ${exifData.gpsLongitude} IS NOT NULL
          THEN 1 ELSE 0 END)`,
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
      .where(dashboardPhotoWhere(input))
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
          dashboardPhotoWhere(input),
          sql`${exifData.cameraModel} IS NOT NULL AND ${exifData.cameraModel} != ''`
        )
      )
      .groupBy(exifData.cameraModel)
      .orderBy(desc(sql`count(*)`))
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
        and(dashboardPhotoWhere(input), isNotNull(exifData.focalLengthNum))
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
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.aperture)))
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
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.iso)))
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
          dashboardPhotoWhere(input),
          sql`${exifData.lensModel} IS NOT NULL AND ${exifData.lensModel} != ''`
        )
      )
      .groupBy(exifData.lensModel)
      .orderBy(desc(sql`count(*)`))
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
        and(dashboardPhotoWhere(input), isNotNull(exifData.shutterSpeedNum))
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
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.dateTaken)))
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
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.dateTaken)))
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
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.dateTaken)))
      .groupBy(
        sql`strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`
      )
      .all();
    const monthlyStats = monthlyRows
      .map((r) => ({ month: r.month, count: r.count }))
      .sort((a, b) => a.month.localeCompare(b.month));

    // Daily stats — local dates power the calendar heatmap in the dashboard.
    const dailyRows = db
      .select({
        date: sql<string>`strftime('%Y-%m-%d', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`,
        count: sql<number>`COUNT(*)`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.dateTaken)))
      .groupBy(
        sql`strftime('%Y-%m-%d', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`
      )
      .all();
    const dailyStats = dailyRows
      .map((row) => ({ date: row.date, count: row.count }))
      .sort((a, b) => a.date.localeCompare(b.date));

    // Date range in SQL
    const rangeRow = db
      .select({
        earliest: sql<number>`MIN(${exifData.dateTaken})`,
        latest: sql<number>`MAX(${exifData.dateTaken})`,
      })
      .from(exifData)
      .innerJoin(photos, eq(exifData.photoId, photos.id))
      .where(and(dashboardPhotoWhere(input), isNotNull(exifData.dateTaken)))
      .get();

    const dateRange =
      rangeRow?.earliest == null
        ? null
        : { earliest: rangeRow.earliest, latest: rangeRow.latest };

    const avgIso =
      db
        .select({ avgIso: sql<number>`avg(${exifData.iso})` })
        .from(exifData)
        .innerJoin(photos, eq(exifData.photoId, photos.id))
        .where(and(dashboardPhotoWhere(input), isNotNull(exifData.iso)))
        .get()?.avgIso || 0;

    const advancedDistribution = (field: AdvancedCategoryColumn) =>
      db
        .select({ name: field, count: sql<number>`count(*)` })
        .from(advancedExifData)
        .innerJoin(photos, eq(advancedExifData.photoId, photos.id))
        .innerJoin(exifData, eq(exifData.photoId, photos.id))
        .where(and(dashboardPhotoWhere(input), isNotNull(field)))
        .groupBy(field)
        .orderBy(desc(sql`count(*)`))
        .all()
        .filter((row): row is { name: string; count: number } =>
          Boolean(row.name)
        );

    const advancedStats = {
      vendor: advancedDistribution(advancedExifData.vendor),
      captureMode: advancedDistribution(advancedExifData.captureMode),
      exposureProgram: advancedDistribution(advancedExifData.exposureProgram),
      meteringMode: advancedDistribution(advancedExifData.meteringMode),
      whiteBalance: advancedDistribution(advancedExifData.whiteBalance),
      focusMode: advancedDistribution(advancedExifData.focusMode),
      subjectTarget: advancedDistribution(advancedExifData.subjectTarget),
      driveMode: advancedDistribution(advancedExifData.driveMode),
      stabilizationMode: advancedDistribution(
        advancedExifData.stabilizationMode
      ),
      computationalMode: advancedDistribution(
        advancedExifData.computationalMode
      ),
      inCameraLook: advancedDistribution(advancedExifData.inCameraLook),
      provenanceStatus: advancedDistribution(advancedExifData.provenanceStatus),
    };
    const advancedExifCoverage =
      db
        .select({ count: sql<number>`count(*)` })
        .from(advancedExifData)
        .innerJoin(photos, eq(advancedExifData.photoId, photos.id))
        .innerJoin(exifData, eq(exifData.photoId, photos.id))
        .where(
          and(
            dashboardPhotoWhere(input),
            inArray(advancedExifData.status, ["complete", "partial"])
          )
        )
        .get()?.count ?? 0;
    const advancedMeta = (rows: { count: number; name: string }[]) => {
      const valid = rows.reduce((sum, row) => sum + row.count, 0);
      return {
        valid,
        missing: Math.max(0, totalPhotos - valid),
        totalCategories: rows.length,
        truncated: false,
      };
    };

    const colorCoverage = hasRange
      ? (db
          .select({ count: sql<number>`count(*)` })
          .from(photos)
          .innerJoin(exifData, eq(exifData.photoId, photos.id))
          .where(
            and(dashboardPhotoWhere(input), isNotNull(photos.dominantColors))
          )
          .get()?.count ?? 0)
      : (db
          .select({ count: sql<number>`count(*)` })
          .from(photos)
          .where(
            and(isNull(photos.deletedAt), isNotNull(photos.dominantColors))
          )
          .get()?.count ?? 0);
    const geoLocations = input.includeGeo
      ? getDashboardGeoLocations(input)
      : { locations: [], total: 0, truncated: false };
    const withoutExif = Math.max(
      0,
      totalPhotos - (completeness?.withExif ?? 0)
    );
    const withoutExifRow = Math.max(
      0,
      totalPhotos - (completeness?.exifRows ?? 0)
    );
    const missingWithNoExif = (missing: number | null | undefined) =>
      (missing ?? 0) + withoutExifRow;

    const result = {
      totalPhotos,
      aiProcessed,
      scope: {
        from: input.from ?? null,
        toExclusive: input.toExclusive ?? null,
        libraryTotal,
        scopedPhotos: totalPhotos,
        datedPhotos: hasRange ? totalPhotos : libraryDated,
        excludedUndated: libraryTotal - libraryDated,
      },
      coverage: {
        ai: aiProcessed,
        color: colorCoverage,
        date: hasRange ? totalPhotos : libraryDated,
        exif: completeness?.withExif ?? 0,
        advancedExif: advancedExifCoverage,
        gps: Math.max(
          0,
          totalPhotos - missingWithNoExif(completeness?.missingGps)
        ),
      },
      exifCompleteness: completeness
        ? {
            withExif: completeness.withExif,
            missingCamera: missingWithNoExif(completeness.missingCamera),
            missingLens: missingWithNoExif(completeness.missingLens),
            missingFocal: missingWithNoExif(completeness.missingFocal),
            missingAperture: missingWithNoExif(completeness.missingAperture),
            missingIso: missingWithNoExif(completeness.missingIso),
            missingShutter: missingWithNoExif(completeness.missingShutter),
            missingDate: missingWithNoExif(completeness.missingDate),
            missingGps: missingWithNoExif(completeness.missingGps),
            // Photos without any meaningful photographic EXIF field.
            withoutExif,
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
      dailyStats,
      dateRange,
      avgIso,
      advancedStats,
      geoLocations,
      distributionMetadata: {
        advancedVendor: advancedMeta(advancedStats.vendor),
        captureMode: advancedMeta(advancedStats.captureMode),
        exposureProgram: advancedMeta(advancedStats.exposureProgram),
        meteringMode: advancedMeta(advancedStats.meteringMode),
        whiteBalance: advancedMeta(advancedStats.whiteBalance),
        focusMode: advancedMeta(advancedStats.focusMode),
        subjectTarget: advancedMeta(advancedStats.subjectTarget),
        driveMode: advancedMeta(advancedStats.driveMode),
        stabilizationMode: advancedMeta(advancedStats.stabilizationMode),
        computationalMode: advancedMeta(advancedStats.computationalMode),
        inCameraLook: advancedMeta(advancedStats.inCameraLook),
        provenanceStatus: advancedMeta(advancedStats.provenanceStatus),
        camera: {
          valid: Math.max(
            0,
            totalPhotos - missingWithNoExif(completeness?.missingCamera)
          ),
          missing: missingWithNoExif(completeness?.missingCamera),
          totalCategories: cameraStats.length,
          truncated: false,
        },
        lens: {
          valid: Math.max(
            0,
            totalPhotos - missingWithNoExif(completeness?.missingLens)
          ),
          missing: missingWithNoExif(completeness?.missingLens),
          totalCategories: lensStats.length,
          truncated: false,
        },
        focal: {
          valid: Math.max(
            0,
            totalPhotos - missingWithNoExif(completeness?.missingFocal)
          ),
          missing: missingWithNoExif(completeness?.missingFocal),
          totalCategories: focalStats.length,
          truncated: focalStats.length >= 50,
        },
        aperture: {
          valid: Math.max(
            0,
            totalPhotos - missingWithNoExif(completeness?.missingAperture)
          ),
          missing: missingWithNoExif(completeness?.missingAperture),
          totalCategories: apertureStats.length,
          truncated: apertureStats.length >= 50,
        },
        iso: {
          valid: isoResult.reduce((sum, item) => sum + item.count, 0),
          missing: missingWithNoExif(completeness?.missingIso),
          totalCategories: isoResult.length,
          truncated: false,
        },
        shutter: {
          valid: shutterResult.reduce((sum, item) => sum + item.count, 0),
          missing: missingWithNoExif(completeness?.missingShutter),
          totalCategories: shutterResult.length,
          truncated: false,
        },
      },
    };

    // Optionally include color distribution in the same IPC call
    if (input.includeColors) {
      try {
        Object.assign(result, {
          colorDistribution: computeDashboardColors(input),
        });
      } catch (err) {
        console.error("[getStats] colorDistribution failed:", err);
        Object.assign(result, { colorDistribution: null });
      }
    }

    statsCache = {
      data: result,
      includesColors: input.includeColors,
      includesGeo: input.includeGeo,
      key: cacheKey,
      timestamp: Date.now(),
    };
    return result;
  });

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

function getPhotoSequenceIds(
  db: ReturnType<typeof getDatabase>
): Map<number, number> {
  return new Map(
    db
      .select({
        photoId: photoSequenceMembers.photoId,
        sequenceId: photoSequenceMembers.sequenceId,
      })
      .from(photoSequenceMembers)
      .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
      .where(isNull(photos.deletedAt))
      .all()
      .map(({ photoId, sequenceId }) => [photoId, sequenceId])
  );
}

function getScannedSequenceRevision(): number | null {
  const value = getSetting(DUPLICATE_SCANNED_SEQUENCE_REVISION_KEY);
  if (value === null) {
    return null;
  }
  const revision = Number.parseInt(value, 10);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function setScannedSequenceRevision(revision: number): void {
  setSetting(DUPLICATE_SCANNED_SEQUENCE_REVISION_KEY, String(revision));
}

function getScannedDuplicateSignature(): string | null {
  return getSetting(DUPLICATE_SCANNED_SIGNATURE_KEY);
}

function setScannedDuplicateSignature(signature: string): void {
  setSetting(DUPLICATE_SCANNED_SIGNATURE_KEY, signature);
}

function createDuplicateScanSignature(
  phashThreshold: number,
  embeddingThreshold: number,
  photoRevision: string,
  sequenceRevision: number,
  vectorRevision: string,
  settingsRevision: string,
  embeddingModelVersion: string
): string {
  return JSON.stringify({
    algorithmVersion: DUPLICATE_DETECTION_ALGORITHM_VERSION,
    embeddingThreshold,
    embeddingModelVersion,
    hashVersion: FULL_FILE_HASH_VERSION,
    phashThreshold,
    phashVersion: DUPLICATE_PHASH_VERSION,
    photoRevision,
    sequenceRevision,
    settingsRevision,
    thresholdProfile: getThresholdProfileIdentity(),
    vectorRevision,
  });
}

function createDuplicatePhotoRevision(
  rows: ReadonlyArray<{
    id: number;
    path: string;
    fileSize: number | null;
    phash?: string | null;
    vectorId?: string | null;
  }>
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        rows
          .map((row) => {
            let metadata = "missing";
            try {
              metadata = fingerprintMetadata(row.path, fs.statSync(row.path));
            } catch {
              /* missing input invalidates the run */
            }
            return [row.id, metadata, row.phash, row.vectorId];
          })
          .sort((a, b) => Number(a[0]) - Number(b[0]))
      )
    )
    .digest("hex");
}

function currentPhotoRevision(db: ReturnType<typeof getDatabase>): string {
  const sequenceIds = getPhotoSequenceIds(db);
  return createDuplicatePhotoRevision(
    db
      .select()
      .from(photos)
      .where(isNull(photos.deletedAt))
      .all()
      .filter((photo) => !sequenceIds.has(photo.id))
  );
}

function beginDuplicateDetectionRun(
  db: ReturnType<typeof getDatabase>,
  input: {
    embeddingModelVersion: string;
    embeddingThreshold: number;
    phashThreshold: number;
    photoRevision: string;
    scanSignature: string;
    sequenceRevision: number;
    settingsRevision: string;
    vectorRevision: string;
  }
): string {
  const id = randomUUID();
  db.insert(duplicateDetectionRuns)
    .values({
      algorithmVersion: DUPLICATE_DETECTION_ALGORITHM_VERSION,
      configFingerprint: input.scanSignature,
      embeddingModelVersion:
        input.embeddingModelVersion === "unavailable"
          ? null
          : input.embeddingModelVersion,
      embeddingThreshold: input.embeddingThreshold,
      hashVersion: FULL_FILE_HASH_VERSION,
      id,
      phashThreshold: input.phashThreshold,
      phashVersion: DUPLICATE_PHASH_VERSION,
      photoRevision: input.photoRevision,
      sequenceRevision: input.sequenceRevision,
      settingsRevision: input.settingsRevision,
      status: "running",
      thresholdProfileVersion: getThresholdProfileIdentity(),
      vectorRevision: input.vectorRevision,
    })
    .run();
  markDuplicateScanActive(id);
  return id;
}

function completeDuplicateDetectionRun(
  db: ReturnType<typeof getDatabase>,
  runId: string
): void {
  db.update(duplicateDetectionRuns)
    .set({ completedAt: Date.now(), status: "completed" })
    .where(eq(duplicateDetectionRuns.id, runId))
    .run();
  markDuplicateScanFinished(runId);
}

function failDuplicateDetectionRun(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  error: unknown
): void {
  let status = "failed";
  if (error instanceof Error && error.message.startsWith("STALE_RUN")) {
    status = "stale";
  }
  if (error instanceof Error && error.message.startsWith("SCAN_CANCELLED")) {
    status = "cancelled";
  }
  db.update(duplicateDetectionRuns)
    .set({
      completedAt: Date.now(),
      errorMessage: error instanceof Error ? error.message : String(error),
      status,
    })
    .where(eq(duplicateDetectionRuns.id, runId))
    .run();
  markDuplicateScanFinished(runId);
}

function publishDuplicateRunSnapshot(
  db: ReturnType<typeof getDatabase>,
  runId: string,
  summaries: DuplicateGroupSummary[],
  persistedPairs: Array<{
    clipSimilarity: number | null;
    matchType: string;
    phashDistance: number | null;
    photoAId: number;
    photoBId: number;
  }>,
  transaction?: DuplicateReviewTransaction
): void {
  const contentRevisions = new Map(
    (transaction ?? db)
      .select({
        contentRevision: duplicatePhotoFingerprints.contentRevision,
        photoId: duplicatePhotoFingerprints.photoId,
      })
      .from(duplicatePhotoFingerprints)
      .all()
      .map((row) => [row.photoId, row.contentRevision])
  );
  const publish = (tx: DuplicateReviewTransaction) => {
    for (const summary of summaries) {
      const memberIds =
        summary.groupKey
          .split(":", 2)[1]
          ?.split("-")
          .map((value) => Number(value))
          .filter((value) => Number.isSafeInteger(value) && value > 0) ?? [];
      tx.insert(duplicateRunGroups)
        .values({
          groupKey: summary.groupKey,
          groupVersion: summary.groupVersion ?? "legacy",
          matchType: summary.matchType,
          memberIdsJson: JSON.stringify(memberIds),
          recommendedKeepId: summary.recommendedKeepId,
          runId,
        })
        .onConflictDoNothing()
        .run();
      for (const photoId of memberIds) {
        tx.insert(duplicateRunMembers)
          .values({
            contentRevision: contentRevisions.get(photoId) ?? 0,
            groupKey: summary.groupKey,
            photoId,
            runId,
          })
          .onConflictDoNothing()
          .run();
      }
    }
    for (const pair of persistedPairs) {
      tx.insert(duplicateRunPairs)
        .values({
          clipSimilarity: pair.clipSimilarity,
          matchType: pair.matchType,
          phashDistance: pair.phashDistance,
          photoAId: pair.photoAId,
          photoBId: pair.photoBId,
          runId,
        })
        .onConflictDoNothing()
        .run();
    }
  };
  if (transaction) {
    publish(transaction);
  } else {
    db.transaction(publish);
  }
}

function createDuplicateGroupPreview(
  group: ReturnType<typeof groupDuplicatePairs>[number]
): DuplicateGroupSummary {
  const preview = group.photos.slice(0, DUPLICATE_PREVIEW_LIMIT);
  if (
    !preview.some((photo) => photo.id === group.recommendedKeepId) &&
    group.photos.length > 0
  ) {
    const keeper = group.photos.find(
      (photo) => photo.id === group.recommendedKeepId
    );
    if (keeper && preview.length > 0) {
      preview[preview.length - 1] = keeper;
    }
  }
  return {
    estimatedReclaimBytes: group.estimatedReclaimBytes,
    fileSizeByPhotoId: Object.fromEntries(
      group.photos.map((photo) => [photo.id, photo.fileSize])
    ),
    groupKey: group.groupKey,
    matchType: group.matchType,
    pairCount: group.pairIds.length,
    photoCount: group.photos.length,
    previewPhotos: preview,
    recommendedKeepId: group.recommendedKeepId,
    sequenceSummaries: [],
    status: group.status,
  };
}

function addSequenceSummaries(
  db: ReturnType<typeof getDatabase>,
  groups: DuplicateGroupSummary[],
  fullGroups: ReturnType<typeof groupDuplicatePairs>
): void {
  const groupPhotoIds = fullGroups.flatMap((group) =>
    group.photos.map((photo) => photo.id)
  );
  const memberships =
    groupPhotoIds.length === 0
      ? []
      : db
          .select({
            photoId: photoSequenceMembers.photoId,
            sequenceId: photoSequenceMembers.sequenceId,
          })
          .from(photoSequenceMembers)
          .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
          .where(
            and(
              inArray(photoSequenceMembers.photoId, groupPhotoIds),
              isNull(photos.deletedAt)
            )
          )
          .all();
  const sequenceIds = new Set(
    memberships.map((membership) => membership.sequenceId)
  );
  if (sequenceIds.size === 0) {
    return;
  }
  const sequenceRows = db
    .select({
      frameCount: photoSequences.frameCount,
      id: photoSequences.id,
      representativePhotoId: photoSequences.representativePhotoId,
      type: photoSequences.type,
    })
    .from(photoSequences)
    .where(inArray(photoSequences.id, [...sequenceIds]))
    .all();
  const sequenceByPhoto = new Map(
    memberships.map((membership) => [membership.photoId, membership.sequenceId])
  );
  const sequenceById = new Map(sequenceRows.map((row) => [row.id, row]));
  const groupByKey = new Map(groups.map((group) => [group.groupKey, group]));
  for (const fullGroup of fullGroups) {
    const counts = new Map<number, number>();
    for (const photo of fullGroup.photos) {
      const sequenceId = sequenceByPhoto.get(photo.id);
      if (sequenceId !== undefined) {
        counts.set(sequenceId, (counts.get(sequenceId) ?? 0) + 1);
      }
    }
    const summary = groupByKey.get(fullGroup.groupKey);
    if (!summary) {
      continue;
    }
    summary.sequenceSummaries = [...counts.keys()]
      .map((sequenceId) => {
        const sequence = sequenceById.get(sequenceId);
        if (!sequence) {
          return null;
        }
        return {
          memberCount: sequence.frameCount,
          representativePhotoId: sequence.representativePhotoId,
          sequenceId,
          type: sequence.type as DuplicateSequenceSummary["type"],
        };
      })
      .filter(
        (summary): summary is DuplicateSequenceSummary => summary !== null
      )
      .sort((left, right) => left.sequenceId - right.sequenceId);
  }
}

const verifiedFingerprintCache = new Map<string, string>();
function fingerprintMetadata(path: string, stat: fs.Stats): string {
  return JSON.stringify([
    path,
    stat.size,
    stat.mtimeMs,
    stat.ctimeMs,
    stat.dev,
    stat.ino,
  ]);
}

async function prepareDuplicateGroupFingerprints(
  db: ReturnType<typeof getDatabase>,
  groups: ReturnType<typeof groupDuplicatePairs>,
  force: boolean,
  fullHashes: ReadonlyMap<number, string>,
  context: DuplicateScanContext
): Promise<(typeof duplicatePhotoFingerprints.$inferInsert)[]> {
  const uniquePhotos = new Map(
    groups.flatMap((group) => group.photos).map((photo) => [photo.id, photo])
  );
  const result: (typeof duplicatePhotoFingerprints.$inferInsert)[] = [];
  for (const photo of uniquePhotos.values()) {
    context.report("verifying", result.length, uniquePhotos.size);
    const stat = fs.statSync(photo.path);
    const metadata = fingerprintMetadata(photo.path, stat);
    const previous = db
      .select()
      .from(duplicatePhotoFingerprints)
      .where(eq(duplicatePhotoFingerprints.photoId, photo.id))
      .get();
    const fullSha256 =
      fullHashes.get(photo.id) ??
      (force ? undefined : verifiedFingerprintCache.get(metadata)) ??
      (await computeFullFileHash(photo.path));
    if (
      !fullSha256 ||
      metadata !== fingerprintMetadata(photo.path, fs.statSync(photo.path))
    ) {
      throw new Error("FILE_CHANGED: Original file changed while verifying");
    }
    // Only evidence of different content invalidates user decisions. A sample
    // digest or a metadata-only update must never erase an existing full hash.
    const changed = !previous || previous.fullSha256 !== fullSha256;
    result.push({
      photoId: photo.id,
      path: photo.path,
      fileSize: stat.size,
      modifiedAt: stat.mtimeMs,
      fullSha256,
      hashVersion: FULL_FILE_HASH_VERSION,
      sampleHash: previous?.sampleHash ?? null,
      contentRevision: (previous?.contentRevision ?? 0) + (changed ? 1 : 0),
      verifiedAt: Date.now(),
    });
    if (verifiedFingerprintCache.size > 20_000) {
      verifiedFingerprintCache.clear();
    }
    verifiedFingerprintCache.set(metadata, fullSha256);
  }
  return result;
}

function publishFingerprints(
  db: ReturnType<typeof getDatabase>,
  fingerprints: (typeof duplicatePhotoFingerprints.$inferInsert)[]
): void {
  for (const fingerprint of fingerprints) {
    db.insert(duplicatePhotoFingerprints)
      .values(fingerprint)
      .onConflictDoUpdate({
        target: duplicatePhotoFingerprints.photoId,
        set: fingerprint,
      })
      .run();
    if (fingerprint.photoId !== undefined) {
      db.update(photos)
        .set({ fileSize: fingerprint.fileSize })
        .where(eq(photos.id, fingerprint.photoId))
        .run();
    }
  }
}

function summarizeDuplicateGroups(
  db: ReturnType<typeof getDatabase>,
  groups: ReturnType<typeof groupDuplicatePairs>,
  detectionFingerprint = "legacy",
  legacyIgnoredMemberSignatures: ReadonlySet<string> = new Set(),
  transaction?: DuplicateReviewTransaction
): DuplicateGroupSummary[] {
  const summaries = groups.map(createDuplicateGroupPreview);
  const reviewStates = syncDuplicateReviewStates(
    db,
    groups,
    detectionFingerprint,
    legacyIgnoredMemberSignatures,
    transaction
  );
  for (const summary of summaries) {
    const review = reviewStates.get(summary.groupKey);
    if (!review) {
      continue;
    }
    summary.groupVersion = review.groupVersion;
    summary.ignoreState = review.ignoreState;
    if (review.ignoreState === "IGNORED") {
      summary.status = "dismissed";
    }
    summary.reviewComplete = review.complete;
    summary.reviewDecisions = Object.fromEntries(
      review.members.map((member) => [member.photoId, member.decision])
    );
    summary.reviewNeedsReview = review.needsReview;
    summary.reviewPhotoIds = review.members
      .filter((member) => member.needsReview && member.decision !== "UNDECIDED")
      .map((member) => member.photoId);
    summary.reviewRevision = review.reviewRevision;
  }
  addSequenceSummaries(db, summaries, groups);
  return summaries;
}

function loadNonSequenceDuplicatePairs(
  db: ReturnType<typeof getDatabase>
): PersistedDuplicatePair[] {
  const persisted = db.select().from(duplicatePairs).all();
  const sequenceByPhoto = getPhotoSequenceIds(db);
  const excludedPairIds = new Set(
    getSequencePhotoPairIds(persisted, sequenceByPhoto)
  );
  return persisted.filter((pair) => !excludedPairIds.has(pair.id));
}

function hydrateDuplicateGroupDetails(
  db: ReturnType<typeof getDatabase>,
  groupKey: string,
  offset: number,
  limit: number
): DuplicateGroupPhotosResult {
  const persisted = loadNonSequenceDuplicatePairs(db);
  const groups = hydrateDuplicateGroups(db, persisted);
  const group = groups.find((candidate) => candidate.groupKey === groupKey);
  if (!group) {
    throw new Error("Duplicate group is stale; rescan before loading photos");
  }
  const safeOffset = Math.max(0, offset);
  const safeLimit = Math.min(Math.max(1, limit), DUPLICATE_DETAIL_LIMIT);
  const photosPage = group.photos.slice(safeOffset, safeOffset + safeLimit);
  return {
    groupKey,
    hasMore: safeOffset + photosPage.length < group.photos.length,
    limit: safeLimit,
    offset: safeOffset,
    photos: photosPage,
    total: group.photos.length,
  };
}

export function getSequencePhotoPairIds(
  pairs: ReadonlyArray<{
    id: number;
    photoAId: number;
    photoBId: number;
  }>,
  sequenceByPhoto: ReadonlyMap<number, number>
): number[] {
  return pairs
    .filter(
      (pair) =>
        sequenceByPhoto.has(pair.photoAId) || sequenceByPhoto.has(pair.photoBId)
    )
    .map((pair) => pair.id);
}

type PersistedDuplicatePair = typeof duplicatePairs.$inferSelect;

function hydrateDuplicateGroups(
  db: ReturnType<typeof getDatabase>,
  persistedPairs: PersistedDuplicatePair[]
) {
  if (persistedPairs.length === 0) {
    return [];
  }
  const photoIds = new Set<number>();
  for (const pair of persistedPairs) {
    photoIds.add(pair.photoAId);
    photoIds.add(pair.photoBId);
  }
  const photoRows = db
    .select({
      id: photos.id,
      path: photos.path,
      filename: photos.filename,
      fileSize: photos.fileSize,
      fileDate: photos.fileDate,
      width: photos.width,
      height: photos.height,
      createdAt: photos.createdAt,
      thumbnailPath: photos.thumbnailPath,
    })
    .from(photos)
    .where(
      and(inArray(photos.id, Array.from(photoIds)), isNull(photos.deletedAt))
    )
    .all();
  const photoMap = new Map(photoRows.map((photo) => [photo.id, photo]));
  const pairs: DuplicatePairRecord[] = [];
  for (const pair of persistedPairs) {
    const photoA = photoMap.get(pair.photoAId);
    const photoB = photoMap.get(pair.photoBId);
    if (!(photoA && photoB)) {
      continue;
    }
    pairs.push({
      pairId: pair.id,
      photoA,
      photoB,
      matchType: pair.matchType as DuplicatePairRecord["matchType"],
      distance: pair.phashDistance ?? 0,
      clipSimilarity: pair.clipSimilarity,
      status: pair.status as DuplicatePairRecord["status"],
    });
  }
  return groupDuplicatePairs(pairs);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The staged detector verifies input versions before its single atomic publication.
async function scanDuplicates(
  input: { threshold?: number; forceRescan: boolean },
  context: DuplicateScanContext
) {
  const db = getDatabase();
  const sensitivity = getDuplicateSensitivityConfig(
    getSetting("duplicates.sensitivity")
  );
  const phashThreshold = input.threshold ?? sensitivity.phashThreshold;
  const embeddingThreshold = sensitivity.embeddingThreshold;
  if (cleanupDeletedPhotoSequenceMembers(db)) {
    notifySequencesChanged(undefined, "manual");
  }
  const sequenceByPhoto = getPhotoSequenceIds(db);
  const scanSequenceRevision = getPhotoSequenceRevision();
  const allPhotos = db
    .select({
      id: photos.id,
      path: photos.path,
      filename: photos.filename,
      fileSize: photos.fileSize,
      phash: photos.phash,
      vectorId: photos.vectorId,
      width: photos.width,
      height: photos.height,
      createdAt: photos.createdAt,
      thumbnailPath: photos.thumbnailPath,
    })
    .from(photos)
    .where(isNull(photos.deletedAt))
    // Burst/timelapse photos are managed by the sequence workflow, not duplicate cleanup.
    .all()
    .filter((photo) => !sequenceByPhoto.has(photo.id));
  for (const photo of allPhotos) {
    try {
      const stat = fs.statSync(photo.path);
      if (photo.fileSize !== stat.size) {
        photo.fileSize = stat.size;
        db.update(photos)
          .set({ fileSize: stat.size })
          .where(eq(photos.id, photo.id))
          .run();
      }
    } catch {
      // The staged hash step will skip an unreadable source file.
    }
  }
  const photoRevision = createDuplicatePhotoRevision(allPhotos);
  const vectorRevision = await getDuplicateVectorRevision();
  const settingsRevision = getSetting("duplicates.settingsRevision") ?? "0";
  let embeddingModelVersion = "unavailable";
  try {
    embeddingModelVersion = getActiveEmbeddingAdapterFingerprint();
  } catch {
    // A missing model must remain visible in the run fingerprint; it is not
    // safe to silently reuse a vector-confirmed cache in that case.
  }
  const scanSignature = createDuplicateScanSignature(
    phashThreshold,
    embeddingThreshold,
    photoRevision,
    scanSequenceRevision,
    vectorRevision,
    settingsRevision,
    embeddingModelVersion
  );
  const runId = beginDuplicateDetectionRun(db, {
    embeddingModelVersion,
    embeddingThreshold,
    phashThreshold,
    photoRevision,
    scanSignature,
    sequenceRevision: scanSequenceRevision,
    settingsRevision,
    vectorRevision,
  });
  const assertInputsCurrent = async () => {
    const currentVectorRevision = await getDuplicateVectorRevision();
    context.assertCurrent();
    let currentModel = "unavailable";
    try {
      currentModel = getActiveEmbeddingAdapterFingerprint();
    } catch {
      /* model unavailable */
    }
    if (
      photoRevision !== currentPhotoRevision(db) ||
      vectorRevision !== currentVectorRevision ||
      settingsRevision !== (getSetting("duplicates.settingsRevision") ?? "0") ||
      scanSequenceRevision !== getPhotoSequenceRevision() ||
      embeddingModelVersion !== currentModel ||
      JSON.parse(scanSignature).thresholdProfile !==
        getThresholdProfileIdentity()
    ) {
      throw new Error("STALE_RUN: Scan inputs changed; scan again");
    }
  };
  try {
    context.report("hashing", 0, allPhotos.length);
    // If not forcing rescan, return persisted results
    if (
      !input.forceRescan &&
      getScannedSequenceRevision() === scanSequenceRevision &&
      getScannedDuplicateSignature() === scanSignature
    ) {
      const existing = loadNonSequenceDuplicatePairs(db);
      const hydrated = hydrateDuplicateGroups(db, existing);
      const fingerprints = await prepareDuplicateGroupFingerprints(
        db,
        hydrated,
        false,
        new Map(),
        context
      );
      await assertInputsCurrent();
      const groups = db.transaction((tx) => {
        publishFingerprints(db, fingerprints);
        const summaries = summarizeDuplicateGroups(
          db,
          hydrated,
          scanSignature,
          undefined,
          tx
        );
        publishDuplicateRunSnapshot(db, runId, summaries, existing, tx);
        completeDuplicateDetectionRun(db, runId);
        return summaries;
      });
      return { fromCache: true, groups, runId };
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
    const verifiedExactHashByPhotoId = new Map<number, string>();

    // First compute a cheap sample digest for equal-size candidates. A sample
    // digest is only a filter; it is never persisted as or treated as exact.
    const sampleHashByPhotoId = new Map<number, string>();
    const candidatePhotos: (typeof allPhotos)[0][] = [];
    for (const group of sizeGroups.values()) {
      if (group.length < 2) {
        continue;
      }
      for (const p of group) {
        context.report("hashing", sampleHashByPhotoId.size, allPhotos.length);
        const sampleHash = await computeSampleFileHash(p.path);
        if (sampleHash) {
          sampleHashByPhotoId.set(p.id, sampleHash);
          candidatePhotos.push(p);
        }
      }
    }

    const sampleGroups = new Map<string, (typeof allPhotos)[0][]>();
    for (const photo of candidatePhotos) {
      const sampleHash = sampleHashByPhotoId.get(photo.id);
      if (!sampleHash) {
        continue;
      }
      const group = sampleGroups.get(sampleHash);
      if (group) {
        group.push(photo);
      } else {
        sampleGroups.set(sampleHash, [photo]);
      }
    }

    const fullHashByPhotoId = new Map<number, string>();
    for (const sampleGroup of sampleGroups.values()) {
      if (sampleGroup.length < 2) {
        continue;
      }
      for (const photo of sampleGroup) {
        context.report(
          "hashing",
          fullHashByPhotoId.size,
          candidatePhotos.length
        );
        const fullHash = await computeFullFileHash(photo.path);
        if (fullHash) {
          fullHashByPhotoId.set(photo.id, fullHash);
        }
      }
    }

    for (const group of sizeGroups.values()) {
      if (group.length < 2) {
        continue;
      }

      // Group by content hash
      const hashGroups = new Map<string, typeof group>();
      for (const p of group) {
        const fullHash = fullHashByPhotoId.get(p.id);
        if (!fullHash) {
          continue;
        }
        const hg = hashGroups.get(fullHash);
        if (hg) {
          hg.push(p);
        } else {
          hashGroups.set(fullHash, [p]);
        }
      }

      for (const hGroup of hashGroups.values()) {
        if (hGroup.length < 2) {
          continue;
        }
        const contentHash = hGroup[0]
          ? fullHashByPhotoId.get(hGroup[0].id)
          : undefined;
        if (!contentHash) {
          continue;
        }
        let fullyVerified = true;
        for (const {
          photoAId: aId,
          photoBId: bId,
        } of createExactDuplicatePairs(hGroup.map((photo) => photo.id))) {
          context.assertCurrent();
          const photoA = hGroup.find((photo) => photo.id === aId);
          const photoB = hGroup.find((photo) => photo.id === bId);
          if (
            !(
              photoA &&
              photoB &&
              (await filesHaveSameBytes(
                photoA.path,
                photoB.path,
                context.assertCurrent
              ))
            )
          ) {
            fullyVerified = false;
            continue;
          }
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
        if (fullyVerified) {
          for (const photo of hGroup) {
            verifiedExactHashByPhotoId.set(photo.id, contentHash);
          }
        }
      }
    }

    // --- Phase 1: BK-Tree pHash near-neighbor search ---
    const photosWithHash = allPhotos.filter(
      (p): p is (typeof allPhotos)[number] & { phash: string } =>
        p.phash != null
    );
    const bkTree = new BKTree();
    for (const p of photosWithHash) {
      bkTree.insert(p.id, p.phash);
    }

    let phashProcessed = 0;
    for (const p of photosWithHash) {
      context.report("matching", phashProcessed++, photosWithHash.length);
      // Reframing can shift pHash substantially. Wider candidates still need
      // AI confirmation; the no-vector fallback retains the narrower cutoff.
      const neighbors = bkTree.query(p.phash, Math.max(phashThreshold, 16));
      for (const n of neighbors) {
        if (n.photoId === p.id) {
          continue;
        }
        const aId = Math.min(p.id, n.photoId);
        const bId = Math.max(p.id, n.photoId);
        const hashA = verifiedExactHashByPhotoId.get(aId);
        if (hashA && hashA === verifiedExactHashByPhotoId.get(bId)) {
          continue;
        }
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

    // --- Phase 2: SigLIP vector verification ---
    // Sort by distance (lower = more likely duplicate)
    candidates.sort((a, b) => a.phashDistance - b.phashDistance);

    const uniqueIds = new Set<number>();
    for (const c of candidates) {
      uniqueIds.add(c.photoAId);
      uniqueIds.add(c.photoBId);
    }

    let vectors: Map<number, number[]> = new Map();
    try {
      vectors = await getPhotoVectors(Array.from(uniqueIds), true);
    } catch {
      throw new Error(
        "VECTOR_UNAVAILABLE: Could not verify duplicate candidates"
      );
    }

    const confirmedPairs: CandidatePair[] = [];
    const duplicateConfirmationSimilarity = embeddingThreshold;

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
        if (sim >= duplicateConfirmationSimilarity) {
          c.clipSimilarity = Math.round(sim * 10_000) / 10_000;
          c.matchType = "clip_confirmed";
          confirmedPairs.push(c);
        }
      } else if (c.phashDistance <= 3) {
        // No vectors: use distance-based confidence
        // High confidence without CLIP
        confirmedPairs.push(c);
      } else if (c.phashDistance <= phashThreshold) {
        // distance 4-8 without vectors: keep as pending for manual review
        c.matchType = "phash";
        confirmedPairs.push(c);
      }
    }

    const stagedPairs = confirmedPairs.map((pair, index) => ({
      ...pair,
      id: index + 1,
      resolvedAt: null,
      createdAt: Date.now(),
      status: pair.matchType === "phash" ? "pending" : "confirmed",
    }));
    const hydrated = hydrateDuplicateGroups(db, stagedPairs);
    const fingerprints = await prepareDuplicateGroupFingerprints(
      db,
      hydrated,
      input.forceRescan,
      fullHashByPhotoId,
      context
    );
    await assertInputsCurrent();
    context.report("publishing", allPhotos.length, allPhotos.length);
    const groups = db.transaction((tx) => {
      const legacyIgnoredMemberSignatures = new Set(
        hydrateDuplicateGroups(db, loadNonSequenceDuplicatePairs(db))
          .filter((group) => group.status === "dismissed")
          .map((group) =>
            JSON.stringify(
              group.photos.map((photo) => photo.id).sort((a, b) => a - b)
            )
          )
      );
      publishFingerprints(db, fingerprints);
      db.update(duplicateCleanupPlans)
        .set({ status: "STALE", updatedAt: Date.now() })
        .where(eq(duplicateCleanupPlans.status, "READY"))
        .run();
      db.delete(duplicatePairs).run();
      for (const pair of stagedPairs) {
        const { id: _id, ...values } = pair;
        db.insert(duplicatePairs).values(values).onConflictDoNothing().run();
      }
      const persisted = db.select().from(duplicatePairs).all();
      const summaries = summarizeDuplicateGroups(
        db,
        hydrateDuplicateGroups(db, persisted),
        scanSignature,
        legacyIgnoredMemberSignatures,
        tx
      );
      db.insert(detectionRuns)
        .values({
          lastPhotoId: allPhotos.reduce((max, p) => Math.max(max, p.id), 0),
          photosProcessed: allPhotos.length,
          pairsFound: persisted.length,
        })
        .run();
      setScannedSequenceRevision(scanSequenceRevision);
      setScannedDuplicateSignature(scanSignature);
      publishDuplicateRunSnapshot(db, runId, summaries, persisted, tx);
      completeDuplicateDetectionRun(db, runId);
      return summaries;
    });
    return { groups, fromCache: false, runId };
  } catch (error) {
    failDuplicateDetectionRun(db, runId, error);
    throw error;
  }
}

export const findDuplicates = os
  .input(
    z.object({
      threshold: z.number().int().min(0).max(64).optional(),
      forceRescan: z.boolean().optional().default(false),
    })
  )
  .handler(({ input }) =>
    runDuplicateScan(
      JSON.stringify([
        input,
        getSetting("duplicates.settingsRevision"),
        getPhotoSequenceRevision(),
      ]),
      (context) => scanDuplicates(input, context)
    )
  );

export const getDuplicateScanProgressHandler = os.handler(() =>
  getDuplicateScanProgress()
);
export const cancelDuplicateScanHandler = os.handler(() => {
  cancelDuplicateScan();
  return { cancelled: true };
});

export const getDuplicateScan = os
  .input(z.object({ runId: z.string().uuid() }))
  .handler(({ input }) => {
    const run = getDatabase()
      .select()
      .from(duplicateDetectionRuns)
      .where(eq(duplicateDetectionRuns.id, input.runId))
      .get();
    if (!run) {
      throw new Error("Duplicate detection run was not found");
    }
    return run;
  });

export const getDuplicateGroupPhotos = os
  .input(
    z.object({
      groupKey: z.string().min(1),
      limit: z
        .number()
        .int()
        .positive()
        .max(DUPLICATE_DETAIL_LIMIT)
        .default(24),
      offset: z.number().int().nonnegative().default(0),
    })
  )
  .handler(({ input }) => {
    return hydrateDuplicateGroupDetails(
      getDatabase(),
      input.groupKey,
      input.offset,
      input.limit
    );
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

export const dismissDuplicates = os
  .input(
    z.object({
      groupKey: z.string().min(1),
      dismissed: z.boolean().default(true),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const group = hydrateDuplicateGroups(
      db,
      loadNonSequenceDuplicatePairs(db)
    ).find((candidate) => candidate.groupKey === input.groupKey);
    if (!group) {
      throw new Error("Duplicate group is stale; rescan before ignoring");
    }
    return db.transaction((tx) => {
      const result = tx
        .update(duplicatePairs)
        .set({
          status: input.dismissed ? "dismissed" : "pending",
          resolvedAt: input.dismissed ? Date.now() : null,
        })
        .where(inArray(duplicatePairs.id, group.pairIds))
        .run();
      const review = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, input.groupKey))
        .get();
      if (review) {
        const nextRevision = review.reviewRevision + 1;
        tx.update(duplicateReviewGroups)
          .set({
            complete: false,
            ignoreState: input.dismissed ? "IGNORED" : "ACTIVE",
            needsReview: !input.dismissed,
            reviewRevision: nextRevision,
            updatedAt: Date.now(),
          })
          .where(eq(duplicateReviewGroups.groupKey, input.groupKey))
          .run();
        tx.insert(duplicateReviewEvents)
          .values({
            detailsJson: JSON.stringify({
              memberIds: group.photos.map((photo) => photo.id),
            }),
            eventType: input.dismissed ? "USER_IGNORE" : "USER_UNIGNORE",
            groupKey: input.groupKey,
            groupVersion: review.groupVersion,
            reviewRevision: nextRevision,
          })
          .run();
      }
      return { dismissed: result.changes };
    });
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
export const getIndexStats = os
  .input(z.object({}).optional())
  .handler(async () => {
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
      if (!photo.thumbnailPath) {
        continue;
      }
      const colors = await extractDominantColors(photo.thumbnailPath);
      if (colors) {
        // Compute hue bucket from the primary color for pre-filter optimization
        let bucketSql = sql`NULL`;
        try {
          const palette = JSON.parse(colors) as Array<{
            hue?: number;
            weight: number;
          }>;
          if (palette.length > 0 && palette[0].hue != null) {
            const bucket = Math.floor(palette[0].hue / 10) % 36;
            bucketSql = sql`${bucket}`;
          }
        } catch {
          /* keep NULL */
        }
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
