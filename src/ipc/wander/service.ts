import fs from "node:fs";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  albumPhotos,
  albums,
  exifData,
  photos,
  photoTags,
  photoViewStats,
  tags,
} from "@/db/schema";
import type {
  WanderContentMode,
  WanderPhoto,
  WanderSession,
} from "@/types/wander";

const MAX_CANDIDATES = 24;
const MIN_SESSION_SIZE = 2;
const THEME_MIN_SIZE = 4;
const TODAY_MIN_SIZE = 4;
const RECENT_WANDER_MS = 30 * 24 * 60 * 60 * 1000;
// Matches the confidence floor used by the existing hybrid-search reranker.
const TRUSTED_AUTO_TAG_CONFIDENCE = 0.55;

interface CuratedResult {
  mode: WanderContentMode;
  photos: WanderPhoto[];
  subtitleKey?: string;
  subtitleParams?: Record<string, number | string>;
  titleKey: string;
  titleParams?: Record<string, number | string>;
}

interface ThemeCandidate {
  id: number;
  name: string;
  trustedByUser: number;
}

const WANDER_PHOTO_COLUMNS = {
  id: photos.id,
  path: photos.path,
  filename: photos.filename,
  width: photos.width,
  height: photos.height,
  fileDate: photos.fileDate,
  thumbnailPath: photos.thumbnailPath,
  isFavorite: photos.isFavorite,
  isIndexed: photos.isIndexed,
};

export function shuffleCandidates<T>(items: T[], random = Math.random): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [
      shuffled[swapIndex],
      shuffled[index],
    ];
  }
  return shuffled;
}

export function chooseWanderMode(
  mode: "auto" | WanderContentMode,
  allowedModes: WanderContentMode[] | undefined,
  random = Math.random,
  excludeMode?: WanderContentMode
): WanderContentMode {
  if (mode !== "auto") {
    return mode;
  }
  const base = allowedModes?.length
    ? allowedModes
    : ([
        "timeCapsule",
        "theme",
        "rediscovery",
        "hamsterWheel",
      ] as WanderContentMode[]);
  // Avoid repeating the previous round's mode; fall back to the full set when
  // exclusion would leave no choices (e.g. only one mode is enabled).
  const choices = excludeMode
    ? base.filter((item) => item !== excludeMode)
    : base;
  const pool = choices.length > 0 ? choices : base;
  return pool[Math.floor(random() * pool.length)] ?? "rediscovery";
}

function validPhotoSql() {
  return sql`${photos.deletedAt} IS NULL AND ${photos.width} > 0 AND ${photos.height} > 0`;
}

function normalizePhotos(rows: Record<string, unknown>[]): WanderPhoto[] {
  return rows
    .filter((row) => typeof row.path === "string" && fs.existsSync(row.path))
    .map((row) => ({
      id: row.id as number,
      path: row.path as string,
      filename: row.filename as string,
      width: row.width as number,
      height: row.height as number,
      fileDate: (row.fileDate as number | null) ?? null,
      thumbnailPath: (row.thumbnailPath as string | null) ?? null,
      isFavorite: Boolean(row.isFavorite),
      isIndexed: Boolean(row.isIndexed),
    }));
}

function selectPhotosByIds(ids: number[]): WanderPhoto[] {
  if (ids.length === 0) {
    return [];
  }
  const db = getDatabase();
  const byId = new Map(
    normalizePhotos(
      db
        .select(WANDER_PHOTO_COLUMNS)
        .from(photos)
        .where(and(inArray(photos.id, ids), validPhotoSql()))
        .all() as Record<string, unknown>[]
    ).map((photo) => [photo.id, photo])
  );
  return ids.map((id) => byId.get(id)).filter(Boolean) as WanderPhoto[];
}

