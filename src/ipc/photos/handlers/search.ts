import fs from "node:fs";
import { os } from "@orpc/server";
import type { SQL } from "drizzle-orm";
import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  like,
  lte,
  or,
  sql,
} from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import { getAiReadiness } from "@/services/ai/health";
import {
  extractTemporalContext,
  parseChineseQuery,
} from "@/services/ai/query-parser";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
  isAiSearchReady,
} from "@/services/ai-embedder";
import type { RewrittenQuery } from "@/services/query-rewrite";
import { rewriteQuery, timeFilterToDateRange } from "@/services/query-rewrite";
import { rerankWithCLIPScore } from "@/services/rerank";
import {
  COLOR_MATCH_MAX_DISTANCE_SQUARED,
  hydrateColorSearchResults,
  mergeColorSearchRanks,
} from "@/utils/color-search";
import {
  applyTimeDecay,
  CompoundSearchSchema,
  ImageSearchSchema,
  SearchSchema,
} from "./shared";

// ── Lightweight field selection for search results ───────────────────
// Excludes heavy columns (phash, contentHash, vectorId, duelPreviewPath)
// that are never needed in search result lists, saving ~150+ bytes/photo.
const SEARCH_PHOTO_COLUMNS = {
  id: photos.id,
  path: photos.path,
  folderId: photos.folderId,
  filename: photos.filename,
  fileSize: photos.fileSize,
  fileDate: photos.fileDate,
  width: photos.width,
  height: photos.height,
  format: photos.format,
  colorSpace: photos.colorSpace,
  hasAlpha: photos.hasAlpha,
  thumbnailPath: photos.thumbnailPath,
  thumbnailSize: photos.thumbnailSize,
  dominantColors: photos.dominantColors,
  colorBucket: photos.colorBucket,
  isIndexed: photos.isIndexed,
  isAiProcessed: photos.isAiProcessed,
  isFaceProcessed: photos.isFaceProcessed,
  isFavorite: photos.isFavorite,
  deletedAt: photos.deletedAt,
  createdAt: photos.createdAt,
};

// Pre-compiled regex patterns for color search and temporal detection
const HASH_PREFIX_RE = /^#/;
const HEX_COLOR_RE = /^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const HEX_COLOR_QUERY_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const CHINESE_CHAR_RE = /[一-鿿]/;
const GLOB_WILDCARD_RE = /[*?[]/;

function withoutInternalSearchScores<
  T extends { score?: number; similarity?: number },
>(results: T[]): Omit<T, "score" | "similarity">[] {
  return results.map(({ score: _score, similarity: _similarity, ...result }) =>
    result
  );
}

// ── 熔断与超时配置 ──────────────────────────────────────────────────
const AI_SEARCH_TIMEOUT_MS = 2000;
const AI_SEARCH_COLD_TIMEOUT_MS = 10_000;
const COLOR_VECTOR_TIMEOUT_MS = 250;
const SQLITE_LIKE_TIMEOUT_MS = 5000; // SQLite LIKE 查询软超时（已有 busy_timeout=5000）

// ── Hue bucket helper ──────────────────────────────────────────────────
// RGB → HSL hue → 36-bucket index (0-35), used for color-search pre-filter.
function rgbToHueBucket(r: number, g: number, b: number): number {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) {
    return 0; // achromatic → bucket 0
  }
  let hue: number;
  if (max === rn) {
    hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  } else if (max === gn) {
    hue = ((bn - rn) / delta + 2) * 60;
  } else {
    hue = ((rn - gn) / delta + 4) * 60;
  }
  return Math.floor(hue / 10) % 36;
}

// EXIF filter cache: cache key -> { result, timestamp }
const filterCache = new Map<string, { result: any; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const MAX_CACHE_SIZE = 50;

function getCacheKey(params: Record<string, unknown>): string {
  // Create a deterministic key excluding non-filter params
  const filterParams: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && key !== "limit" && key !== "query") {
      filterParams[key] = value;
    }
  }
  return JSON.stringify(filterParams, Object.keys(filterParams).sort());
}

function getCachedResult(cacheKey: string) {
  const entry = filterCache.get(cacheKey);
  if (entry && Date.now() - entry.timestamp < CACHE_TTL) {
    return entry.result;
  }
  if (entry) {
    filterCache.delete(cacheKey); // expired
  }
  return null;
}

function setCachedResult(cacheKey: string, result: any) {
  // Evict oldest if at capacity
  if (filterCache.size >= MAX_CACHE_SIZE) {
    const firstKey = filterCache.keys().next().value;
    if (firstKey !== undefined) {
      filterCache.delete(firstKey);
    }
  }
  filterCache.set(cacheKey, { result, timestamp: Date.now() });
}

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
      .select(SEARCH_PHOTO_COLUMNS)
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
        return {
          ...photo,
          match: { kind: "semantic" as const, score: r.similarity },
          similarity: r.similarity,
          fileDate: photo.fileDate,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    // Extract temporal boost from query if it contains time keywords
    const hasChinese = CHINESE_CHAR_RE.test(input.query);
    let temporalBoost: ReturnType<typeof extractTemporalContext> | undefined;
    if (hasChinese) {
      const parsed = parseChineseQuery(input.query);
      temporalBoost = extractTemporalContext(parsed);
    }

    const scored = applyTimeDecay(merged, { temporalBoost });
    return {
      results: withoutInternalSearchScores(scored),
      query: input.query,
    };
  });

