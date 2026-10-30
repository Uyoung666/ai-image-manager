import fs from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { shootingProjectPhotos, shootingProjects } from "@/db/schema";
import { parseProjectExif } from "./project-exif";
import { resolveProjectRelativePath } from "./shooting-project-files";
import { verifyProjectPhoto } from "./shooting-project-preparation";

const ORIGINAL_FORMATS = new Set([".jpg", ".jpeg", ".png", ".webp", ".avif"]);

export function loadProjectMediaPhoto(projectId: string, photoId: string) {
  return getDatabase()
    .select({
      photo: shootingProjectPhotos,
      sourceRoot: shootingProjects.sourceRoot,
    })
    .from(shootingProjectPhotos)
    .innerJoin(
      shootingProjects,
      eq(shootingProjectPhotos.projectId, shootingProjects.id)
    )
    .where(
      and(
        eq(shootingProjectPhotos.projectId, projectId),
        eq(shootingProjectPhotos.id, photoId)
      )
    )
    .get();
}

export function supportsProjectOriginal(filename: string): boolean {
  return ORIGINAL_FORMATS.has(path.extname(filename).toLowerCase());
}

/** Identity is always resolved through the project; callers cannot supply paths. */
export async function resolveShootingProjectOriginal(
  projectId: string,
  photoId: string
) {
  const entry = loadProjectMediaPhoto(projectId, photoId);
  if (!(entry && supportsProjectOriginal(entry.photo.filename))) {
    return null;
  }
  if (
    (await verifyProjectPhoto(entry.photo, entry.sourceRoot)) !== "available"
  ) {
    return null;
  }
  return await resolveProjectRelativePath(
    entry.sourceRoot,
    entry.photo.relativePath
  );
}

export async function readProjectExif(projectId: string, photoId: string) {
  const entry = loadProjectMediaPhoto(projectId, photoId);
  if (!entry) {
    throw new Error("Project photo not found");
  }
  if (entry.photo.exifJson) {
    try {
      return JSON.parse(entry.photo.exifJson) as Record<string, unknown>;
    } catch {
      // Older interrupted metadata writes are safely rebuilt from the source.
    }
  }
  if (
    (await verifyProjectPhoto(entry.photo, entry.sourceRoot)) !== "available"
  ) {
    return null;
  }
  const source = await resolveProjectRelativePath(
    entry.sourceRoot,
    entry.photo.relativePath
  );
  const data = await parseProjectExif(source, entry.photo.dateTaken);
  const stat = await fs.stat(source);
  if (
    stat.size !== entry.photo.fileSize ||
    stat.mtimeMs !== entry.photo.modifiedAt
  ) {
    return null;
  }
  getDatabase()
    .update(shootingProjectPhotos)
    .set({ exifJson: JSON.stringify(data) })
    .where(
      and(
        eq(shootingProjectPhotos.projectId, projectId),
        eq(shootingProjectPhotos.id, photoId)
      )
    )
    .run();
  return data;
}