export function curateTimeCapsule(): CuratedResult {
  const db = getDatabase();
  const now = new Date();
  const month = now.getMonth() + 1;
  const day = now.getDate();
  const startToday = new Date(
    now.getFullYear(),
    now.getMonth(),
    now.getDate()
  ).getTime();
  const capturedAt = sql<number>`COALESCE(${exifData.dateTaken}, ${photos.fileDate})`;

  const todayRows = db
    .select({ id: photos.id })
    .from(photos)
    .leftJoin(exifData, eq(exifData.photoId, photos.id))
    .where(
      and(
        validPhotoSql(),
        sql`${capturedAt} < ${startToday}`,
        sql`CAST(strftime('%m', ${capturedAt} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${month}`,
        sql`CAST(strftime('%d', ${capturedAt} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${day}`
      )
    )
    .orderBy(sql`RANDOM()`)
    .limit(MAX_CANDIDATES)
    .all();

  if (todayRows.length >= TODAY_MIN_SIZE) {
    return {
      mode: "timeCapsule",
      titleKey: "wander.title.timeCapsuleToday",
      subtitleKey: "wander.subtitle.timeCapsuleToday",
      subtitleParams: { count: todayRows.length },
      photos: selectPhotosByIds(todayRows.map(({ id }) => id)),
    };
  }

  const anchor = db.all(sql`
    SELECT date(COALESCE(e.date_taken, p.file_date) / 1000, 'unixepoch', 'localtime') AS dateKey,
           COUNT(*) AS photoCount
    FROM photos p
    LEFT JOIN exif_data e ON e.photo_id = p.id
    WHERE p.deleted_at IS NULL
      AND p.width > 0
      AND p.height > 0
      AND COALESCE(e.date_taken, p.file_date) IS NOT NULL
      AND COALESCE(e.date_taken, p.file_date) < ${startToday}
    GROUP BY dateKey
    HAVING COUNT(*) >= 2
    ORDER BY RANDOM()
    LIMIT 1
  `) as Array<{ dateKey: string; photoCount: number }>;

  if (!anchor[0]) {
    return {
      mode: "timeCapsule",
      titleKey: "wander.title.timeCapsuleDate",
      photos: [],
    };
  }

  const anchorStart = new Date(`${anchor[0].dateKey}T00:00:00`).getTime();
  const from = anchorStart - 3 * 24 * 60 * 60 * 1000;
  const to = anchorStart + 4 * 24 * 60 * 60 * 1000;
  const rows = db
    .select({ id: photos.id })
    .from(photos)
    .leftJoin(exifData, eq(exifData.photoId, photos.id))
    .where(
      and(
        validPhotoSql(),
        sql`${capturedAt} >= ${from}`,
        sql`${capturedAt} < ${to}`
      )
    )
    .orderBy(sql`RANDOM()`)
    .limit(MAX_CANDIDATES)
    .all();

  return {
    mode: "timeCapsule",
    titleKey: "wander.title.timeCapsuleDate",
    titleParams: { date: anchor[0].dateKey },
    subtitleKey: "wander.subtitle.timeCapsuleDate",
    subtitleParams: { count: rows.length },
    photos: selectPhotosByIds(rows.map(({ id }) => id)),
  };
}

