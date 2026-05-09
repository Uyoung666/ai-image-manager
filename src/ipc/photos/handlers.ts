import { os } from "@orpc/server";
import { z } from "zod";
import { getDatabase } from "@/db";
import { photos, exifData, folders } from "@/db/schema";
import { eq, desc, and, like, sql } from "drizzle-orm";
import { scanFolder, stopScanning, startWatching, isIndexing } from "@/services/indexer";
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
export const scanFolder = os.handler(async ({ input }) => {
  const { path } = input as { path: string };
  const result = await scanFolder(path);
  return result;
}).input(FolderSchema);

export const getFolders = os.handler(async () => {
  const db = getDatabase();
  return db.select().from(folders).orderBy(desc(folders.lastScannedAt)).all();
});

export const deleteFolder = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { id } = input as { id: number };
  const folder = db.select({ path: folders.path }).from(folders).where(eq(folders.id, id)).get();
  if (folder) {
    db.delete(photos).where(eq(photos.folderId, id)).run();
    db.delete(folders).where(eq(folders.id, id)).run();
  }
  return { success: true };
}).input(IdSchema);

// Photo listing
export const listPhotos = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { folderId, search, sort, order, offset, limit } = input as {
    folderId?: number; search?: string; sort: string; order: string; offset: number; limit: number;
  };

  let query = db.select().from(photos).$dynamic();

  if (folderId) {
    query = query.where(eq(photos.folderId, folderId));
  }
  if (search) {
    query = query.where(like(photos.filename, `%${search}%`));
  }

  const sortCol = sort === "name" ? photos.filename : sort === "size" ? photos.fileSize : photos.fileDate;
  query = query.orderBy(order === "asc" ? sortCol : desc(sortCol));

  const total = db.select({ count: sql<number>`count(*)` }).from(photos).get()?.count || 0;
  const items = query.limit(limit).offset(offset).all();

  return { items, total, offset, limit };
}).input(ListSchema);

// Photo detail
export const getPhotoDetail = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { id } = input as { id: number };
  const photo = db.select().from(photos).where(eq(photos.id, id)).get();
  return photo || null;
}).input(IdSchema);

export const getPhotoExif = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { id } = input as { id: number };
  return db.select().from(exifData).where(eq(exifData.photoId, id)).get() || null;
}).input(IdSchema);

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
export const searchByText = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { query, limit } = input as { query: string; limit: number };
  const results = await aiSearchByText(query, limit);

  const photoIds = results.map(r => r.photoId);
  if (photoIds.length === 0) return { results: [], query };

  const photoList = db.select().from(photos)
    .where(sql`${photos.id} IN (${photoIds.join(",")})`)
    .all();

  const photoMap = new Map(photoList.map(p => [p.id, p]));
  const merged = results.map(r => ({
    ...photoMap.get(r.photoId),
    similarity: r.similarity,
  })).filter(p => p.id);

  return { results: merged, query };
}).input(SearchSchema);

export const searchByImage = os.handler(async ({ input }) => {
  const db = getDatabase();
  const { imagePath, limit } = input as { imagePath: string; limit: number };
  const results = await aiSearchByImage(imagePath, limit);

  const photoIds = results.map(r => r.photoId);
  if (photoIds.length === 0) return { results: [] };

  const photoList = db.select().from(photos)
    .where(sql`${photos.id} IN (${photoIds.join(",")})`)
    .all();

  const photoMap = new Map(photoList.map(p => [p.id, p]));
  const merged = results.map(r => ({
    ...photoMap.get(r.photoId),
    similarity: r.similarity,
  })).filter(p => p.id);

  return { results: merged };
}).input(ImageSearchSchema);

export const startAiIndexing = os.handler(async () => {
  const count = await embedAllPhotos();
  return { embedded: count };
});

export const getAiProgress = os.handler(async () => {
  return getEmbeddingProgress();
});