export const searchByImage = os
  .input(ImageSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    // Verify the image file exists before attempting AI search
    if (!fs.existsSync(input.imagePath)) {
      return { results: [], error: "图片文件不存在" };
    }

    let results: Array<{ photoId: number; similarity: number }> = [];
    try {
      results = await aiSearchByImage(input.imagePath, input.limit);
    } catch (err: any) {
      console.error("[searchByImage] AI search failed:", err?.message);
      return {
        results: [],
        error: `AI 搜索失败: ${err?.message || "未知错误"}`,
      };
    }

    const photoIds = results.map((r) => r.photoId);
    if (photoIds.length === 0) {
      return {
        results: [],
        error: "未找到相似图片（请确认 AI 模型已就绪且图片已索引）",
      };
    }

    const photoList = db
      .select(SEARCH_PHOTO_COLUMNS)
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
        return {
          ...photo,
          match: { kind: "image" as const, score: r.similarity },
          similarity: r.similarity,
          fileDate: photo.fileDate,
        };
      })
      .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

    const scored = applyTimeDecay(merged);
    return { results: withoutInternalSearchScores(scored) };
  });

// ── 超时包装器 ──────────────────────────────────────────────────────
// 为异步操作添加硬超时，超时后自动 Reject，
// 与 Promise.allSettled 配合使用实现优雅降级。

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string
): Promise<T> {
  if (timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`[Timeout] ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    promise
      .then((result) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

// ── 从时间过滤器中构建 temporalBoost ───────────────────────────────
// 自动补全不完整的时间边界（如 "今年" 只有 from，补 to=Date.now()）

function buildTemporalBoost(
  dateFrom?: number,
  dateTo?: number
): { targetFrom: number; targetTo: number; factor: number } | undefined {
  if (dateFrom == null && dateTo == null) {
    return undefined;
  }
  const now = Date.now();
  const from = dateFrom ?? 0;
  const to = dateTo ?? now;
  // 根据时间窗口跨度选择 factor
  const spanMs = to - from;
  const oneDay = 24 * 60 * 60 * 1000;
  let factor: number;
  if (spanMs <= oneDay) {
    factor = 1.5; // 1天内 → 高提权
  } else if (spanMs <= 7 * oneDay) {
    factor = 1.4; // 1周内
  } else if (spanMs <= 31 * oneDay) {
    factor = 1.3; // 1月内
  } else {
    factor = 1.2; // 更长时间窗口
  }
  return { targetFrom: from, targetTo: to, factor };
}

// Compound search: text + EXIF filters
export const searchCompound = os
  .input(CompoundSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const {
      query,
      colorHex,
      dateFrom,
      dateMonth,
      dateHour,
      dateTo,
      cameraModel,
      lensModel,
      creator,
      advancedField,
      advancedValue,
      focalMin,
      focalMax,
      apertureMin,
      apertureMax,
      isoMin,
      isoMax,
      shutterMin,
      shutterMax,
      limit,
    } = input;
    const periodicDateConditions = (): SQL[] => {
      const conditions: SQL[] = [];
      if (dateMonth !== undefined) {
        conditions.push(
          sql`CAST(strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${dateMonth}`
        );
      }
      if (dateHour !== undefined) {
        conditions.push(
          sql`CAST(strftime('%H', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${dateHour}`
        );
      }
      return conditions;
    };
    const advancedColumns = {
      vendor: advancedExifData.vendor,
      captureMode: advancedExifData.captureMode,
      exposureProgram: advancedExifData.exposureProgram,
      meteringMode: advancedExifData.meteringMode,
      whiteBalance: advancedExifData.whiteBalance,
      focusMode: advancedExifData.focusMode,
      subjectTarget: advancedExifData.subjectTarget,
      driveMode: advancedExifData.driveMode,
      stabilizationMode: advancedExifData.stabilizationMode,
      computationalMode: advancedExifData.computationalMode,
      inCameraLook: advancedExifData.inCameraLook,
      provenanceStatus: advancedExifData.provenanceStatus,
    } as const;
    const getAdvancedIds = (within?: number[]) => {
      if (!(advancedField && advancedValue)) {
        return null;
      }
      const conditions: SQL[] = [
        eq(advancedColumns[advancedField], advancedValue),
      ];
      if (within) {
        if (within.length === 0) {
          return new Set<number>();
        }
        conditions.push(inArray(advancedExifData.photoId, within));
      }
      return new Set(
        db
          .select({ photoId: advancedExifData.photoId })
          .from(advancedExifData)
          .where(and(...conditions))
          .all()
          .map((row) => row.photoId)
      );
    };
    const getCreatorIds = (within?: number[]) => {
      if (!creator) {
        return null;
      }
      if (within?.length === 0) {
        return new Set<number>();
      }
      const pattern = `%${creator}%`;
      const basicConditions: SQL[] = [like(exifData.artist, pattern)];
      const advancedConditions: SQL[] = [
        sql`json_extract(${advancedExifData.normalizedJson}, '$.workflow.artist') LIKE ${pattern}`,
      ];
      if (within) {
        basicConditions.push(inArray(exifData.photoId, within));
        advancedConditions.push(inArray(advancedExifData.photoId, within));
      }
      const ids = new Set(
        db
          .select({ photoId: exifData.photoId })
          .from(exifData)
          .where(and(...basicConditions))
          .all()
          .map((row) => row.photoId)
          .filter((photoId): photoId is number => photoId !== null)
      );
      for (const row of db
        .select({ photoId: advancedExifData.photoId })
        .from(advancedExifData)
        .where(and(...advancedConditions))
        .all()) {
        ids.add(row.photoId);
      }
      return ids;
    };
    const creatorIds = getCreatorIds();
    if (creatorIds?.size === 0) {
      return { results: [], total: 0 };
    }

    // Color search: if colorHex provided, or query is a hex code
    function parseHexColor(
      hex: string
    ): { r: number; g: number; b: number } | null {
      const cleaned = hex.replace(HASH_PREFIX_RE, "");
      const match = HEX_COLOR_RE.exec(cleaned);
      if (!match) {
        return null;
      }
      let h = match[1];
      if (h.length === 3) {
        h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      }
      return {
        r: Number.parseInt(h.slice(0, 2), 16),
        g: Number.parseInt(h.slice(2, 4), 16),
        b: Number.parseInt(h.slice(4, 6), 16),
      };
    }

    let effectiveColorHex = colorHex;
    if (!effectiveColorHex && query?.trim()) {
      const hexMatch = HEX_COLOR_QUERY_RE.exec(query.trim());
      if (hexMatch) {
        effectiveColorHex = hexMatch[1];
      }
    }

    if (effectiveColorHex) {
      const rgb = parseHexColor(effectiveColorHex);
      if (rgb) {
        // ── 颜色搜索双路并行：LanceDB ANN + SQLite UDF ─────────────
        // LanceDB 颜色表可能稀疏（仅部分照片已索引），不能替代 SQLite。
        // 双路并行执行，合并结果去重，避免稀疏表导致的"全色块同一结果"。

        // Pre-filter: map target RGB to hue bucket (0-35) to shrink scan range
        const hueBucket = rgbToHueBucket(rgb.r, rgb.g, rgb.b);
        // Generate 3 candidate buckets (target ± 1, modulo 36)
        const candidateBuckets = [
          (hueBucket + 35) % 36,
          hueBucket,
          (hueBucket + 1) % 36,
        ];
        // Remove duplicates (when 36 wraps around)
        const buckets = [...new Set(candidateBuckets)].sort();

        const exifActive =
          dateFrom ||
          dateTo ||
          dateMonth !== undefined ||
          dateHour !== undefined ||
          cameraModel ||
          lensModel ||
          focalMin !== undefined ||
          focalMax !== undefined ||
          apertureMin !== undefined ||
          apertureMax !== undefined ||
          isoMin !== undefined ||
          isoMax !== undefined ||
          shutterMin !== undefined ||
          shutterMax !== undefined;

        const conditions: SQL[] = [
          sql`p.deleted_at IS NULL`,
          sql`p.dominant_colors IS NOT NULL`,
          sql`(p.color_bucket IS NULL OR p.color_bucket IN (${sql.raw(buckets.join(","))}))`,
        ];
        if (creatorIds) {
          conditions.push(
            sql`p.id IN (${sql.join(
              Array.from(creatorIds).map((id) => sql`${id}`),
              sql`, `
            )})`
          );
        }
        if (dateFrom) {
          conditions.push(sql`e.date_taken >= ${dateFrom}`);
        }
        if (dateTo) {
          conditions.push(sql`e.date_taken <= ${dateTo}`);
        }
        if (dateMonth !== undefined) {
          conditions.push(
            sql`CAST(strftime('%m', e.date_taken / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${dateMonth}`
          );
        }
        if (dateHour !== undefined) {
          conditions.push(
            sql`CAST(strftime('%H', e.date_taken / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${dateHour}`
          );
        }
        if (cameraModel) {
          conditions.push(sql`e.camera_model LIKE ${`%${cameraModel}%`}`);
        }
        if (lensModel) {
          conditions.push(sql`e.lens_model LIKE ${`%${lensModel}%`}`);
        }
        if (focalMin !== undefined) {
          conditions.push(sql`e.focal_length_num >= ${focalMin}`);
        }
        if (focalMax !== undefined) {
          conditions.push(sql`e.focal_length_num <= ${focalMax}`);
        }
        if (apertureMin !== undefined) {
          conditions.push(sql`e.aperture >= ${apertureMin}`);
        }
        if (apertureMax !== undefined) {
          conditions.push(sql`e.aperture <= ${apertureMax}`);
        }
        if (isoMin !== undefined) {
          conditions.push(sql`e.iso >= ${isoMin}`);
        }
        if (isoMax !== undefined) {
          conditions.push(sql`e.iso <= ${isoMax}`);
        }
        if (shutterMin !== undefined) {
          conditions.push(sql`e.shutter_speed_num >= ${shutterMin}`);
        }
        if (shutterMax !== undefined) {
          conditions.push(sql`e.shutter_speed_num <= ${shutterMax}`);
        }

        const candidateSql = exifActive
          ? sql`SELECT p.id, closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) AS dist
                FROM photos p
                JOIN exif_data e ON e.photo_id = p.id
                WHERE ${and(...conditions)}`
          : sql`SELECT p.id, closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) AS dist
                FROM photos p
                WHERE ${and(...conditions)}`;
        const sqliteResults = db.all(
          sql`WITH color_candidates AS MATERIALIZED (${candidateSql})
              SELECT id, dist FROM color_candidates
              WHERE dist < ${COLOR_MATCH_MAX_DISTANCE_SQUARED}
              ORDER BY dist ASC
              LIMIT ${limit}`
        ) as Array<{ dist: number; id: number }>;

        let lanceResults: Array<{ distanceSquared: number; photoId: number }> = [];
        if (sqliteResults.length < limit) {
          try {
            lanceResults = await withTimeout(
              (async () => {
                const { searchByColorVector } = await import(
                  "@/services/ai/vector-db"
                );
                const results = await searchByColorVector(
                  rgb.r,
                  rgb.g,
                  rgb.b,
                  limit
                );
                return (results ?? []).filter(
                  (result) =>
                    result.distanceSquared < COLOR_MATCH_MAX_DISTANCE_SQUARED &&
                    (!creatorIds || creatorIds.has(result.photoId))
                );
              })(),
              COLOR_VECTOR_TIMEOUT_MS,
              "ColorVector"
            );
          } catch {
            // SQLite is authoritative; vector search is only a fast supplement.
          }
        }

        const ranks = mergeColorSearchRanks(
          sqliteResults.map((result) => ({
            photoId: result.id,
            distanceSquared: result.dist,
          })),
          lanceResults,
          limit
        );
        const rankedIds = ranks.map((rank) => rank.photoId);
        const typedPhotos =
          rankedIds.length === 0
            ? []
            : db
                .select(SEARCH_PHOTO_COLUMNS)
                .from(photos)
                .where(
                  and(isNull(photos.deletedAt), inArray(photos.id, rankedIds))
                )
                .all();
        const photoList = hydrateColorSearchResults(ranks, typedPhotos);

        console.log(
          `[Search] Color #${effectiveColorHex}: SQLite=${sqliteResults.length} LanceDB=${lanceResults.length} merged=${photoList.length}`
        );

        return {
          results: photoList,
          total: photoList.length,
          searchMode: "color" as const,
        };
      }
    }

    // Pre-process: extract time filter from natural language
    let effectiveDateFrom = dateFrom;
    let effectiveDateTo = dateTo;
    let rewrittenTimeFilter: RewrittenQuery["timeFilter"] | undefined;
    let searchText = query;
    if (searchText?.trim()) {
      const q = searchText.trim();
      if (CHINESE_CHAR_RE.test(q)) {
        const rewritten = rewriteQuery(q);
        if (!(effectiveDateFrom || effectiveDateTo) && rewritten.timeFilter) {
          effectiveDateFrom = rewritten.timeFilter.from;
          effectiveDateTo = rewritten.timeFilter.to;
        }
        rewrittenTimeFilter = rewritten.timeFilter;
        // Pure time query → clear searchText, fall through to EXIF-only path
        searchText = rewritten.cleanQuery.trim() || undefined;
      }
    }

    // ── Glob wildcard shortcut ─────────────────────────────────────
    // When the query contains shell-style wildcard characters (*, ?, [abc]),
    // skip the expensive multi-source retrieval (AI, tags, FTS5, person)
    // and do a direct GLOB match against the filename column.
    // SQLite GLOB uses the same wildcard syntax as shell globs — no
    // translation needed. LOWER() makes the match case-insensitive.
    if (searchText?.trim() && GLOB_WILDCARD_RE.test(searchText.trim())) {
      const globPattern = searchText.trim();
      const baseConds: SQL[] = [
        isNull(photos.deletedAt),
        sql`LOWER(${photos.filename}) GLOB LOWER(${globPattern})`,
      ];
      if (creatorIds) {
        baseConds.push(inArray(photos.id, Array.from(creatorIds)));
      }

      const hasExifFilter =
        effectiveDateFrom ||
        effectiveDateTo ||
        dateMonth !== undefined ||
        dateHour !== undefined ||
        cameraModel ||
        lensModel ||
        focalMin !== undefined ||
        focalMax !== undefined ||
        apertureMin !== undefined ||
        apertureMax !== undefined ||
        isoMin !== undefined ||
        isoMax !== undefined ||
        shutterMin !== undefined ||
        shutterMax !== undefined;

      if (hasExifFilter) {
        const exifConds: SQL[] = [];
        if (effectiveDateFrom) {
          exifConds.push(sql`${exifData.dateTaken} >= ${effectiveDateFrom}`);
        }
        if (effectiveDateTo) {
          exifConds.push(sql`${exifData.dateTaken} <= ${effectiveDateTo}`);
        }
        exifConds.push(...periodicDateConditions());
        if (cameraModel) {
          exifConds.push(like(exifData.cameraModel, `%${cameraModel}%`));
        }
        if (lensModel) {
          exifConds.push(like(exifData.lensModel, `%${lensModel}%`));
        }
        if (focalMin !== undefined) {
          exifConds.push(gte(exifData.focalLengthNum, focalMin));
        }
        if (focalMax !== undefined) {
          exifConds.push(lte(exifData.focalLengthNum, focalMax));
        }
        if (apertureMin !== undefined) {
          exifConds.push(sql`${exifData.aperture} >= ${apertureMin}`);
        }
        if (apertureMax !== undefined) {
          exifConds.push(sql`${exifData.aperture} <= ${apertureMax}`);
        }
        if (isoMin !== undefined) {
          exifConds.push(gte(exifData.iso, isoMin));
        }
        if (isoMax !== undefined) {
          exifConds.push(lte(exifData.iso, isoMax));
        }
        if (shutterMin !== undefined) {
          exifConds.push(gte(exifData.shutterSpeedNum, shutterMin));
        }
        if (shutterMax !== undefined) {
          exifConds.push(lte(exifData.shutterSpeedNum, shutterMax));
        }

        const exifPhotoIds = db
          .select({ photoId: exifData.photoId })
          .from(exifData)
          .innerJoin(photos, eq(photos.id, exifData.photoId))
          .where(and(...baseConds, ...exifConds))
          .limit(limit)
          .all()
          .map((r) => r.photoId)
          .filter(Boolean) as number[];

        if (exifPhotoIds.length === 0) {
          return { results: [], query: globPattern, total: 0 };
        }

        const photoList = db
          .select(SEARCH_PHOTO_COLUMNS)
          .from(photos)
          .where(
            and(isNull(photos.deletedAt), inArray(photos.id, exifPhotoIds))
          )
          .orderBy(desc(photos.fileDate))
          .all();

        return {
          results: photoList,
          query: globPattern,
          total: photoList.length,
        };
      }

      // No EXIF filters — simple GLOB query
      const globResults = db
        .select(SEARCH_PHOTO_COLUMNS)
        .from(photos)
        .where(and(...baseConds))
        .orderBy(desc(photos.fileDate))
        .limit(limit)
        .all();

      return {
        results: globResults,
        query: globPattern,
        total: globResults.length,
      };
    }

    // Text query: multi-source retrieval → dedup → rerank
    if (searchText?.trim()) {
      const q = searchText.trim();
      const aiReadiness = await getAiReadiness({ loadModel: false });
      let semantic = {
        indexedPhotos: aiReadiness.indexedPhotos,
        reason: aiReadiness.lastError as string | undefined,
        state: aiReadiness.coverageState,
        totalPhotos: aiReadiness.totalPhotos,
        used: false,
      };

      // ── 提取原始查询中的潜在专有名词 token ─────────────────────
      // 中文姓名/标签通常 2-4 字，从原始 query 中提取 n-gram 子串，
      // 用于 SQLite LIKE 搜索，避免改写后丢失专有名词信息。
      function extractNameTokens(raw: string): string[] {
        // 去除已知停用词、口语词、标点
        let cleaned = raw;
        for (const c of [
          "的",
          "了",
          "着",
          "过",
          "吗",
          "呢",
          "吧",
          "啊",
          "在",
          "是",
          "有",
          "和",
          "与",
          "或",
          "及",
          "等",
          "这",
          "那",
          "也",
          "拍",
          "照",
          "找",
          "看",
          "帮",
        ]) {
          cleaned = cleaned.replaceAll(c, " ");
        }
        // 保留 2-4 字的中文连续片段
        const cjkOnly = cleaned.replace(/[^一-鿿]+/g, " ").trim();
        const tokens = new Set<string>();
        if (cjkOnly.length >= 2) {
          for (let len = 4; len >= 2; len--) {
            for (let i = 0; i <= cjkOnly.length - len; i++) {
              tokens.add(cjkOnly.slice(i, i + len));
            }
          }
        }
        return [...tokens].slice(0, 12); // 上限 12 个 token，避免 SQL 过大
      }

      const nameTokens = extractNameTokens(input.query ?? "");
      // 构建 OR LIKE 条件：column LIKE '%token1%' OR column LIKE '%token2%' ...
      function buildTokenConditions(
        tokens: string[],
        field: any,
        fallbackQ: string
      ): SQL[] {
        // 始终包含完整 q 的 LIKE 条件 + 所有 n-gram token 的 OR 条件
        // 不做 dedup：n-gram LIKE '%小美%' 与完整 LIKE '%小美床上%' 匹配不同行
        const conditions: SQL[] = [like(field, `%${fallbackQ}%`)];
        for (const token of tokens) {
          if (token !== fallbackQ) {
            conditions.push(like(field, `%${token}%`));
          }
        }
        return conditions;
      }

      // ── 四路并行召回（Promise.allSettled + 硬超时） ─────────────────
      // 替代脆弱的 Promise.all：单路故障不影响其他路结果。
      // 已预热的语义搜索限制为 2s；冷启动允许 10s 完成模型和数据库初始化。

      const aiSearchWasReady = isAiSearchReady();
      const aiSearchTimeoutMs = aiSearchWasReady
        ? AI_SEARCH_TIMEOUT_MS
        : AI_SEARCH_COLD_TIMEOUT_MS;
      const semanticAvailable =
        aiReadiness.coverageState === "ready" ||
        aiReadiness.coverageState === "partial";
      const settled = await Promise.allSettled([
        // 路 1：CLIP 文本推理 + LanceDB 向量召回
        semanticAvailable
          ? withTimeout(
              aiSearchByText(q, 200),
              aiSearchTimeoutMs,
              aiSearchWasReady
                ? "AI semantic search"
                : "AI semantic search warmup"
            )
          : Promise.resolve([]),
        // 路 2：标签库 LIKE 搜索（原始 query token + 改写后 query 双路）
        db
          .select({ id: photos.id })
          .from(photos)
          .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
          .innerJoin(tags, eq(tags.id, photoTags.tagId))
          .where(
            and(
              isNull(photos.deletedAt),
              or(...buildTokenConditions(nameTokens, tags.name, q))
            )
          )
          .all(),
        // 路 3：文件名搜索 — FTS5 MATCH 优先，LIKE 回退
        (async () => {
          // FTS5 简单模式下仅 " 为特殊字符；
          // * 和 ? 已由上方的 glob 短路路径处理，不会到达此处。
          const needsFts5Escape = /["]/.test(q);
          if (!needsFts5Escape && q.trim().length > 0) {
            try {
              const normalized = q.trim().replace(/\s+/g, " ");
              const terms = normalized
                .split(/\s+/)
                .map((t) => `"${t}"*`)
                .join(" ");
              const ftsResults = db.all(
                sql`SELECT rowid AS id FROM photos_fts WHERE photos_fts MATCH ${terms}`
              ) as Array<{ id: number }>;
              if (ftsResults.length > 0) {
                return ftsResults;
              }
            } catch {
              // FTS5 语法错误 → 回退到 LIKE
            }
          }
          // LIKE 回退
          return db
            .select({ id: photos.id })
            .from(photos)
            .where(
              and(isNull(photos.deletedAt), like(photos.filename, `%${q}%`))
            )
            .all();
        })(),
        // 路 4：人脸识别名搜索（token 化匹配中文姓名）
        db
          .select({ id: photos.id })
          .from(photos)
          .innerJoin(faceVectors, eq(faceVectors.photoId, photos.id))
          .innerJoin(
            faceIdentityMembers,
            eq(faceIdentityMembers.faceVectorId, faceVectors.id)
          )
          .innerJoin(
            faceIdentities,
            eq(faceIdentities.id, faceIdentityMembers.identityId)
          )
          .where(
            and(
              isNull(photos.deletedAt),
              or(...buildTokenConditions(nameTokens, faceIdentities.name, q))
            )
          )
          .all(),
      ]);

      // 拆解 allSettled 结果，记录降级日志
      const aiResults =
        settled[0].status === "fulfilled"
          ? (settled[0].value as Awaited<ReturnType<typeof aiSearchByText>>)
          : [];
      semantic = {
        ...semantic,
        reason:
          settled[0].status === "rejected"
            ? ((settled[0].reason as Error)?.message ??
              "semantic-search-failed")
            : semantic.reason,
        used: semanticAvailable && settled[0].status === "fulfilled",
      };
      const tagPhotoRows =
        settled[1].status === "fulfilled"
          ? (settled[1].value as { id: number }[])
          : [];
      const filenamePhotoRows =
        settled[2].status === "fulfilled"
          ? (settled[2].value as { id: number }[])
          : [];
      const personPhotoRows =
        settled[3].status === "fulfilled"
          ? (settled[3].value as { id: number }[])
          : [];

      if (settled[0].status === "rejected") {
        console.warn(
          `[Search] AI semantic recall degraded: ${settled[0].reason?.message ?? "timeout"}. Proceeding with SQLite-only results.`
        );
      }
      if (settled[1].status === "rejected") {
        console.warn(
          "[Search] Tag search degraded:",
          settled[1].reason?.message
        );
      }
      if (settled[2].status === "rejected") {
        console.warn(
          "[Search] Filename search degraded:",
          settled[2].reason?.message
        );
      }
      if (settled[3].status === "rejected") {
        console.warn(
          "[Search] Person search degraded:",
          settled[3].reason?.message
        );
      }

      // ── 合并去重（保留来源标记供晚期融合使用） ────────────────────
      // Merge with dedup priority: person > tag > filename > AI
      const merged = new Map<
        number,
        {
          photoId: number;
          similarity: number;
          _source: "person" | "tag" | "filename" | "ai";
        }
      >();

      for (const r of personPhotoRows) {
        merged.set(r.id, {
          photoId: r.id,
          similarity: 1.0,
          _source: "person",
        });
      }
      for (const r of tagPhotoRows) {
        const existing = merged.get(r.id);
        if (!existing || existing.similarity < 0.95) {
          merged.set(r.id, {
            photoId: r.id,
            similarity: 0.95,
            _source: "tag",
          });
        }
      }
      for (const r of filenamePhotoRows) {
        const existing = merged.get(r.id);
        if (!existing || existing.similarity < 0.7) {
          merged.set(r.id, {
            photoId: r.id,
            similarity: 0.7,
            _source: "filename",
          });
        }
      }
      for (const r of aiResults) {
        const existing = merged.get(r.photoId);
        if (!existing || existing.similarity < r.similarity) {
          merged.set(r.photoId, {
            photoId: r.photoId,
            similarity: r.similarity,
            _source: "ai",
          });
        }
      }

      const mergedList = [...merged.values()];

      if (mergedList.length === 0) {
        // If time filter was parsed from query, skip AI and do plain date filter
        if (
          effectiveDateFrom ||
          effectiveDateTo ||
          dateMonth !== undefined ||
          dateHour !== undefined
        ) {
          const dateConditions: SQL[] = [];
          if (effectiveDateFrom) {
            dateConditions.push(gte(exifData.dateTaken, effectiveDateFrom));
          }
          if (effectiveDateTo) {
            dateConditions.push(lte(exifData.dateTaken, effectiveDateTo));
          }
          dateConditions.push(...periodicDateConditions());
          const dateFiltered = db
            .select({ photoId: exifData.photoId })
            .from(exifData)
            .where(and(...dateConditions))
            .limit(limit)
            .all();
          const datePhotoIds = dateFiltered
            .map((e) => e.photoId)
            .filter(Boolean) as number[];
          if (datePhotoIds.length > 0) {
            const datePhotos = db
              .select(SEARCH_PHOTO_COLUMNS)
              .from(photos)
              .where(
                and(isNull(photos.deletedAt), inArray(photos.id, datePhotoIds))
              )
              .orderBy(desc(photos.fileDate))
              .limit(limit)
              .all();
            return {
              results: datePhotos,
              query: q,
              total: datePhotos.length,
              semantic,
              ...(rewrittenTimeFilter
                ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
                : {}),
            };
          }
        }
        return { results: [], query: q, total: 0, semantic };
      }

      let rerankedList = mergedList;
      try {
        if (mergedList.length > 20 && q) {
          const rerankTopK = Math.max(limit, 200);
          const sources = new Map(
            mergedList.map((item) => [item.photoId, item._source])
          );
          rerankedList = (
            await rerankWithCLIPScore(q, mergedList, rerankTopK)
          ).map((item) => ({
            ...item,
            _source: sources.get(item.photoId) ?? "ai",
          }));
        }
      } catch {
        // Rerank failed, continue with merged results
      }

      const toSearchMatch = (result: (typeof rerankedList)[number]) =>
        result._source === "ai"
          ? ({ kind: "semantic" as const, score: result.similarity })
          : ({ kind: "exact" as const, source: result._source });

      const hasExifOrTimeFilter =
        effectiveDateFrom ||
        effectiveDateTo ||
        dateMonth !== undefined ||
        dateHour !== undefined ||
        cameraModel ||
        lensModel ||
        creator ||
        focalMin !== undefined ||
        focalMax !== undefined ||
        apertureMin !== undefined ||
        apertureMax !== undefined ||
        isoMin !== undefined ||
        isoMax !== undefined ||
        shutterMin !== undefined ||
        shutterMax !== undefined ||
        Boolean(advancedField && advancedValue);

      if (!hasExifOrTimeFilter) {
        const allIds = rerankedList.map((r) => r.photoId);
        const photoList = db
          .select(SEARCH_PHOTO_COLUMNS)
          .from(photos)
          .where(inArray(photos.id, allIds))
          .all();
        const photoMap = new Map(photoList.map((p) => [p.id, p]));
        const combined = rerankedList
          .map((r) => {
            const photo = photoMap.get(r.photoId);
            if (!photo) {
              return null;
            }
            return {
              ...photo,
              match: toSearchMatch(r),
              similarity: r.similarity,
              fileDate: photo.fileDate,
            };
          })
          .filter(
            (p): p is NonNullable<typeof p> => p !== null && p.id != null
          );

        const temporalBoost = buildTemporalBoost(
          effectiveDateFrom,
          effectiveDateTo
        );
        const scored = applyTimeDecay(combined, { temporalBoost });
        return {
          results: withoutInternalSearchScores(scored.slice(0, limit)),
          query: q,
          total: scored.length,
          semantic,
          ...(rewrittenTimeFilter
            ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
            : {}),
        };
      }

      // 7) Apply EXIF/time filters on merged results
      const allIds = rerankedList.map((r) => r.photoId);
      const exifConditions: SQL[] = [];

      if (effectiveDateFrom) {
        exifConditions.push(sql`${exifData.dateTaken} >= ${effectiveDateFrom}`);
      }
      if (effectiveDateTo) {
        exifConditions.push(sql`${exifData.dateTaken} <= ${effectiveDateTo}`);
      }
      exifConditions.push(...periodicDateConditions());
      if (cameraModel) {
        exifConditions.push(like(exifData.cameraModel, `%${cameraModel}%`));
      }
      if (lensModel) {
        exifConditions.push(like(exifData.lensModel, `%${lensModel}%`));
      }
      if (focalMin !== undefined) {
        exifConditions.push(gte(exifData.focalLengthNum, focalMin));
      }
      if (focalMax !== undefined) {
        exifConditions.push(lte(exifData.focalLengthNum, focalMax));
      }
      if (apertureMin !== undefined) {
        exifConditions.push(sql`${exifData.aperture} >= ${apertureMin}`);
      }
      if (apertureMax !== undefined) {
        exifConditions.push(sql`${exifData.aperture} <= ${apertureMax}`);
      }
      if (isoMin !== undefined) {
        exifConditions.push(gte(exifData.iso, isoMin));
      }
      if (isoMax !== undefined) {
        exifConditions.push(lte(exifData.iso, isoMax));
      }
      if (shutterMin !== undefined) {
        exifConditions.push(gte(exifData.shutterSpeedNum, shutterMin));
      }
      if (shutterMax !== undefined) {
        exifConditions.push(lte(exifData.shutterSpeedNum, shutterMax));
      }

      const validIds =
        exifConditions.length > 0
          ? new Set(
              db
                .select({ photoId: exifData.photoId })
                .from(exifData)
                .where(
                  and(
                    inArray(exifData.photoId, allIds),
                    ...exifConditions
                  )
                )
                .all()
                .map((row) => row.photoId)
                .filter((photoId): photoId is number => photoId !== null)
            )
          : new Set(allIds);
      const advancedIds = getAdvancedIds(allIds);

      const filtered = rerankedList.filter(
        (r) =>
          validIds.has(r.photoId) &&
          (!creatorIds || creatorIds.has(r.photoId)) &&
          (!advancedIds || advancedIds.has(r.photoId))
      );

      if (filtered.length === 0) {
        return {
          results: [],
          query: q,
          total: 0,
          semantic,
          ...(rewrittenTimeFilter
            ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
            : {}),
        };
      }
      const filteredIds = filtered.map((r) => r.photoId);
      const photoList = db
        .select(SEARCH_PHOTO_COLUMNS)
        .from(photos)
        .where(inArray(photos.id, filteredIds))
        .all();
      const photoMap = new Map(photoList.map((p) => [p.id, p]));
      const combined = filtered
        .map((r) => {
          const photo = photoMap.get(r.photoId);
          if (!photo) {
            return null;
          }
          return {
            ...photo,
            match: toSearchMatch(r),
            similarity: r.similarity,
            fileDate: photo.fileDate,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

      const temporalBoost = buildTemporalBoost(
        effectiveDateFrom,
        effectiveDateTo
      );
      const scored = applyTimeDecay(combined, { temporalBoost });
      return {
        results: withoutInternalSearchScores(scored.slice(0, limit)),
        query: q,
        total: scored.length,
        semantic,
        ...(rewrittenTimeFilter
          ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
          : {}),
      };
    }

    // No text query: EXIF-only filter
    const hasEffectiveFilters =
      effectiveDateFrom ||
      effectiveDateTo ||
      dateMonth !== undefined ||
      dateHour !== undefined ||
      cameraModel ||
      lensModel ||
      creator ||
      focalMin !== undefined ||
      focalMax !== undefined ||
      apertureMin !== undefined ||
      apertureMax !== undefined ||
      isoMin !== undefined ||
      isoMax !== undefined ||
      shutterMin !== undefined ||
      shutterMax !== undefined ||
      Boolean(advancedField && advancedValue);
    if (!hasEffectiveFilters) {
      const items = db
        .select(SEARCH_PHOTO_COLUMNS)
        .from(photos)
        .orderBy(desc(photos.fileDate))
        .limit(limit)
        .all();
      return { results: items, total: items.length };
    }

    // Check EXIF-only filter cache (only for non-AI path)
    const cacheKey = getCacheKey(input);
    const cached = getCachedResult(cacheKey);
    if (cached) {
      return cached;
    }

    const exifConditions: SQL[] = [];

    if (effectiveDateFrom) {
      exifConditions.push(sql`${exifData.dateTaken} >= ${effectiveDateFrom}`);
    }
    if (effectiveDateTo) {
      exifConditions.push(sql`${exifData.dateTaken} <= ${effectiveDateTo}`);
    }
    exifConditions.push(...periodicDateConditions());
    if (cameraModel) {
      exifConditions.push(like(exifData.cameraModel, `%${cameraModel}%`));
    }
    if (lensModel) {
      exifConditions.push(like(exifData.lensModel, `%${lensModel}%`));
    }
    if (creatorIds) {
      exifConditions.push(
        inArray(exifData.photoId, Array.from(creatorIds))
      );
    }
    if (focalMin !== undefined) {
      exifConditions.push(gte(exifData.focalLengthNum, focalMin));
    }
    if (focalMax !== undefined) {
      exifConditions.push(lte(exifData.focalLengthNum, focalMax));
    }
    if (apertureMin !== undefined) {
      exifConditions.push(sql`${exifData.aperture} >= ${apertureMin}`);
    }
    if (apertureMax !== undefined) {
      exifConditions.push(sql`${exifData.aperture} <= ${apertureMax}`);
    }
    if (isoMin !== undefined) {
      exifConditions.push(gte(exifData.iso, isoMin));
    }
    if (isoMax !== undefined) {
      exifConditions.push(lte(exifData.iso, isoMax));
    }
    if (shutterMin !== undefined) {
      exifConditions.push(gte(exifData.shutterSpeedNum, shutterMin));
    }
    if (shutterMax !== undefined) {
      exifConditions.push(lte(exifData.shutterSpeedNum, shutterMax));
    }
    const allAdvancedIds = getAdvancedIds();
    if (allAdvancedIds) {
      if (allAdvancedIds.size === 0) {
        const emptyResult = { results: [], total: 0 };
        setCachedResult(cacheKey, emptyResult);
        return emptyResult;
      }
      exifConditions.push(
        inArray(exifData.photoId, Array.from(allAdvancedIds))
      );
    }

    const exifBaseQuery = db
      .select({ photoId: exifData.photoId })
      .from(exifData)
      .$dynamic();

    const filteredExif = (
      exifConditions.length > 0
        ? exifBaseQuery.where(and(...exifConditions))
        : exifBaseQuery
    )
      .limit(limit)
      .all();
    const exifPhotoIds = filteredExif.map((e) => e.photoId!).filter(Boolean);

    if (exifPhotoIds.length === 0) {
      const emptyResult = { results: [], total: 0 };
      setCachedResult(cacheKey, emptyResult);
      return emptyResult;
    }

    const photoList = db
      .select(SEARCH_PHOTO_COLUMNS)
      .from(photos)
      .where(inArray(photos.id, exifPhotoIds))
      .limit(limit)
      .all();

    const result = { results: photoList, total: photoList.length };
    setCachedResult(cacheKey, result);
    return result;
  });

// ── Spotlight 轻量搜索 ───────────────────────────────────────────────
// 专为 Ctrl+K 全局搜索设计：仅返回 id + filename + thumbnailPath，
// 跳过 LanceDB CLIP 推理和四路并行重排，延迟极低（通常 < 30ms）。
export const searchSpotlight = os
  .input(SearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const q = input.query.trim();
    const limit = Math.min(input.limit ?? 8, 12);

    // 两路快速召回：FTS5 文件名 + 标签 LIKE（跳过 AI 和人脸）
    const settled = await Promise.allSettled([
      // 路 1：FTS5 文件名 MATCH（优先）→ LIKE 回退
      (async () => {
        const needsFts5Escape = /["]/.test(q);
        if (!needsFts5Escape && q.length > 0) {
          try {
            const normalized = q.replace(/\s+/g, " ");
            const terms = normalized
              .split(/\s+/)
              .map((t) => `"${t}"*`)
              .join(" ");
            const ftsResults = db.all(
              sql`SELECT rowid AS id FROM photos_fts WHERE photos_fts MATCH ${terms}`
            ) as Array<{ id: number }>;
            if (ftsResults.length > 0) {
              return ftsResults.slice(0, limit);
            }
          } catch {
            /* FTS5 error → fallback */
          }
        }
        return db
          .select({ id: photos.id })
          .from(photos)
          .where(and(isNull(photos.deletedAt), like(photos.filename, `%${q}%`)))
          .limit(limit)
          .all();
      })(),
      // 路 2：标签 LIKE 搜索
      db
        .select({ id: photos.id })
        .from(photos)
        .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
        .innerJoin(tags, eq(tags.id, photoTags.tagId))
        .where(and(isNull(photos.deletedAt), like(tags.name, `%${q}%`)))
        .limit(limit)
        .all(),
    ]);

    // 合并去重（标签优先作为精确匹配）
    const merged = new Map<number, number>();
    const tagRows = settled[1].status === "fulfilled" ? settled[1].value : [];
    const ftsRows = settled[0].status === "fulfilled" ? settled[0].value : [];

    for (const r of tagRows) {
      merged.set(r.id, 1);
    }
    for (const r of ftsRows) {
      if (!merged.has(r.id)) {
        merged.set(r.id, 0);
      }
    }

    const ids = [...merged.keys()].slice(0, limit);
    if (ids.length === 0) {
      return { results: [], query: q };
    }

    // 仅返回三字段，IPC payload 极小
    const results = db
      .select({
        id: photos.id,
        filename: photos.filename,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
      })
      .from(photos)
      .where(inArray(photos.id, ids))
      .all();

    return { results, query: q };
  });
