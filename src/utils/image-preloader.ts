import { GALLERY_CONFIG } from "./gallery-config";
import { scheduleImage } from "./image-scheduler";

/** Compatibility wrapper; every caller shares the same global request budget. */
export async function preloadImagesWithConcurrency(
  urls: string[],
  concurrency: number = GALLERY_CONFIG.prefetchConcurrency
): Promise<{ loaded: number; failed: number }> {
  const unique = [...new Set(urls.filter(Boolean))];
  let next = 0;
  let loaded = 0;
  let failed = 0;
  await Promise.all(
    Array.from(
      {
        length: Math.min(
          unique.length,
          Math.max(1, concurrency),
          GALLERY_CONFIG.imageConcurrency
        ),
      },
      async () => {
        while (next < unique.length) {
          const handle = scheduleImage(unique[next++], { priority: 2 });
          const result = await handle.promise;
          if (result === "loaded") {
            loaded++;
          } else if (result === "failed") {
            failed++;
          }
        }
      }
    )
  );
  return { loaded, failed };
}
