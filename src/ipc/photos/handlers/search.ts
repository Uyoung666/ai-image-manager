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
  sql,
} from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  exifData,
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import {
  extractTemporalContext,
  parseChineseQuery,
} from "@/services/ai/query-parser";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
} from "@/services/ai-embedder";
import type { RewrittenQuery } from "@/services/query-rewrite";
import { rewriteQuery, timeFilterToDateRange } from "@/services/query-rewrite";
import { rerankWithCLIPScore } from "@/services/rerank";
import {
  applyTimeDecay,
  CompoundSearchSchema,
  ImageSearchSchema,
  SearchSchema,
} from "./shared";

// Pre-compiled regex patterns for color search and temporal detection
const HASH_PREFIX_RE = /^#/;
const HEX_COLOR_RE = /^([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const HEX_COLOR_QUERY_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const CHINESE_CHAR_RE = /[一-鿿]/;

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

    // Extract temporal boost from query if it contains time keywords
    const hasChinese = CHINESE_CHAR_RE.test(input.query);
    let temporalBoost: ReturnType<typeof extractTemporalContext> | undefined;
    if (hasChinese) {
      const parsed = parseChineseQuery(input.query);
      temporalBoost = extractTemporalContext(parsed);
    }

    const scored = applyTimeDecay(merged, { temporalBoost });
    return { results: scored, query: input.query };
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
export const searchCompound = os
  .input(CompoundSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const {
      query,
      colorHex,
      dateFrom,
      dateTo,
      cameraModel,
      lensModel,
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
        // 动态构建 SQL：颜色搜索 + 可选 EXIF 叠加
        const exifActive =
          dateFrom ||
          dateTo ||
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

        let colorSQL = sql``;
        if (exifActive) {
          // 有 EXIF 筛选：JOIN exif_data 并附加条件
          const conditions: SQL[] = [];
          conditions.push(sql`p.deleted_at IS NULL`);
          conditions.push(sql`p.dominant_colors IS NOT NULL`);
          if (dateFrom) {
            conditions.push(sql`e.date_taken >= ${dateFrom}`);
          }
          if (dateTo) {
            conditions.push(sql`e.date_taken <= ${dateTo}`);
          }
          if (cameraModel) {
            conditions.push(
              sql`e.camera_model LIKE ${"%" + cameraModel + "%"}`
            );
          }
          if (lensModel) {
            conditions.push(sql`e.lens_model LIKE ${"%" + lensModel + "%"}`);
          }
          if (focalMin !== undefined) {
            conditions.push(sql`CAST(e.focal_length AS REAL) >= ${focalMin}`);
          }
          if (focalMax !== undefined) {
            conditions.push(sql`CAST(e.focal_length AS REAL) <= ${focalMax}`);
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
            conditions.push(
              sql`CAST(e.shutter_speed AS REAL) >= ${shutterMin}`
            );
          }
          if (shutterMax !== undefined) {
            conditions.push(
              sql`CAST(e.shutter_speed AS REAL) <= ${shutterMax}`
            );
          }

          colorSQL = sql`SELECT p.*, closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) AS dist
              FROM photos p
              JOIN exif_data e ON e.photo_id = p.id
              WHERE ${and(...conditions)}
                AND closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) < 10000
              ORDER BY dist ASC
              LIMIT ${limit}`;
        } else {
          colorSQL = sql`SELECT p.*, closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) AS dist
              FROM photos p
              WHERE p.deleted_at IS NULL AND p.dominant_colors IS NOT NULL
                AND closest_color_dist(${rgb.r}, ${rgb.g}, ${rgb.b}, p.dominant_colors) < 10000
              ORDER BY dist ASC
              LIMIT ${limit}`;
        }

        const results = db.all(colorSQL) as Array<
          Record<string, unknown> & { dist: number }
        >;

        const photoList = results.map((r) => ({
          ...r,
          id: r.id as number,
          similarity:
            Math.round((1 / (1 + Math.sqrt(r.dist || 0))) * 10_000) / 10_000,
        }));

        return {
          results: photoList as any,
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

    // Text query: multi-source retrieval → dedup → rerank
    if (searchText?.trim()) {
      const q = searchText.trim();

      const [aiResults, tagPhotoRows, filenamePhotoRows, personPhotoRows] =
        await Promise.all([
          aiSearchByText(q, 200),
          db
            .select({ id: photos.id })
            .from(photos)
            .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
            .innerJoin(tags, eq(tags.id, photoTags.tagId))
            .where(
              and(
                isNull(photos.deletedAt),
                like(tags.name, `%${q}%`)
              )
            )
            .all(),
          db
            .select({ id: photos.id })
            .from(photos)
            .where(
              and(
                isNull(photos.deletedAt),
                like(photos.filename, `%${q}%`)
              )
            )
            .all(),
          // Person name search: match face_identities.name
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
                like(faceIdentities.name, `%${q}%`)
              )
            )
            .all(),
        ]);

      // Merge with dedup priority: person > tag > filename > AI
      const merged = new Map<number, { photoId: number; similarity: number }>();

      for (const r of personPhotoRows) {
        merged.set(r.id, { photoId: r.id, similarity: 1.0 });
      }
      for (const r of tagPhotoRows) {
        const existing = merged.get(r.id);
        if (!existing || existing.similarity < 0.95) {
          merged.set(r.id, { photoId: r.id, similarity: 0.95 });
        }
      }
      for (const r of filenamePhotoRows) {
        const existing = merged.get(r.id);
        if (!existing || existing.similarity < 0.7) {
          merged.set(r.id, { photoId: r.id, similarity: 0.7 });
        }
      }
      for (const r of aiResults) {
        const existing = merged.get(r.photoId);
        if (!existing || existing.similarity < r.similarity) {
          merged.set(r.photoId, {
            photoId: r.photoId,
            similarity: r.similarity,
          });
        }
      }

      const mergedList = [...merged.values()];

      if (mergedList.length === 0) {
        // If time filter was parsed from query, skip AI and do plain date filter
        if (effectiveDateFrom || effectiveDateTo) {
          const dateConditions: SQL[] = [];
          if (effectiveDateFrom)
            dateConditions.push(gte(exifData.dateTaken, effectiveDateFrom));
          if (effectiveDateTo)
            dateConditions.push(lte(exifData.dateTaken, effectiveDateTo));
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
              .select()
              .from(photos)
              .where(and(isNull(photos.deletedAt), inArray(photos.id, datePhotoIds)))
              .orderBy(desc(photos.fileDate))
              .limit(limit)
              .all();
            return {
              results: datePhotos,
              query: q,
              total: datePhotos.length,
              ...(rewrittenTimeFilter
                ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
                : {}),
            };
          }
        }
        return { results: [], query: q, total: 0 };
      }

      let rerankedList = mergedList;
      try {
        if (mergedList.length > 20 && q) {
          const rerankTopK = Math.max(limit, 200);
          rerankedList = await rerankWithCLIPScore(
            q,
            mergedList,
            rerankTopK
          );
        }
      } catch {
        // Rerank failed, continue with merged results
      }

      const hasExifOrTimeFilter =
        effectiveDateFrom ||
        effectiveDateTo ||
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

      if (!hasExifOrTimeFilter) {
        const allIds = rerankedList.map((r) => r.photoId);
        const photoList = db
          .select()
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
              similarity: r.similarity,
              fileDate: photo.fileDate,
            };
          })
          .filter(
            (p): p is NonNullable<typeof p> => p !== null && p.id != null
          );

        const temporalBoost =
          effectiveDateFrom && effectiveDateTo
            ? {
                targetFrom: effectiveDateFrom,
                targetTo: effectiveDateTo,
                factor: 1.4,
              }
            : undefined;
        const scored = applyTimeDecay(combined, { temporalBoost });
        return {
          results: scored.slice(0, limit),
          query: q,
          total: scored.length,
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

      const exifBaseQuery = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(inArray(exifData.photoId, allIds))
        .$dynamic();

      const filteredExif = (
        exifConditions.length > 0
          ? exifBaseQuery.where(and(...exifConditions))
          : exifBaseQuery
      ).all();
      const validIds = new Set(filteredExif.map((e) => e.photoId!));

      const filtered = rerankedList.filter((r) => validIds.has(r.photoId));

      if (filtered.length === 0) {
        return {
          results: [],
          query: q,
          total: 0,
          ...(rewrittenTimeFilter
            ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
            : {}),
        };
      }
      const filteredIds = filtered.map((r) => r.photoId);
      const photoList = db
        .select()
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
            similarity: r.similarity,
            fileDate: photo.fileDate,
          };
        })
        .filter((p): p is NonNullable<typeof p> => p !== null && p.id != null);

      const scored = applyTimeDecay(combined);
      return {
        results: scored.slice(0, limit),
        query: q,
        total: scored.length,
        ...(rewrittenTimeFilter
          ? { timeFilter: timeFilterToDateRange(rewrittenTimeFilter) }
          : {}),
      };
    }

    // No text query: EXIF-only filter
    const hasEffectiveFilters =
      effectiveDateFrom ||
      effectiveDateTo ||
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
    if (!hasEffectiveFilters) {
      const items = db
        .select()
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
      exifConditions.push(
        sql`${exifData.dateTaken} >= ${effectiveDateFrom}`
      );
    }
    if (effectiveDateTo) {
      exifConditions.push(
        sql`${exifData.dateTaken} <= ${effectiveDateTo}`
      );
    }
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
      .select()
      .from(photos)
      .where(inArray(photos.id, exifPhotoIds))
      .limit(limit)
      .all();

    const result = { results: photoList, total: photoList.length };
    setCachedResult(cacheKey, result);
    return result;
  });
