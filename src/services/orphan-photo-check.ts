import fs from "node:fs";
import { GALLERY_CONFIG } from "@/utils/gallery-config";

/** Background probes leave filesystem capacity available for visible images. */
export async function findMissingPhotoIds(
  photos: readonly { id: number; path: string }[],
  signal?: AbortSignal
): Promise<Set<number>> {
  const missing = new Set<number>();
  let next = 0;
  await Promise.all(
    Array.from(
      { length: GALLERY_CONFIG.maintenanceFileConcurrency },
      async () => {
        while (next < photos.length && !signal?.aborted) {
          const photo = photos[next++];
          try {
            await fs.promises.access(photo.path);
          } catch (error) {
            const code = (error as NodeJS.ErrnoException | null)?.code;
            // Permission failures and unavailable devices do not prove deletion.
            if (code === "ENOENT" || code === "ENOTDIR") {
              missing.add(photo.id);
            }
          }
        }
      }
    )
  );
  return missing;
}
