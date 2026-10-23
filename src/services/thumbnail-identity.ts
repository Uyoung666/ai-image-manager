import { createHash } from "node:crypto";
import fs from "node:fs";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";

export function thumbnailSourceIdentity(stat: fs.Stats): string {
  return createHash("md5")
    .update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:v1`)
    .digest("hex");
}

/** Descriptor construction is host-only and only receives records selected by ID. */
export async function describeGalleryThumbnails<
  T extends { id: number; path?: string },
>(items: T[]): Promise<Array<T & { thumbnailVersion?: string }>> {
  const started = performance.now();
  const result: Array<T & { thumbnailVersion?: string }> = [];
  const batchSize = GALLERY_CONFIG.thumbnailDescriptorBatchSize;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    result.push(
      ...(await Promise.all(
        items.slice(offset, offset + batchSize).map(async (photo) => {
          if (!photo.path) {
            return photo;
          }
          try {
            const stat = await fs.promises.stat(photo.path);
            return {
              ...photo,
              thumbnailVersion: thumbnailSourceIdentity(stat),
            };
          } catch {
            return photo;
          }
        })
      ))
    );
  }
  recordGalleryMediaStat("thumbnailDescriptorMs", performance.now() - started);
  recordGalleryMediaStat("thumbnailDescriptorFiles", items.length);
  return result;
}
