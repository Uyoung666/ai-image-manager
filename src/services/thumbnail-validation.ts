import type fs from "node:fs";
import path from "node:path";
import { LRUCache } from "lru-cache";
import sharp from "sharp";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";

const validated = new LRUCache<string, sharp.Metadata>({
  max: GALLERY_CONFIG.validationCacheEntries,
});
const pending = new Map<string, Promise<sharp.Metadata>>();
let epoch = 0;

export function validateThumbnail(
  filePath: string,
  stat: fs.Stats
): Promise<sharp.Metadata> {
  const normalized = path.resolve(filePath);
  const key = `${process.platform === "win32" ? normalized.toLowerCase() : normalized}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;
  const cached = validated.get(key);
  if (cached) {
    recordGalleryMediaStat("thumbnailValidationHit");
    return Promise.resolve(cached);
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  recordGalleryMediaStat("thumbnailValidation");
  const generation = epoch;
  const started = performance.now();
  const task = sharp(filePath)
    .metadata()
    .then((metadata) => {
      if (!(metadata.width && metadata.height)) {
        throw new Error("Invalid thumbnail dimensions");
      }
      if (generation === epoch) {
        validated.set(key, metadata);
      }
      recordGalleryMediaStat(
        "thumbnailValidationMs",
        performance.now() - started
      );
      return metadata;
    })
    .finally(() => {
      if (pending.get(key) === task) {
        pending.delete(key);
      }
    });
  pending.set(key, task);
  return task;
}

export function clearThumbnailValidation(): void {
  epoch++;
  validated.clear();
  pending.clear();
}
registerGalleryCleanup(clearThumbnailValidation);
