import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { advancedExifData, exifData } from "@/db/schema";
import { CONTENT_CREDENTIALS_PARSER_VERSION } from "@/types/photo-metadata";

export function readPhotoExif(photoId: number) {
  const db = getDatabase();
  const basic = db
    .select()
    .from(exifData)
    .where(eq(exifData.photoId, photoId))
    .get();
  if (!basic) {
    return null;
  }
  const advancedRow = db
    .select()
    .from(advancedExifData)
    .where(eq(advancedExifData.photoId, photoId))
    .get();
  if (!advancedRow) {
    return { ...basic, advanced: null };
  }
  try {
    const normalized = advancedRow.normalizedJson
      ? JSON.parse(advancedRow.normalizedJson)
      : null;
    const vendorRaw = advancedRow.vendorRawJson
      ? JSON.parse(advancedRow.vendorRawJson)
      : {};
    if (
      normalized?.provenance &&
      advancedRow.parserVersion < CONTENT_CREDENTIALS_PARSER_VERSION
    ) {
      normalized.provenance = {
        status: normalized.provenance.status,
        legacy: true,
      };
    }
    return {
      ...basic,
      advanced: normalized ? { ...normalized, vendorRaw } : null,
      advancedStatus: advancedRow.status,
    };
  } catch {
    return { ...basic, advanced: null, advancedStatus: advancedRow.status };
  }
}
