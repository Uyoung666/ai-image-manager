import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, photos, photoTags, tags } from "@/db/schema";
import { buildPhotoSearchScope } from "@/services/search-scope";
import type {
  SearchStarter,
  SearchStarterInput,
  SearchStarterResponse,
} from "@/types/search-starters";
import { localSearchDay } from "./search-starter-candidates";
import { getSearchStarterContext } from "./search-starter-context";

const cache = new Map<string, SearchStarterResponse>();
const MAX_GROUPS = 8;
const UNSAFE_NAME = /["“”\r\n]/;
const MONTH_KEY = /^\d{4}-\d{2}$/;

function monthEntries(
  db: ReturnType<typeof getDatabase>,
  input: SearchStarterInput
): SearchStarter[] {
  const scope = buildPhotoSearchScope(db, input.filters);
  const month = sql<string>`strftime('%Y-%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime')`;
  const months = db
    .select({ month, count: sql<number>`count(*)` })
    .from(photos)
    .innerJoin(exifData, eq(exifData.photoId, photos.id))
    .where(and(scope, sql`${exifData.dateTaken} IS NOT NULL`))
    .groupBy(month)
    .orderBy(desc(sql`count(*)`), desc(month))
    .limit(MAX_GROUPS)
    .all();
  return months.flatMap((group) => {
    if (!(group.month && MONTH_KEY.test(group.month))) {
      return [];
    }
    const [year, monthNumber] = group.month.split("-").map(Number);
    const start = new Date(year, monthNumber - 1, 1);
    const from = Math.max(
      start.getTime(),
      input.filters.dateFrom ?? Number.NEGATIVE_INFINITY
    );
    const to = Math.min(
      new Date(year, monthNumber, 1).getTime() - 1,
      input.filters.dateTo ?? Number.POSITIVE_INFINITY
    );
    if (from > to) {
      return [];
    }
    const previewPhotoIds = db
      .select({ id: photos.id })
      .from(photos)
      .innerJoin(exifData, eq(exifData.photoId, photos.id))
      .where(and(scope, eq(month, group.month)))
      .orderBy(desc(photos.isFavorite), asc(photos.id))
      .limit(3)
      .all()
      .map((photo) => photo.id);
    return [
      {
        kind: "month" as const,
        key: `month:${group.month}`,
        text: new Intl.DateTimeFormat(input.locale ?? input.language, {
          year: "numeric",
          month: "long",
        }).format(start),
        query: "",
        filters: {
          dateFrom: localSearchDay(new Date(from)),
          dateTo: localSearchDay(new Date(to)),
        },
        source: "library" as const,
        topics: [`month:${group.month}`],
        previewPhotoIds,
      },
    ];
  });
}

function tagEntries(
  db: ReturnType<typeof getDatabase>,
  input: SearchStarterInput
): SearchStarter[] {
  const trusted = sql`(${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1)`;
  const scope = buildPhotoSearchScope(db, input.filters);
  const groups = db
    .select({ id: tags.id, name: tags.name, count: sql<number>`count(*)` })
    .from(photoTags)
    .innerJoin(photos, eq(photos.id, photoTags.photoId))
    .innerJoin(tags, eq(tags.id, photoTags.tagId))
    .where(and(scope, trusted))
    .groupBy(tags.id)
    .orderBy(desc(sql`count(*)`), asc(tags.id))
    .limit(MAX_GROUPS * 2)
    .all();
  return groups
    .filter(
      (tag) =>
        tag.name.trim().length > 0 &&
        tag.name.length <= 198 &&
        !UNSAFE_NAME.test(tag.name)
    )
    .slice(0, MAX_GROUPS)
    .map((tag) => ({
      kind: "tag",
      key: `tag:${tag.id}`,
      text: tag.name,
      query: `"${tag.name}"`,
      source: "library",
      topics: [tag.name],
      previewPhotoIds: db
        .select({ id: photos.id })
        .from(photos)
        .innerJoin(photoTags, eq(photoTags.photoId, photos.id))
        .where(and(scope, trusted, eq(photoTags.tagId, tag.id)))
        .orderBy(desc(photos.isFavorite), asc(photos.id))
        .limit(3)
        .all()
        .map((photo) => photo.id),
    }));
}

/** Metadata-only discovery never waits for the model, vectors or thumbnail I/O. */
export function getSearchStarterFallbacks(
  input: SearchStarterInput
): SearchStarterResponse {
  const db = getDatabase();
  const context = getSearchStarterContext(db);
  const base = {
    candidates: [] as SearchStarter[],
    day: context.day,
    revision: context.metadataRevision,
    validity: context.validity,
  };
  if (input.colorHex) {
    return { ...base, status: "color" };
  }
  const key = JSON.stringify([
    context.metadataRevision,
    context.day,
    input.language,
    input.locale,
    input.filters,
  ]);
  const cached = cache.get(key);
  if (cached) {
    return { ...cached, validity: context.validity };
  }
  try {
    const candidates = [...tagEntries(db, input), ...monthEntries(db, input)];
    const anyInScope = db
      .select({ id: photos.id })
      .from(photos)
      .where(buildPhotoSearchScope(db, input.filters))
      .limit(1)
      .get();
    const anyInLibrary =
      anyInScope ||
      db
        .select({ id: photos.id })
        .from(photos)
        .where(isNull(photos.deletedAt))
        .limit(1)
        .get();
    let emptyReason: SearchStarterResponse["emptyReason"] = "no-candidates";
    if (!anyInScope) {
      emptyReason = anyInLibrary ? "scope" : "library";
    }
    const response: SearchStarterResponse = {
      ...base,
      candidates,
      status: candidates.length ? "ready" : "empty",
      emptyReason,
    };
    if (cache.size >= 8) {
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) {
        cache.delete(oldest);
      }
    }
    cache.set(key, response);
    return response;
  } catch (error) {
    console.warn("[SearchStarters] Metadata preparation failed:", error);
    return { ...base, status: "error" };
  }
}
