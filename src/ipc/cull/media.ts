import { os } from "@orpc/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import { cullSessionPhotos, cullSessions } from "@/db/schema";
import {
  getHttpServerAuthToken,
  getHttpServerPort,
} from "@/services/http-server";
import { readPhotoExif } from "@/services/photo-exif";
import {
  loadProjectMediaPhoto,
  readProjectExif,
  supportsProjectOriginal,
} from "@/services/shooting-project-media";

const MediaSchema = z.object({
  sessionId: z.number().int().positive(),
  sessionPhotoId: z.number().int().positive(),
});

function member(input: z.infer<typeof MediaSchema>) {
  const row = getDatabase()
    .select({
      projectId: cullSessions.projectId,
      projectPhotoId: cullSessionPhotos.projectPhotoId,
      photoId: cullSessionPhotos.photoId,
    })
    .from(cullSessionPhotos)
    .innerJoin(cullSessions, eq(cullSessionPhotos.sessionId, cullSessions.id))
    .where(
      and(
        eq(cullSessions.id, input.sessionId),
        eq(cullSessionPhotos.id, input.sessionPhotoId)
      )
    )
    .get();
  if (!row) {
    throw new Error("Photo is not in this session");
  }
  return row;
}

export const getPhotoExif = os.input(MediaSchema).handler(async ({ input }) => {
  const row = member(input);
  if (row.projectId && row.projectPhotoId) {
    return await readProjectExif(row.projectId, row.projectPhotoId);
  }
  if (row.photoId) {
    return readPhotoExif(row.photoId);
  }
  return null;
});

export const getPhotoMedia = os.input(MediaSchema).handler(({ input }) => {
  const row = member(input);
  if (!(row.projectId && row.projectPhotoId)) {
    return null;
  }
  const entry = loadProjectMediaPhoto(row.projectId, row.projectPhotoId);
  if (!entry) {
    return null;
  }
  const port = getHttpServerPort();
  const query = new URLSearchParams({
    projectId: row.projectId,
    photoId: row.projectPhotoId,
    v: String(entry.photo.modifiedAt),
    token: getHttpServerAuthToken(),
  });
  const originalAvailable =
    entry.photo.sourceStatus === "available" &&
    supportsProjectOriginal(entry.photo.filename);
  return {
    previewUrl: port
      ? `http://127.0.0.1:${port}/shooting-project-preview?${query}`
      : "",
    originalUrl:
      port && originalAvailable
        ? `http://127.0.0.1:${port}/shooting-project-original?${query}`
        : null,
    previewWidth: entry.photo.previewWidth,
    previewHeight: entry.photo.previewHeight,
    originalAvailable,
  };
});
