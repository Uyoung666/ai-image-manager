import { and, eq, inArray, or } from "drizzle-orm";
import { getDatabase } from "@/db";
import { exifData, photos, photoTags, tags } from "@/db/schema";
import type { DeliveryDisclosure } from "@/types/photo-delivery";

export type DeliveryPhoto = typeof photos.$inferSelect;

export function* deliveryPhotos(ids: number[]): Generator<DeliveryPhoto> {
  const db = getDatabase();
  const uniqueIds = [...new Set(ids)];
  const batchSize = 250;
  for (let offset = 0; offset < uniqueIds.length; offset += batchSize) {
    const batch = uniqueIds.slice(offset, offset + batchSize);
    const rows = db
      .select()
      .from(photos)
      .where(inArray(photos.id, batch))
      .all();
    const byId = new Map(rows.map((photo) => [photo.id, photo]));
    for (const id of batch) {
      const photo = byId.get(id);
      if (!photo) {
        throw new Error(`Photo #${id} is no longer in the library`);
      }
      yield photo;
    }
  }
}

export function deliveryMetadata(
  photo: DeliveryPhoto,
  disclosure: DeliveryDisclosure,
  locale: string
) {
  const db = getDatabase();
  const tagNames = disclosure.tags
    ? db
        .select({ name: tags.name })
        .from(photoTags)
        .innerJoin(tags, eq(photoTags.tagId, tags.id))
        .where(
          and(
            eq(photoTags.photoId, photo.id),
            or(
              eq(photoTags.origin, "manual"),
              eq(photoTags.userConfirmed, true)
            )
          )
        )
        .orderBy(tags.name)
        .all()
        .map(({ name }) => name)
    : [];
  const capture =
    disclosure.captureDetails &&
    photo.metadataRevision === photo.contentRevision
      ? db.select().from(exifData).where(eq(exifData.photoId, photo.id)).get()
      : undefined;
  return {
    tags: tagNames,
    exif: capture
      ? {
          camera: capture.cameraModel ?? undefined,
          lens: capture.lensModel ?? undefined,
          focalLength: capture.focalLength ?? undefined,
          aperture: capture.aperture?.toString(),
          shutter: capture.shutterSpeed ?? undefined,
          iso: capture.iso ?? undefined,
          dateTaken:
            capture.dateTaken == null
              ? undefined
              : new Date(capture.dateTaken).toLocaleDateString(locale),
        }
      : null,
  };
}

export function deliverySequence(index: number): string {
  return `photo-${String(index + 1).padStart(4, "0")}`;
}

export function deliveryLocale(locale: string): string {
  try {
    return Intl.DateTimeFormat.supportedLocalesOf([locale])[0] ?? "zh-CN";
  } catch {
    return "zh-CN";
  }
}

export function serializeDeliveryData(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}
