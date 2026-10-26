import fs from "node:fs";
import path from "node:path";
import { LRUCache } from "lru-cache";
import sharp from "sharp";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";

const validated = new LRUCache<string, sharp.Metadata>({
  max: GALLERY_CONFIG.validationCacheEntries,
});
interface ValidatedThumbnail {
  buffer?: Buffer;
  metadata: sharp.Metadata;
}
const pending = new Map<string, Promise<ValidatedThumbnail>>();
let epoch = 0;

export function validateThumbnail(
  filePath: string,
  stat: fs.Stats
): Promise<sharp.Metadata> {
  return validateResource(filePath, stat, false).then(
    (result) => result.metadata
  );
}

/** Only a cold, small file keeps its bytes until the current response finishes. */
export function readValidatedThumbnail(
  filePath: string,
  stat: fs.Stats
): Promise<ValidatedThumbnail> {
  return validateResource(filePath, stat, true);
}

function validateResource(
  filePath: string,
  stat: fs.Stats,
  readBuffer: boolean
): Promise<ValidatedThumbnail> {
  const normalized = path.resolve(filePath);
  const key = `${process.platform === "win32" ? normalized.toLowerCase() : normalized}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.birthtimeMs}`;
  const cached = validated.get(key);
  if (cached) {
    recordGalleryMediaStat("thumbnailValidationHit");
    return Promise.resolve({ metadata: cached });
  }
  const existing = pending.get(key);
  if (existing) {
    return existing;
  }
  recordGalleryMediaStat("thumbnailValidation");
  const generation = epoch;
  const started = performance.now();
  const task = (async () => {
    const buffer =
      readBuffer && stat.size <= GALLERY_CONFIG.validationReadBufferBytes
        ? await fs.promises.readFile(filePath)
        : undefined;
    if (buffer) {
      recordGalleryMediaStat(
        "thumbnailBufferReadMs",
        performance.now() - started
      );
      recordGalleryMediaStat("thumbnailBufferBytes", buffer.length);
    }
    const metadataStarted = performance.now();
    const metadata = await sharp(buffer ?? filePath).metadata();
    recordGalleryMediaStat(
      "thumbnailMetadataMs",
      performance.now() - metadataStarted
    );
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
    return { metadata, buffer };
  })().finally(() => {
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
