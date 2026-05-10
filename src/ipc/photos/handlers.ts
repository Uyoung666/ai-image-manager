import { os } from "@orpc/server";
import { z } from "zod";
import { getDatabase } from "@/db";
import { photos, exifData, folders } from "@/db/schema";
import { eq, desc, and, like, sql, inArray } from "drizzle-orm";
import { scanFolder as scanFolderService, stopScanning, startWatching, isIndexing } from "@/services/indexer";
import { getThumbnailBuffer } from "@/services/thumbnailer";
import {
  embedAllPhotos, searchByText as aiSearchByText,
  searchByImage as aiSearchByImage, stopEmbedding, getEmbeddingProgress,
} from "@/services/ai-embedder";

const FolderSchema = z.object({ path: z.string().min(1) });
const SearchSchema = z.object({ query: z.string().min(1), limit: z.number().optional().default(50) });
const ImageSearchSchema = z.object({ imagePath: z.string().min(1), limit: z.number().optional().default(20) });
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
export const scanFolder = os
  .input(FolderSchema)
  .handler(async ({ input }) => {
    const result = await scanFolderService(input.path);
    return result;
  });

export const getFolders = os.handler(async () => {
  const db = getDatabase();
  return db.select().from(folders).orderBy(desc(folders.lastScannedAt)).all();
});

export const deleteFolder = os
  .input(IdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const folder = db.select({ path: folders.path }).from(folders).where(eq(folders.id, input.id)).get();
    if (folder) {
      db.delete(photos).where(eq(photos.folderId, input.id)).run();
      db.delete(folders).where(eq(folders.id, input.id)).run();
    }
    return { success: true };
  });

// Photo listing
export const listPhotos = os
  .input(ListSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const { folderId, search, sort, order, offset, limit } = input;

    let query = db.select().from(photos).$dynamic();

    if (folderId) {
      query = query.where(eq(photos.folderId, folderId));
    }
    if (search) {
      query = query.where(like(photos.filename, `%${search}%`));
    }

    const sortCol = sort === "name" ? photos.filename : sort === "size" ? photos.fileSize : photos.fileDate;
    query = query.orderBy(order === "asc" ? sortCol : desc(sortCol));

    // Build filtered count query with same conditions
    let countQuery = db.select({ count: sql<number>`count(*)` }).from(photos).$dynamic();
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
export const getPhotoDetail = os
  .input(IdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const photo = db.select().from(photos).where(eq(photos.id, input.id)).get();
    return photo || null;
  });

export const getPhotoExif = os
  .input(IdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    return db.select().from(exifData).where(eq(exifData.photoId, input.id)).get() || null;
  });

// Statistics for dashboard
export const getStats = os.handler(async () => {
  const db = getDatabase();

  const totalPhotos = db.select({ count: sql<number>`count(*)` }).from(photos).get()?.count || 0;
  const aiProcessed = db.select({ count: sql<number>`count(*)` }).from(photos).where(eq(photos.isAiProcessed, true)).get()?.count || 0;

  const cameraStats = db.select({
    model: exifData.cameraModel,
    count: sql<number>`count(*)`,
  }).from(exifData)
    .groupBy(exifData.cameraModel)
    .orderBy(desc(sql`count(*)`))
    .limit(5).all();

  const focalStats = db.select({
    focalLength: exifData.focalLength,
    count: sql<number>`count(*)`,
  }).from(exifData)
    .where(sql`${exifData.focalLength} IS NOT NULL`)
    .groupBy(exifData.focalLength)
    .orderBy(desc(sql`count(*)`))
    .limit(10).all();

  const dateRange = db.select({
    earliest: sql<number>`min(${exifData.dateTaken})`,
    latest: sql<number>`max(${exifData.dateTaken})`,
  }).from(exifData).get();

  const isoStats = db.select({
    avgIso: sql<number>`avg(${exifData.iso})`,
  }).from(exifData)
    .where(sql`${exifData.iso} IS NOT NULL`).get();

  return {
    totalPhotos,
    aiProcessed,
    cameraStats: cameraStats.filter(c => c.model),
    focalStats: focalStats.filter(f => f.focalLength),
    dateRange,
    avgIso: isoStats?.avgIso || 0,
  };
});

// AI Search
export const searchByText = os
  .input(SearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results = await aiSearchByText(input.query, input.limit);

    const photoIds = results.map(r => r.photoId);
    if (photoIds.length === 0) return { results: [], query: input.query };

    const photoList = db.select().from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    const photoMap = new Map(photoList.map(p => [p.id, p]));
    const merged = results.map(r => ({
      ...photoMap.get(r.photoId),
      similarity: r.similarity,
    })).filter(p => p.id);

    return { results: merged, query: input.query };
  });

export const searchByImage = os
  .input(ImageSearchSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const results = await aiSearchByImage(input.imagePath, input.limit);

    const photoIds = results.map(r => r.photoId);
    if (photoIds.length === 0) return { results: [] };

    const photoList = db.select().from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    const photoMap = new Map(photoList.map(p => [p.id, p]));
    const merged = results.map(r => ({
      ...photoMap.get(r.photoId),
      similarity: r.similarity,
    })).filter(p => p.id);

    return { results: merged };
  });

export const startAiIndexing = os.handler(async () => {
  // Fire-and-forget: launch embedding in background, poll progress via getAiProgress
  embedAllPhotos().then(count => {
    console.log(`[AI] Embedding complete: ${count} photos processed`);
  }).catch(err => {
    console.error("[AI] Embedding error:", err);
  });
  return { started: true };
});

export const stopAiIndexing = os.handler(async () => {
  stopEmbedding();
  return { stopped: true };
});

export const deletePhoto = os
  .input(IdSchema)
  .handler(async ({ input }) => {
    const db = getDatabase();
    const photo = db.select({ path: photos.path }).from(photos).where(eq(photos.id, input.id)).get();
    if (photo) {
      db.delete(exifData).where(eq(exifData.photoId, input.id)).run();
      db.delete(photos).where(eq(photos.id, input.id)).run();
    }
    return { success: true };
  });

export const deletePhotos = os
  .input(z.object({ ids: z.array(z.number()) }))
  .handler(async ({ input }) => {
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
    const xor = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    // Count set bits in the xor'd nibble
    dist += (xor & 1) + ((xor >> 1) & 1) + ((xor >> 2) & 1) + ((xor >> 3) & 1);
  }
  return dist;
}

export const findDuplicates = os
  .input(z.object({ threshold: z.number().optional().default(8) }))
  .handler(async ({ input }) => {
    const db = getDatabase();
    const allPhotos = db.select({
      id: photos.id,
      path: photos.path,
      filename: photos.filename,
      phash: photos.phash,
    }).from(photos)
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
          const dist = hammingDistance(allPhotos[i].phash!, allPhotos[j].phash!);
          if (dist <= input.threshold) {
            duplicates.push({
              photoA: { id: allPhotos[i].id, path: allPhotos[i].path, filename: allPhotos[i].filename },
              photoB: { id: allPhotos[j].id, path: allPhotos[j].path, filename: allPhotos[j].filename },
              distance: dist,
            });
          }
        }
      }
    }

    return { duplicates: duplicates.slice(0, 200) };
  });

export const getAiProgress = os.handler(async () => {
  return getEmbeddingProgress();
});
