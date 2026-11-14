import fs from "node:fs/promises";
import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";

export const aiSourceReady = and(
  isNull(photos.deletedAt),
  or(
    eq(photos.sourceStatus, "available"),
    eq(photos.sourceStatus, "unverified")
  ),
  eq(photos.metadataRevision, photos.contentRevision)
);

export const photoWorkVersionColumns = {
  id: photos.id,
  path: photos.path,
  fileRevision: photos.fileRevision,
  contentRevision: photos.contentRevision,
  sourceSize: photos.sourceSize,
  sourceMtimeMs: photos.sourceMtimeMs,
  sourceCtimeMs: photos.sourceCtimeMs,
};

export interface PhotoWorkVersion {
  contentRevision: number;
  fileRevision: number;
  id: number;
  path: string;
  sourceCtimeMs?: number | null;
  sourceMtimeMs?: number | null;
  sourceSize?: number | null;
}

export async function capturePhotoWorkFile(
  version: PhotoWorkVersion
): Promise<void> {
  if (version.sourceSize != null) {
    return;
  }
  const stat = await fs.stat(version.path).catch(() => null);
  version.sourceSize = stat?.isFile() ? stat.size : -1;
  version.sourceMtimeMs = stat?.mtimeMs ?? null;
  version.sourceCtimeMs = stat?.ctimeMs ?? null;
}

export async function photoWorkFileUnchanged(
  version: PhotoWorkVersion
): Promise<boolean> {
  if (version.sourceSize == null) {
    return true;
  }
  const stat = await fs.stat(version.path).catch(() => null);
  return Boolean(
    stat?.isFile() &&
      stat.size === version.sourceSize &&
      stat.mtimeMs === version.sourceMtimeMs &&
      stat.ctimeMs === version.sourceCtimeMs
  );
}

export function currentLanceRows<T extends Record<string, unknown>>(
  rows: T[],
  kind: "embedding" | "color"
): T[] {
  if (!rows.length) {
    return rows;
  }
  const ids = [...new Set(rows.map((row) => Number(row.photo_id)))];
  const completion =
    kind === "embedding" ? photos.embeddingRevision : photos.colorRevision;
  const db = getDatabase();
  const current = new Map<number, number>();
  for (let offset = 0; offset < ids.length; offset += 500) {
    for (const row of db
      .select({ id: photos.id, version: photos.contentRevision })
      .from(photos)
      .where(
        and(
          inArray(photos.id, ids.slice(offset, offset + 500)),
          isNull(photos.deletedAt),
          eq(photos.contentRevision, completion)
        )
      )
      .all()) {
      current.set(row.id, row.version);
    }
  }
  return rows.filter(
    (row) =>
      current.get(Number(row.photo_id)) === Number(row.content_revision ?? 0)
  );
}

export function photoWorkVersionMatch(version: PhotoWorkVersion) {
  return and(
    aiSourceReady,
    eq(photos.id, version.id),
    eq(photos.path, version.path),
    eq(photos.fileRevision, version.fileRevision),
    eq(photos.contentRevision, version.contentRevision)
  );
}

/**
 * Select valid Lance records before top-k. Legacy revision zero is the common
 * case, so enumerate only changed/deleted rows rather than the entire library.
 */
export function lancePhotoRevisionFilter(
  kind: "embedding" | "color",
  allowedIds: readonly number[]
): string;
export function lancePhotoRevisionFilter(
  kind: "embedding" | "color",
  allowedIds?: readonly number[]
): string | undefined;
export function lancePhotoRevisionFilter(
  kind: "embedding" | "color",
  allowedIds?: readonly number[]
): string | undefined {
  if (allowedIds?.length === 0) {
    return "false";
  }
  const db = getDatabase();
  const completed =
    kind === "embedding" ? photos.embeddingRevision : photos.colorRevision;
  const rows = db
    .select({
      id: photos.id,
      contentRevision: photos.contentRevision,
      completed,
      deletedAt: photos.deletedAt,
    })
    .from(photos)
    .where(
      or(
        sql`${photos.contentRevision} > 0`,
        sql`${photos.deletedAt} IS NOT NULL`
      )
    )
    .all();
  const allowed = allowedIds ? new Set(allowedIds) : undefined;
  const ids = (values: readonly number[]) =>
    values.filter((id) => Number.isSafeInteger(id) && id > 0).join(",");
  const scope = allowedIds
    ? `photo_id IN (${ids(allowedIds) || "0"})`
    : undefined;
  const affected = rows.filter((row) => !allowed || allowed.has(row.id));
  if (!affected.length) {
    return scope;
  }
  const versions = new Map<number, number[]>();
  for (const row of affected) {
    if (row.deletedAt === null && row.completed === row.contentRevision) {
      const bucket = versions.get(row.contentRevision) ?? [];
      bucket.push(row.id);
      versions.set(row.contentRevision, bucket);
    }
  }
  const clauses = [
    `(content_revision = 0 AND photo_id NOT IN (${ids(affected.map((row) => row.id))}))`,
    ...[...versions].map(
      ([rev, bucket]) =>
        `(content_revision = ${rev} AND photo_id IN (${ids(bucket)}))`
    ),
  ];
  return scope
    ? `${scope} AND (${clauses.join(" OR ")})`
    : clauses.join(" OR ");
}
