import fs from "node:fs";
import { os } from "@orpc/server";
import type { SQL } from "drizzle-orm";
import { and, desc, gte, inArray, like, lte, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, photos } from "@/db/schema";
import {
  extractTemporalContext,
  parseChineseQuery,
} from "@/services/ai/query-parser";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
} from "@/services/ai-embedder";
import {
  applyTimeDecay,
  CompoundSearchSchema,
  ImageSearchSchema,
  SearchSchema,
} from "./shared";

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
    const hasChinese = /[一-鿿]/.test(input.query);
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

    const hasExifFilters =
      dateFrom ||
      dateTo ||
      cameraModel ||
      lensModel ||
      focalMin ||
      focalMax ||
      apertureMin ||
      apertureMax ||
      isoMin ||
      isoMax ||
      shutterMin ||
      shutterMax;

    // If text query: AI search first, then apply EXIF filters on the results
    if (query?.trim()) {
      const aiResults = await aiSearchByText(query.trim(), 200);
      const photoIds = aiResults.map((r) => r.photoId);

      if (photoIds.length === 0) {
        const fallbackResults = db
          .select()
          .from(photos)
          .where(like(photos.filename, `%${query.trim()}%`))
          .limit(limit)
          .all();
        if (fallbackResults.length > 0) {
          return {
            results: fallbackResults.map((p) => ({ ...p, similarity: 0 })),
            query: query.trim(),
            total: fallbackResults.length,
            fallback: "filename" as const,
          };
        }
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
      const aiExifConditions: SQL[] = [];

      if (dateFrom) {
        aiExifConditions.push(sql`${exifData.dateTaken} >= ${dateFrom}`);
      }
      if (dateTo) {
        aiExifConditions.push(sql`${exifData.dateTaken} <= ${dateTo}`);
      }
      if (cameraModel) {
        aiExifConditions.push(like(exifData.cameraModel, `%${cameraModel}%`));
      }
      if (lensModel) {
        aiExifConditions.push(like(exifData.lensModel, `%${lensModel}%`));
      }
      if (focalMin !== undefined) {
        aiExifConditions.push(gte(exifData.focalLengthNum, focalMin));
      }
      if (focalMax !== undefined) {
        aiExifConditions.push(lte(exifData.focalLengthNum, focalMax));
      }
      if (apertureMin !== undefined) {
        aiExifConditions.push(sql`${exifData.aperture} >= ${apertureMin}`);
      }
      if (apertureMax !== undefined) {
        aiExifConditions.push(sql`${exifData.aperture} <= ${apertureMax}`);
      }
      if (isoMin !== undefined) {
        aiExifConditions.push(gte(exifData.iso, isoMin));
      }
      if (isoMax !== undefined) {
        aiExifConditions.push(lte(exifData.iso, isoMax));
      }
      if (shutterMin !== undefined) {
        aiExifConditions.push(gte(exifData.shutterSpeedNum, shutterMin));
      }
      if (shutterMax !== undefined) {
        aiExifConditions.push(lte(exifData.shutterSpeedNum, shutterMax));
      }

      const aiExifBaseQuery = db
        .select({ photoId: exifData.photoId })
        .from(exifData)
        .where(inArray(exifData.photoId, photoIds))
        .$dynamic();

      const filteredExif = (
        aiExifConditions.length > 0
          ? aiExifBaseQuery.where(and(...aiExifConditions))
          : aiExifBaseQuery
      ).all();
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

    // Check EXIF-only filter cache (only for non-AI path)
    const cacheKey = getCacheKey(input);
    const cached = getCachedResult(cacheKey);
    if (cached) return cached;

    const exifConditions: SQL[] = [];

    if (dateFrom) {
      exifConditions.push(sql`${exifData.dateTaken} >= ${dateFrom}`);
    }
    if (dateTo) {
      exifConditions.push(sql`${exifData.dateTaken} <= ${dateTo}`);
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
