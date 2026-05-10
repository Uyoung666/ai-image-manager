import fs from "node:fs";
import path from "node:path";
import { os } from "@orpc/server";
import { desc, eq, gte, inArray, like, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags, tags } from "@/db/schema";
import {
  searchByImage as aiSearchByImage,
  searchByText as aiSearchByText,
  embedAllPhotos,
  getEmbeddingProgress,
  stopEmbedding,
} from "@/services/ai-embedder";
import { scanFolder as scanFolderService } from "@/services/indexer";

const FolderSchema = z.object({ path: z.string().min(1) });
const SearchSchema = z.object({
  query: z.string().min(1),
  limit: z.number().optional().default(50),
});
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

export const deleteFolder = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const folder = db
    .select({ path: folders.path })
    .from(folders)
    .where(eq(folders.id, input.id))
    .get();
  if (folder) {
    db.delete(photos).where(eq(photos.folderId, input.id)).run();
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
      .map((r) => ({
        ...photoMap.get(r.photoId),
        similarity: r.similarity,
      }))
      .filter((p) => p.id);

    return { results: merged, query: input.query };
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
      .map((r) => ({
        ...photoMap.get(r.photoId),
        similarity: r.similarity,
      }))
      .filter((p) => p.id);

    return { results: merged };
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
          .limit(limit)
          .all();
        const photoMap = new Map(photoList.map((p) => [p.id, p]));
        const merged = aiResults
          .slice(0, limit)
          .map((r) => ({
            ...photoMap.get(r.photoId),
            similarity: r.similarity,
          }))
          .filter((p) => p.id);
        return { results: merged, query: query.trim(), total: merged.length };
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

      const filtered = aiResults
        .filter((r) => validIds.has(r.photoId))
        .slice(0, limit);

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
        .map((r) => ({ ...photoMap.get(r.photoId), similarity: r.similarity }))
        .filter((p) => p.id);

      return { results: merged, query: query.trim(), total: merged.length };
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

export const deletePhoto = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const photo = db
    .select({ path: photos.path })
    .from(photos)
    .where(eq(photos.id, input.id))
    .get();
  if (photo) {
    db.delete(exifData).where(eq(exifData.photoId, input.id)).run();
    db.delete(photos).where(eq(photos.id, input.id)).run();
  }
  return { success: true };
});

export const deletePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(({ input }) => {
    const db = getDatabase();
    for (const id of input.ids) {
      db.delete(exifData).where(eq(exifData.photoId, id)).run();
      db.delete(photos).where(eq(photos.id, id)).run();
    }
    return { deleted: input.ids.length };
  });

function hammingDistance(a: string, b: string): number {
  let dist = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const xor = Number.parseInt(a[i], 16) ^ Number.parseInt(b[i], 16);
    // Count set bits in the xor'd nibble
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

export const findDuplicates = os
  .input(z.object({ threshold: z.number().optional().default(8) }))
  .handler(({ input }) => {
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

    const duplicates: Array<{
      photoA: { id: number; path: string; filename: string };
      photoB: { id: number; path: string; filename: string };
      distance: number;
    }> = [];

    for (let i = 0; i < allPhotos.length; i++) {
      for (let j = i + 1; j < allPhotos.length; j++) {
        if (allPhotos[i].phash && allPhotos[j].phash) {
          const dist = hammingDistance(
            allPhotos[i].phash!,
            allPhotos[j].phash!
          );
          if (dist <= input.threshold) {
            duplicates.push({
              photoA: {
                id: allPhotos[i].id,
                path: allPhotos[i].path,
                filename: allPhotos[i].filename,
              },
              photoB: {
                id: allPhotos[j].id,
                path: allPhotos[j].path,
                filename: allPhotos[j].filename,
              },
              distance: dist,
            });
          }
        }
      }
    }

    return { duplicates: duplicates.slice(0, 200) };
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
      outputDir: z.string().min(1),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const sharp = (await import("sharp")).default;
    let converted = 0;

    if (!fs.existsSync(input.outputDir)) {
      fs.mkdirSync(input.outputDir, { recursive: true });
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

        const outPath = path.join(input.outputDir, outName);
        const buffer = await pipeline
          .toFormat(input.format, { quality: input.quality })
          .toBuffer();
        fs.writeFileSync(outPath, buffer);
        converted++;
      } catch (e) {
        console.error(`[Convert] Error converting photo ${id}:`, e);
      }
    }

    return { converted, outputDir: input.outputDir };
  });

export const getAiProgress = os.handler(() => {
  return getEmbeddingProgress();
});

// Tags
export const getTags = os.handler(() => {
  const db = getDatabase();
  return db.select().from(tags).orderBy(tags.name).all();
});

export const getPhotoTags = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  return db
    .select({ id: tags.id, name: tags.name, color: tags.color })
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
      .values({ photoId: input.photoId, tagId: input.tagId })
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

export const deleteTag = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  db.delete(photoTags).where(eq(photoTags.tagId, input.id)).run();
  db.delete(tags).where(eq(tags.id, input.id)).run();
  return { ok: true };
});
