import { and, asc, eq, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { cullSessionPhotos, photos } from "@/db/schema";
import {
  getProjectCullSession,
  loadProjectCullRows,
} from "@/services/project-cull";
import type { CullPhotoSource } from "@/types/cull";

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

function loadLibraryPendingWithMetadata(sessionId: number) {
  const db = getDatabase();
  return db
    .select({
      id: cullSessionPhotos.id,
      photoId: photos.id,
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

export type PendingRow = ReturnType<
  typeof loadLibraryPendingWithMetadata
>[number] & {
  projectId?: string;
  projectPhotoId?: string;
  previewWidth?: number | null;
  previewHeight?: number | null;
  previewStatus?: "pending" | "ready" | "failed";
};

export function loadProjectWithMetadata(sessionId: number): PendingRow[] {
  const session = getProjectCullSession(sessionId);
  return loadProjectCullRows(sessionId).map((row) =>
    projectRowWithMetadata(row, session?.projectId ?? undefined)
  );
}

export function projectRowWithMetadata(
  row: ReturnType<typeof loadProjectCullRows>[number],
  projectId?: string
): PendingRow {
  return {
    ...row,
    status: row.status === "undecided" ? "pending" : row.status,
    photoId: row.id,
    projectId,
    path: row.filename,
    width: row.width ?? 0,
    height: row.height ?? 0,
    fileDate: row.fileDate ?? row.modifiedAt,
    thumbnailPath: null,
    duelPreviewPath: null,
    isFavorite: false,
    isIndexed: false,
  };
}

export function loadPendingWithMetadata(sessionId: number): PendingRow[] {
  const session = getProjectCullSession(sessionId);
  if (!session?.projectId) {
    return loadLibraryPendingWithMetadata(sessionId);
  }
  const rows = loadProjectWithMetadata(sessionId);
  return session.mode === "duel"
    ? rows
    : rows.filter((row) => row.status === "pending");
}

export function buildPairItem(row: PendingRow) {
  return {
    sessionPhotoId: row.id,
    photo: {
      id: row.photoId,
      source: (row.projectId && row.projectPhotoId
        ? {
            kind: "project",
            projectId: row.projectId,
            photoId: row.projectPhotoId,
          }
        : { kind: "library", photoId: row.photoId }) as CullPhotoSource,
      projectPhotoId: row.projectPhotoId,
      previewWidth: row.previewWidth,
      previewHeight: row.previewHeight,
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
