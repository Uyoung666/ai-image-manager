import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { advancedExifData, exifData } from "@/db/schema";

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
    return {
      ...basic,
      advanced: normalized ? { ...normalized, vendorRaw } : null,
      advancedStatus: advancedRow.status,
    };
  } catch {
    return { ...basic, advanced: null, advancedStatus: advancedRow.status };
  }
}
