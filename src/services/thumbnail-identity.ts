import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GalleryThumbnailEdge } from "@/utils/gallery-config";
import { GALLERY_CONFIG } from "@/utils/gallery-config";
import { registerGalleryCleanup } from "@/utils/gallery-lifecycle";
import { recordGalleryMediaStat } from "@/utils/gallery-perf";
import { PrioritySemaphore } from "@/utils/priority-semaphore";

const slots = new PrioritySemaphore(
  GALLERY_CONFIG.thumbnailDescriptorConcurrency
);
const pending = new Map<
  string,
  { controller: AbortController; promise: Promise<fs.Stats | undefined> }
>();
let epoch = 0;

function sourceStat(
  file: string,
  priority: number
): Promise<fs.Stats | undefined> {
  const normalized = path.resolve(file);
  const key =
    process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const prior = pending.get(key);
  if (prior) {
    slots.promote(prior.controller.signal, priority);
    return prior.promise;
  }
  const controller = new AbortController();
  const generation = epoch;
  const promise = (async () => {
    const queued = performance.now();
    await slots.acquire(controller.signal, priority);
    try {
      recordGalleryMediaStat(
        "thumbnailDescriptorQueueMs",
        performance.now() - queued
      );
      const stat = await fs.promises.stat(normalized);
      recordGalleryMediaStat("thumbnailDescriptorStat");
      return generation === epoch ? stat : undefined;
    } finally {
      slots.release();
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      if (pending.get(key)?.promise === promise) {
        pending.delete(key);
      }
    });
  pending.set(key, { controller, promise });
  return promise;
}

registerGalleryCleanup(() => {
  epoch++;
  for (const job of pending.values()) {
    job.controller.abort();
  }
  pending.clear();
});

export function thumbnailSourceIdentity(stat: fs.Stats): string {
  return createHash("md5")
    .update(`${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:v1`)
    .digest("hex");
}

/** Descriptor construction is host-only and only receives records selected by ID. */
export async function describeGalleryThumbnails<
  T extends { id: number; path?: string },
>(
  items: T[],
  priority = 2,
  hint?: (
    photo: T,
    stat: fs.Stats,
    readStat: (file: string) => Promise<fs.Stats | undefined>
  ) => Promise<GalleryThumbnailEdge | undefined>
): Promise<
  Array<T & { thumbnailVersion?: string; availableEdge?: GalleryThumbnailEdge }>
> {
  const started = performance.now();
  const generation = epoch;
  const result: Array<
    T & { thumbnailVersion?: string; availableEdge?: GalleryThumbnailEdge }
  > = [];
  const batchSize = GALLERY_CONFIG.thumbnailDescriptorBatchSize;
  for (let offset = 0; offset < items.length; offset += batchSize) {
    result.push(
      ...(await Promise.all(
        items.slice(offset, offset + batchSize).map(async (photo) => {
          if (!photo.path) {
            return photo;
          }
          try {
            const stat = await sourceStat(photo.path, priority);
            if (!stat) {
              return photo;
            }
            const availableEdge = await hint?.(photo, stat, (file) =>
              sourceStat(file, priority)
            );
            if (generation !== epoch) {
              return photo;
            }
            return {
              ...photo,
              thumbnailVersion: thumbnailSourceIdentity(stat),
              availableEdge,
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
