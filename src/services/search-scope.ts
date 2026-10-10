import { createHash } from "node:crypto";
import type { SQL } from "drizzle-orm";
import { and, eq, gte, inArray, isNull, like, lte, or, sql } from "drizzle-orm";
import type { getDatabase } from "@/db";
import { advancedExifData, exifData, photos } from "@/db/schema";

const advancedColumns = {
  vendor: advancedExifData.vendor,
  captureMode: advancedExifData.captureMode,
  exposureProgram: advancedExifData.exposureProgram,
  meteringMode: advancedExifData.meteringMode,
  whiteBalance: advancedExifData.whiteBalance,
  focusMode: advancedExifData.focusMode,
  subjectTarget: advancedExifData.subjectTarget,
  driveMode: advancedExifData.driveMode,
  stabilizationMode: advancedExifData.stabilizationMode,
  computationalMode: advancedExifData.computationalMode,
  inCameraLook: advancedExifData.inCameraLook,
  provenanceStatus: advancedExifData.provenanceStatus,
} as const;

export interface PhotoSearchFilters {
  advancedField?: keyof typeof advancedColumns;
  advancedValue?: string;
  apertureMax?: number;
  apertureMin?: number;
  cameraModel?: string;
  creator?: string;
  dateFrom?: number;
  dateHour?: number;
  dateMonth?: number;
  dateTo?: number;
  filenameGlob?: string;
  focalMax?: number;
  focalMin?: number;
  isoMax?: number;
  isoMin?: number;
  lensModel?: string;
  shutterMax?: number;
  shutterMin?: number;
}

export function buildPhotoSearchScope(
  db: ReturnType<typeof getDatabase>,
  filters: PhotoSearchFilters
): SQL {
  const conditions: SQL[] = [isNull(photos.deletedAt)];
  const basic: SQL[] = [];
  for (const [value, column, minimum] of [
    [filters.dateFrom, exifData.dateTaken, true],
    [filters.dateTo, exifData.dateTaken, false],
    [filters.focalMin, exifData.focalLengthNum, true],
    [filters.focalMax, exifData.focalLengthNum, false],
    [filters.apertureMin, exifData.aperture, true],
    [filters.apertureMax, exifData.aperture, false],
    [filters.isoMin, exifData.iso, true],
    [filters.isoMax, exifData.iso, false],
    [filters.shutterMin, exifData.shutterSpeedNum, true],
    [filters.shutterMax, exifData.shutterSpeedNum, false],
  ] as const) {
    if (value !== undefined) {
      basic.push(minimum ? gte(column, value) : lte(column, value));
    }
  }
  if (filters.dateMonth !== undefined) {
    basic.push(
      sql`CAST(strftime('%m', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${filters.dateMonth}`
    );
  }
  if (filters.dateHour !== undefined) {
    basic.push(
      sql`CAST(strftime('%H', ${exifData.dateTaken} / 1000, 'unixepoch', 'localtime') AS INTEGER) = ${filters.dateHour}`
    );
  }
  if (filters.cameraModel) {
    basic.push(like(exifData.cameraModel, `%${filters.cameraModel}%`));
  }
  if (filters.lensModel) {
    basic.push(like(exifData.lensModel, `%${filters.lensModel}%`));
  }
  if (basic.length > 0) {
    conditions.push(
      inArray(
        photos.id,
        db
          .select({ id: exifData.photoId })
          .from(exifData)
          .where(and(...basic))
      )
    );
  }
  if (filters.creator) {
    const pattern = `%${filters.creator}%`;
    conditions.push(
      or(
        inArray(
          photos.id,
          db
            .select({ id: exifData.photoId })
            .from(exifData)
            .where(like(exifData.artist, pattern))
        ),
        inArray(
          photos.id,
          db
            .select({ id: advancedExifData.photoId })
            .from(advancedExifData)
            .where(
              sql`json_extract(${advancedExifData.normalizedJson}, '$.workflow.artist') LIKE ${pattern}`
            )
        )
      ) as SQL
    );
  }
  if (filters.advancedField && filters.advancedValue) {
    conditions.push(
      inArray(
        photos.id,
        db
          .select({ id: advancedExifData.photoId })
          .from(advancedExifData)
          .where(
            eq(advancedColumns[filters.advancedField], filters.advancedValue)
          )
      )
    );
  }
  if (filters.filenameGlob) {
    conditions.push(
      sql`LOWER(${photos.filename}) GLOB LOWER(${filters.filenameGlob})`
    );
  }
  return and(...conditions) as SQL;
}

interface PhotoSearchScope {
  allowedPhotoIds: number[];
  byId: Map<number, { fileDate: number | null; id: number }>;
  key: string;
  rows: Array<{ fileDate: number | null; id: number }>;
}

const scopes = new Map<
  string,
  { scope: PhotoSearchScope; timestamp: number }
>();
const MAX_SCOPES = 20;
const SCOPE_TTL_MS = 5 * 60 * 1000;

export function getPhotoSearchScope(
  db: ReturnType<typeof getDatabase>,
  filters: PhotoSearchFilters,
  revision: string
): PhotoSearchScope {
  const identity = `${revision}:${JSON.stringify(
    Object.fromEntries(
      Object.entries(filters)
        .filter(([, value]) => value !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
    )
  )}`;
  const cached = scopes.get(identity);
  if (cached && Date.now() - cached.timestamp < SCOPE_TTL_MS) {
    scopes.delete(identity);
    scopes.set(identity, cached);
    return cached.scope;
  }
  const rows = db
    .select({ id: photos.id, fileDate: photos.fileDate })
    .from(photos)
    .where(buildPhotoSearchScope(db, filters))
    .all();
  const byId = new Map(rows.map((row) => [row.id, row]));
  const scope = {
    rows,
    byId,
    allowedPhotoIds: [...byId.keys()],
    key: createHash("sha256").update(identity).digest("hex"),
  };
  scopes.delete(identity);
  while (scopes.size >= MAX_SCOPES) {
    const oldest = scopes.keys().next().value;
    if (oldest !== undefined) {
      scopes.delete(oldest);
    }
  }
  scopes.set(identity, { scope, timestamp: Date.now() });
  return scope;
}
