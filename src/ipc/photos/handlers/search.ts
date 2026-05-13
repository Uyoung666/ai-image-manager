import fs from "node:fs";
import { os } from "@orpc/server";
import { desc, gte, inArray, like, lte, sql } from "drizzle-orm";
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
