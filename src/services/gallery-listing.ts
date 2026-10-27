import { createHash } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos, photoTags } from "@/db/schema";
import type { Photo } from "@/types/photo";
import {
  buildPhotoListFilter,
  type PhotoListFilter,
} from "./photo-list-filter";

export interface GalleryLayoutPhoto {
  fileDate: number | null;
  height: number;
  id: number;
  isFavorite?: boolean;
  width: number;
}
export interface GalleryListInput extends PhotoListFilter {
  cursor?: string | null;
  direction?: "next" | "previous";
  layoutOnly?: boolean;
  limit: number;
  order: "asc" | "desc";
  sort: "name" | "date" | "size";
}
interface Cursor {
  id: number;
  query: string;
  revision: number;
  value: string | number | null;
  version: 1;
}
const columns = {
  id: photos.id,
  path: photos.path,
  filename: photos.filename,
  fileSize: photos.fileSize,
  fileDate: photos.fileDate,
  width: photos.width,
  height: photos.height,
  thumbnailPath: photos.thumbnailPath,
  dominantColors: photos.dominantColors,
  isFavorite: photos.isFavorite,
  isIndexed: photos.isIndexed,
};
const counts = new WeakMap<
  object,
  Map<string, { total: number; totalAll: number }>
>();

export function getGalleryRevision(): number {
  return (
    getDatabase().get<{ revision: number }>(
      sql`SELECT revision FROM gallery_data_revision WHERE id=1`
    )?.revision ?? 0
  );
}
export function getGalleryGeometryRevision(): number {
  return (
    getDatabase().get<{ revision: number }>(
      sql`SELECT revision FROM gallery_data_revision WHERE id=2`
    )?.revision ?? getGalleryRevision()
  );
}

