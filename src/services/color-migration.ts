import { readFile } from "node:fs/promises";
import { and, eq, isNotNull, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import { appSettings, photos } from "@/db/schema";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { extractDominantColors, invalidateColorCache } from "./color-extractor";

let generation = 0;
registerGalleryCleanup(() => {
  generation++;
});

function hueBucket(colors: string): number | null {
  try {
    const hue = (JSON.parse(colors) as { hue?: number }[])[0]?.hue;
    return typeof hue === "number" && Number.isFinite(hue)
      ? Math.floor(hue / 10) % 36
      : null;
  } catch {
    return null;
  }
}

/** Backfill legacy palettes from the thumbnails of the accepted photo version. */
export async function runColorMigration(
  force = false
): Promise<{ processed: number; total: number; complete: boolean }> {
  const scope = generation;
  const db = getDatabase();
  const isCurrent = () => scope === generation && db === getDatabase();

  if (force) {
    db.update(photos)
      .set({ dominantColors: null, colorBucket: null })
      .where(isNull(photos.deletedAt))
      .run();
  }
  const eligible = and(
    isNull(photos.deletedAt),
    isNull(photos.dominantColors),
    eq(photos.metadataRevision, photos.contentRevision)
  );
  const rows = db
    .select({
      id: photos.id,
      path: photos.path,
      fileRevision: photos.fileRevision,
      contentRevision: photos.contentRevision,
      thumbnailPath: photos.thumbnailPath,
    })
    .from(photos)
    .where(and(eligible, isNotNull(photos.thumbnailPath)))
    .all();
  const total = rows.length;
  let processed = 0;
  let superseded = false;
  for (const photo of rows) {
    if (!isCurrent()) {
      return { processed, total, complete: false };
    }
    const thumbnail = photo.thumbnailPath;
    if (!thumbnail) {
      continue;
    }
    try {
      // libvips can cache pathname inputs and keep the preview locked on Windows.
      const colors = await extractDominantColors(await readFile(thumbnail));
      if (!isCurrent()) {
        return { processed, total, complete: false };
      }
      if (colors) {
        const result = db
          .update(photos)
          .set({ dominantColors: colors, colorBucket: hueBucket(colors) })
          .where(
            and(
              eligible,
              eq(photos.id, photo.id),
              eq(photos.path, photo.path),
              eq(photos.fileRevision, photo.fileRevision),
              eq(photos.contentRevision, photo.contentRevision),
              eq(photos.thumbnailPath, thumbnail)
            )
          )
          .run();
        superseded ||= result.changes !== 1;
      }
    } catch (error) {
      console.warn(`[ColorMigration] Failed for photo ${photo.id}:`, error);
    }
    processed++;
    if (processed % 10 === 0 || processed === total) {
      console.log(`[ColorMigration] Progress: ${processed}/${total}`);
    }
  }
  if (!isCurrent()) {
    return { processed, total, complete: false };
  }
  invalidateColorCache();
  if (superseded) {
    return { processed, total, complete: false };
  }
  try {
    const completed = { value: "true", updatedAt: Date.now() };
    db.insert(appSettings)
      .values({ key: "colors_migrated", ...completed })
      .onConflictDoUpdate({ target: appSettings.key, set: completed })
      .run();
    console.log("[ColorMigration] Completion marker written.");
  } catch (error) {
    console.error("[ColorMigration] Failed to write completion marker:", error);
    return { processed, total, complete: false };
  }
  return { processed, total, complete: true };
}
