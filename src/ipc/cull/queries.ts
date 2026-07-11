import { and, asc, eq, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { cullSessionPhotos, photos } from "@/db/schema";

export function selectPhotoFields() {
  return {
    id: photos.id,
    filename: photos.filename,
    path: photos.path,
    width: photos.width,
    height: photos.height,
    fileSize: photos.fileSize,
    format: photos.format,
    thumbnailPath: photos.thumbnailPath,
    duelPreviewPath: photos.duelPreviewPath,
    fileDate: photos.fileDate,
    isFavorite: photos.isFavorite,
    isIndexed: photos.isIndexed,
  };
}

export function loadPendingWithMetadata(sessionId: number) {
  const db = getDatabase();
  return db
    .select({
      id: cullSessionPhotos.id,
      photoId: cullSessionPhotos.photoId,
      rating: cullSessionPhotos.rating,
      comparisons: cullSessionPhotos.comparisons,
      wins: cullSessionPhotos.wins,
      losses: cullSessionPhotos.losses,
      status: cullSessionPhotos.status,
      phash: photos.phash,
      fileDate: photos.fileDate,
      filename: photos.filename,
      path: photos.path,
      width: photos.width,
      height: photos.height,
      fileSize: photos.fileSize,
      format: photos.format,
      thumbnailPath: photos.thumbnailPath,
      duelPreviewPath: photos.duelPreviewPath,
      isFavorite: photos.isFavorite,
      isIndexed: photos.isIndexed,
    })
    .from(cullSessionPhotos)
    .innerJoin(photos, eq(cullSessionPhotos.photoId, photos.id))
    .where(
      and(
        eq(cullSessionPhotos.sessionId, sessionId),
        eq(cullSessionPhotos.status, "pending"),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(asc(photos.fileDate))
    .all();
}

export type PendingRow = ReturnType<typeof loadPendingWithMetadata>[number];

export function buildPairItem(row: PendingRow) {
  return {
    sessionPhotoId: row.id,
    photo: {
      id: row.photoId,
      filename: row.filename,
      path: row.path,
      width: row.width,
      height: row.height,
      fileSize: row.fileSize,
      format: row.format,
      thumbnailPath: row.thumbnailPath,
      duelPreviewPath: row.duelPreviewPath,
      fileDate: row.fileDate,
      isFavorite: row.isFavorite,
      isIndexed: row.isIndexed,
    },
    rating: row.rating,
    comparisons: row.comparisons,
    wins: row.wins,
    losses: row.losses,
  };
}