function getListingRevision(input: PhotoListFilter): number {
  const layoutRevision = input.favoriteOnly
    ? getGalleryRevision()
    : getGalleryGeometryRevision();
  // Tag evidence changes membership/order only in a tag-filtered listing.
  const tagRevision =
    input.tagId != null || input.tagIds?.length
      ? (getDatabase().get<{ revision: number }>(
          sql`SELECT revision FROM gallery_data_revision WHERE id=3`
        )?.revision ?? 0)
      : 0;
  return layoutRevision + tagRevision;
}
function fingerprint(input: GalleryListInput): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        folderId: input.folderId ?? null,
        ungroupedOnly: input.ungroupedOnly ?? false,
        tagId: input.tagId ?? null,
        tagIds: input.tagIds?.slice().sort((a, b) => a - b) ?? [],
        tagMode: input.tagMode ?? "or",
        search: input.search ?? "",
        favoriteOnly: input.favoriteOnly ?? false,
        sort: input.sort,
        order: input.order,
      })
    )
    .digest("hex");
}
function readCursor(value: string, query: string, revision: number): Cursor {
  let parsed: Cursor;
  try {
    parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    ) as Cursor;
  } catch {
    throw new Error("Invalid gallery cursor");
  }
  if (
    parsed.version !== 1 ||
    parsed.query !== query ||
    !Number.isSafeInteger(parsed.id) ||
    !(
      parsed.value === null ||
      typeof parsed.value === "string" ||
      typeof parsed.value === "number"
    )
  ) {
    throw new Error("Invalid gallery cursor");
  }
  if (parsed.revision !== revision) {
    throw new Error("GALLERY_CURSOR_EXPIRED");
  }
  return parsed;
}
function boundary(
  column:
    | typeof photos.fileDate
    | typeof photos.filename
    | typeof photos.fileSize,
  value: Cursor,
  greater: boolean
): SQL {
  const compare = greater
    ? sql`(${column}, ${photos.id}) > (${value.value}, ${value.id})`
    : sql`(${column}, ${photos.id}) < (${value.value}, ${value.id})`;
  const idCompare = greater
    ? sql`${photos.id} > ${value.id}`
    : sql`${photos.id} < ${value.id}`;
  if (value.value === null) {
    return greater
      ? sql`(${column} IS NOT NULL OR (${column} IS NULL AND ${idCompare}))`
      : sql`(${column} IS NULL AND ${idCompare})`;
  }
  return greater ? compare : sql`(${column} IS NULL OR ${compare})`;
}
function sortColumn(sort: GalleryListInput["sort"]) {
  if (sort === "name") {
    return photos.filename;
  }
  return sort === "size" ? photos.fileSize : photos.fileDate;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: nullable SQLite keyset partitions and filtered counts are evaluated in one consistent transaction turn.
export function listGalleryPhotos(input: GalleryListInput) {
  const started = performance.now();
  const db = getDatabase();
  const revision = getListingRevision(input);
  const query = fingerprint(input);
  const cursor = input.cursor
    ? readCursor(input.cursor, query, revision)
    : null;
  const { conditions, ungroupedCondition, selectedDescendantIds } =
    buildPhotoListFilter(input);
  const column = sortColumn(input.sort);
  const forward = input.direction !== "previous";
  const ascending = (input.order === "asc") === forward;
  const ordering = ascending ? asc : desc;
  const nullPartitionNext =
    cursor && (ascending ? cursor.value === null : cursor.value !== null);
  let pageBoundary: SQL | undefined;
  if (cursor) {
    pageBoundary = boundary(column, cursor, ascending);
    if (nullPartitionNext) {
      pageBoundary = ascending
        ? sql`(${column} IS NULL AND ${photos.id} > ${cursor.id})`
        : sql`(${column}, ${photos.id}) < (${cursor.value}, ${cursor.id})`;
    }
  }
  const pageConditions = pageBoundary
    ? [...conditions, pageBoundary]
    : conditions;
  // Sorting value is kept only long enough to construct cursors, not in layout caches.
  const rows = db
    .select(
      input.layoutOnly
        ? {
            id: photos.id,
            width: photos.width,
            height: photos.height,
            fileDate: photos.fileDate,
            sortValue: column,
            isFavorite: photos.isFavorite,
          }
        : { ...columns, sortValue: column }
    )
    .from(photos)
    .where(and(...pageConditions))
    .orderBy(ordering(column), ordering(photos.id))
    .limit(input.limit + 1)
    .all();
  if (nullPartitionNext && rows.length < input.limit + 1) {
    rows.push(
      ...db
        .select(
          input.layoutOnly
            ? {
                id: photos.id,
                width: photos.width,
                height: photos.height,
                fileDate: photos.fileDate,
                sortValue: column,
                isFavorite: photos.isFavorite,
              }
            : { ...columns, sortValue: column }
        )
        .from(photos)
        .where(
          and(
            ...conditions,
            ascending ? sql`${column} IS NOT NULL` : isNull(column)
          )
        )
        .orderBy(ordering(column), ordering(photos.id))
        .limit(input.limit + 1 - rows.length)
        .all()
    );
  }
  const hasExtra = rows.length > input.limit;
  if (hasExtra) {
    rows.pop();
  }
  if (!forward) {
    rows.reverse();
  }
  let cache = counts.get(db);
  if (!cache) {
    cache = new Map();
    counts.set(db, cache);
  }
  const countKey = `${revision}:${query}`;
  let total = cache.get(countKey);
  if (!total) {
    const count = (filters: SQL[]) =>
      db
        .select({ total: sql<number>`count(*)` })
        .from(photos)
        .where(and(...filters))
        .get()?.total ?? 0;
    total = {
      total: count(conditions),
      totalAll: ungroupedCondition
        ? count(
            conditions.filter((condition) => condition !== ungroupedCondition)
          )
        : 0,
    };
    if (!ungroupedCondition) {
      total.totalAll = total.total;
    }
    if (cache.size >= 50) {
      cache.delete(cache.keys().next().value as string);
    }
    cache.set(countKey, total);
  }
  const encode = (row: (typeof rows)[number] | undefined) =>
    row
      ? Buffer.from(
          JSON.stringify({
            version: 1,
            query,
            revision,
            id: row.id,
            value: row.sortValue,
          } satisfies Cursor)
        ).toString("base64url")
      : null;
  const ids = rows.map((row) => row.id);
  const trusted =
    selectedDescendantIds.length > 0 && !input.layoutOnly
      ? new Set(
          db
            .select({ id: photoTags.photoId })
            .from(photoTags)
            .where(
              and(
                inArray(photoTags.photoId, ids),
                inArray(photoTags.tagId, selectedDescendantIds),
                or(
                  eq(photoTags.origin, "manual"),
                  eq(photoTags.userConfirmed, true)
                )
              )
            )
            .all()
            .map((row) => row.id)
        )
      : null;
  const items = rows.map(({ sortValue: _value, ...row }) => ({
    ...row,
    ...(trusted
      ? {
          match: {
            kind: "tagFilter" as const,
            origin: trusted.has(row.id)
              ? ("manual" as const)
              : ("auto" as const),
          },
        }
      : {}),
  }));
  return {
    items,
    ...total,
    revision,
    geometryRevision: revision,
    nextCursor: !forward || hasExtra ? encode(rows.at(-1)) : null,
    previousCursor: (forward ? Boolean(cursor) : hasExtra)
      ? encode(rows[0])
      : null,
    queryMs: performance.now() - started,
  };
}

export function getGalleryPhotosByIds(ids: number[]): Photo[] {
  if (ids.length === 0) {
    return [];
  }
  return getDatabase()
    .select(columns)
    .from(photos)
    .where(and(inArray(photos.id, ids), isNull(photos.deletedAt)))
    .all()
    .map((photo) => ({
      ...photo,
      fileSize: photo.fileSize ?? 0,
      width: photo.width ?? 0,
      height: photo.height ?? 0,
    })) as Photo[];
}

/** Restoration fetches geometry only. Full photo records remain windowed. */
export function getGalleryLayoutPrefix(
  input: GalleryListInput,
  targetId: number,
  fallbackIds: number[] = [],
  fallbackIndex?: number
) {
  const db = getDatabase();
  const { conditions } = buildPhotoListFilter(input);
  const column = sortColumn(input.sort);
  const findTarget = (id: number) =>
    db
      .select({ id: photos.id, value: column })
      .from(photos)
      .where(and(...conditions, eq(photos.id, id)))
      .get();
  let target = findTarget(targetId);
  for (const id of fallbackIds) {
    if (target) {
      break;
    }
    target = findTarget(id);
  }
  if (!target && fallbackIndex !== undefined) {
    const ordering = input.order === "desc" ? desc : asc;
    target = db
      .select({ id: photos.id, value: column })
      .from(photos)
      .where(and(...conditions))
      .orderBy(ordering(column), ordering(photos.id))
      .limit(1)
      .offset(Math.max(0, fallbackIndex - 1))
      .get();
  }
  if (!target) {
    return null;
  }
  const reverse = input.order === "desc";
  const cursor: Cursor = {
    version: 1,
    id: target.id,
    value: target.value,
    query: "",
    revision: 0,
  };
  const ordering = reverse ? desc : asc;
  const rows = db
    .select({
      id: photos.id,
      width: photos.width,
      height: photos.height,
      fileDate: photos.fileDate,
      isFavorite: photos.isFavorite,
    })
    .from(photos)
    .where(
      and(
        ...conditions,
        or(boundary(column, cursor, reverse), eq(photos.id, target.id))
      )
    )
    .orderBy(ordering(column), ordering(photos.id))
    .all();
  const revision = getListingRevision(input);
  const tail = db
    .select({
      id: photos.id,
      width: photos.width,
      height: photos.height,
      fileDate: photos.fileDate,
      isFavorite: photos.isFavorite,
      value: column,
    })
    .from(photos)
    .where(and(...conditions, boundary(column, cursor, !reverse)))
    .orderBy(ordering(column), ordering(photos.id))
    .limit(100)
    .all();
  const last = tail.at(-1);
  const nextCursor = Buffer.from(
    JSON.stringify({
      ...cursor,
      ...(last ? { id: last.id, value: last.value } : {}),
      revision,
      query: fingerprint(input),
    })
  ).toString("base64url");
  return {
    items: rows,
    tailItems: tail.map(({ value: _value, ...row }) => row),
    anchorId: target.id,
    revision,
    nextCursor,
  };
}
