import path from "node:path";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import type { getDatabase } from "@/db";
import { libraryMoveCandidates, photos } from "@/db/schema";
import { importPathKey } from "@/utils/import-path";
import { writeLibraryPhotoSource } from "./library-source";

type Db = ReturnType<typeof getDatabase>;

export interface LibraryMoveCandidate {
  reason: "ambiguous" | "incomplete";
  targetPath: string;
}

const currentCandidate = and(
  eq(libraryMoveCandidates.photoId, photos.id),
  eq(libraryMoveCandidates.fileRevision, photos.fileRevision),
  eq(libraryMoveCandidates.sourceMissingAt, photos.sourceMissingAt),
  eq(photos.sourceStatus, "missing"),
  isNull(photos.deletedAt),
  sql`NOT EXISTS (SELECT 1 FROM photos AS target_photo WHERE ${
    process.platform === "win32"
      ? sql`lower(target_photo.path)`
      : sql`target_photo.path`
  } = ${libraryMoveCandidates.targetPathKey})`
);

export const libraryMovePending = sql<boolean>`EXISTS (
  SELECT 1 FROM ${libraryMoveCandidates} WHERE ${currentCandidate}
)`;

export function getLibraryMoveCandidates(
  db: Db,
  photoId: number
): LibraryMoveCandidate[] {
  return db
    .select({
      reason: libraryMoveCandidates.reason,
      targetPath: libraryMoveCandidates.targetPath,
    })
    .from(libraryMoveCandidates)
    .innerJoin(photos, currentCandidate)
    .where(and(eq(photos.id, photoId), isNull(photos.deletedAt)))
    .orderBy(libraryMoveCandidates.targetPathKey)
    .all();
}

export function forgetLibraryMoveTarget(db: Db, targetPath: string): boolean {
  const target = eq(
    libraryMoveCandidates.targetPathKey,
    importPathKey(targetPath)
  );
  const affected = db
    .select({ photoId: photos.id })
    .from(libraryMoveCandidates)
    .innerJoin(photos, currentCandidate)
    .where(target)
    .limit(1)
    .get();
  db.delete(libraryMoveCandidates).where(target).run();
  return Boolean(affected);
}

/** Only prune paths from a successful directory observation. */
export function pruneLibraryMoveTargets(
  db: Db,
  scope: string,
  observedPaths: readonly string[]
): boolean {
  const key = importPathKey(scope);
  const prefix = key.endsWith(path.sep) ? key : key + path.sep;
  const known = new Set(observedPaths.map(importPathKey));
  const obsolete = db
    .select({ key: libraryMoveCandidates.targetPathKey })
    .from(libraryMoveCandidates)
    .where(
      sql`(${libraryMoveCandidates.targetPathKey} = ${key} OR substr(${libraryMoveCandidates.targetPathKey}, 1, ${prefix.length}) = ${prefix})`
    )
    .all()
    .filter((row) => !known.has(row.key))
    .map((row) => row.key);
  for (let offset = 0; offset < obsolete.length; offset += 200) {
    db.delete(libraryMoveCandidates)
      .where(
        inArray(
          libraryMoveCandidates.targetPathKey,
          obsolete.slice(offset, offset + 200)
        )
      )
      .run();
  }
  return obsolete.length > 0;
}

type OriginalPhoto = Pick<
  typeof photos.$inferSelect,
  "id" | "path" | "fileRevision"
>;

/** Record verified edges for the current missing period, not just the ID. */
export function rememberLibraryMoveCandidates(
  db: Db,
  photo: OriginalPhoto,
  candidates: readonly LibraryMoveCandidate[],
  checkedAt: number
): boolean {
  return db.transaction(() => {
    const sourceChanged = writeLibraryPhotoSource(
      db,
      photo,
      { status: "missing", errorCode: "ENOENT" },
      checkedAt
    );
    const current = db
      .select({ missingAt: photos.sourceMissingAt })
      .from(photos)
      .where(
        and(
          eq(photos.id, photo.id),
          eq(photos.path, photo.path),
          eq(photos.fileRevision, photo.fileRevision),
          eq(photos.sourceStatus, "missing"),
          isNull(photos.deletedAt)
        )
      )
      .get();
    if (current?.missingAt == null) {
      return sourceChanged;
    }
    let changed = sourceChanged;
    for (const candidate of candidates) {
      const targetPathKey = importPathKey(candidate.targetPath);
      const row = db
        .insert(libraryMoveCandidates)
        .values({
          ...candidate,
          photoId: photo.id,
          fileRevision: photo.fileRevision,
          sourceMissingAt: current.missingAt,
          targetPathKey,
        })
        .onConflictDoUpdate({
          target: [
            libraryMoveCandidates.photoId,
            libraryMoveCandidates.targetPathKey,
          ],
          set: {
            targetPath: candidate.targetPath,
            reason: candidate.reason,
            fileRevision: photo.fileRevision,
            sourceMissingAt: current.missingAt,
          },
          setWhere: sql`${libraryMoveCandidates.reason} IS NOT excluded.reason
            OR ${libraryMoveCandidates.targetPath} IS NOT excluded.target_path
            OR ${libraryMoveCandidates.sourceMissingAt} IS NOT excluded.source_missing_at
            OR ${libraryMoveCandidates.fileRevision} IS NOT excluded.file_revision`,
        })
        .run();
      changed ||= row.changes > 0;
    }
    return changed;
  });
}