export function curateTheme(): CuratedResult {
  const db = getDatabase();
  const trustedTag = sql`(${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1 OR COALESCE(${photoTags.confidence}, 0) >= ${TRUSTED_AUTO_TAG_CONFIDENCE})`;
  const candidates = db
    .select({
      id: tags.id,
      name: tags.name,
      trustedByUser: sql<number>`SUM(CASE WHEN ${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(tags)
    .innerJoin(photoTags, eq(photoTags.tagId, tags.id))
    .innerJoin(photos, eq(photos.id, photoTags.photoId))
    .where(and(validPhotoSql(), trustedTag))
    .groupBy(tags.id, tags.name)
    .having(sql`COUNT(DISTINCT ${photos.id}) >= ${THEME_MIN_SIZE}`)
    // Order by the aggregate expression, not the SELECT alias: drizzle does not
    // emit an alias for raw sql<> fragments, so SQLite cannot resolve it.
    .orderBy(
      sql`SUM(CASE WHEN ${photoTags.origin} = 'manual' OR ${photoTags.userConfirmed} = 1 THEN 1 ELSE 0 END) DESC`,
      sql`RANDOM()`
    )
    .limit(MAX_CANDIDATES)
    .all() as ThemeCandidate[];

  if (candidates.length === 0) {
    return { mode: "theme", titleKey: "wander.title.theme", photos: [] };
  }
  const preferred = candidates.filter(({ trustedByUser }) => trustedByUser > 0);
  const pool = preferred.length > 0 ? preferred : candidates;
  const theme = pool[Math.floor(Math.random() * pool.length)];
  const rows = db
    .select({ id: photos.id })
    .from(photoTags)
    .innerJoin(photos, eq(photos.id, photoTags.photoId))
    .where(and(eq(photoTags.tagId, theme.id), validPhotoSql(), trustedTag))
    .orderBy(sql`RANDOM()`)
    .limit(MAX_CANDIDATES)
    .all();

  return {
    mode: "theme",
    titleKey: "wander.title.theme",
    titleParams: { theme: theme.name },
    subtitleKey: "wander.subtitle.theme",
    subtitleParams: { count: rows.length },
    photos: selectPhotosByIds(rows.map(({ id }) => id)),
  };
}

export function curateRediscovery(): CuratedResult {
  const db = getDatabase();
  const recentCutoff = Date.now() - RECENT_WANDER_MS;
  const rows = db
    .select({ id: photos.id })
    .from(photos)
    .leftJoin(photoViewStats, eq(photoViewStats.photoId, photos.id))
    .where(validPhotoSql())
    .orderBy(
      sql`CASE WHEN COALESCE(${photoViewStats.viewCount}, 0) = 0 THEN 0 ELSE 1 END`,
      sql`CASE WHEN ${photoViewStats.lastWanderedAt} >= ${recentCutoff} THEN 1 ELSE 0 END`,
      sql`${photoViewStats.lastViewedAt} ASC NULLS FIRST`,
      sql`COALESCE(${photoViewStats.viewCount}, 0) ASC`,
      sql`RANDOM()`
    )
    .limit(MAX_CANDIDATES)
    .all();
  return {
    mode: "rediscovery",
    titleKey: "wander.title.rediscovery",
    subtitleKey: "wander.subtitle.rediscovery",
    subtitleParams: { count: rows.length },
    photos: selectPhotosByIds(rows.map(({ id }) => id)),
  };
}

function curateMode(mode: WanderContentMode): CuratedResult {
  switch (mode) {
    case "timeCapsule":
      return curateTimeCapsule();
    case "theme":
      return curateTheme();
    case "rediscovery":
      return curateRediscovery();
    case "hamsterWheel":
      return {
        mode: "hamsterWheel",
        titleKey: "wander.title.hamsterWheel",
        subtitleKey: "wander.subtitle.hamsterWheel",
        photos: [],
      };
    default:
      return curateRediscovery();
  }
}

function randomLibraryFallback(): CuratedResult {
  const db = getDatabase();
  const rows = db
    .select(WANDER_PHOTO_COLUMNS)
    .from(photos)
    .where(validPhotoSql())
    .orderBy(sql`RANDOM()`)
    .limit(MAX_CANDIDATES)
    .all();
  return {
    mode: "rediscovery",
    titleKey: "wander.title.rediscovery",
    subtitleKey: "wander.subtitle.rediscovery",
    subtitleParams: { count: rows.length },
    photos: normalizePhotos(rows as Record<string, unknown>[]),
  };
}

export function getCuratedWanderSession(input: {
  allowedModes?: WanderContentMode[];
  excludeMode?: WanderContentMode;
  limit: number;
  mode: "auto" | WanderContentMode;
}): WanderSession {
  const selectedMode = chooseWanderMode(
    input.mode,
    input.allowedModes,
    undefined,
    input.excludeMode
  );
  if (selectedMode === "hamsterWheel") {
    return curateMode(selectedMode);
  }
  let result = curateMode(selectedMode);
  if (
    result.photos.length < MIN_SESSION_SIZE &&
    selectedMode !== "rediscovery"
  ) {
    result = curateRediscovery();
  }
  if (result.photos.length < MIN_SESSION_SIZE) {
    result = randomLibraryFallback();
  }
  return {
    ...result,
    photos: shuffleCandidates(result.photos).slice(0, input.limit),
  };
}

export function recordExposure(
  photoId: number,
  source: "lightbox" | "wander"
): void {
  const db = getDatabase();
  const now = Date.now();
  if (source === "lightbox") {
    db.insert(photoViewStats)
      .values({ photoId, viewCount: 1, lastViewedAt: now })
      .onConflictDoUpdate({
        target: photoViewStats.photoId,
        set: {
          viewCount: sql`${photoViewStats.viewCount} + 1`,
          lastViewedAt: now,
        },
      })
      .run();
    return;
  }
  db.insert(photoViewStats)
    .values({ photoId, wanderShownCount: 1, lastWanderedAt: now })
    .onConflictDoUpdate({
      target: photoViewStats.photoId,
      set: {
        wanderShownCount: sql`${photoViewStats.wanderShownCount} + 1`,
        lastWanderedAt: now,
      },
    })
    .run();
}

export function saveSessionToAlbum(
  title: string,
  rawPhotoIds: number[]
): number {
  const db = getDatabase();
  const photoIds = [...new Set(rawPhotoIds)];
  const activeIds = db
    .select({ id: photos.id })
    .from(photos)
    .where(and(inArray(photos.id, photoIds), isNull(photos.deletedAt)))
    .all()
    .map(({ id }) => id);
  if (activeIds.length !== photoIds.length) {
    throw new Error("Wander session contains unavailable photos");
  }

  return db.transaction((tx) => {
    const created = tx
      .insert(albums)
      .values({ name: title, isSmart: false })
      .returning({ id: albums.id })
      .get();
    if (!created) {
      throw new Error("Failed to create wander album");
    }
    tx.insert(albumPhotos)
      .values(
        photoIds.map((photoId, sortOrder) => ({
          albumId: created.id,
          photoId,
          sortOrder,
        }))
      )
      .run();
    tx.update(albums)
      .set({ coverPhotoId: photoIds[0] })
      .where(eq(albums.id, created.id))
      .run();
    return created.id;
  });
}
