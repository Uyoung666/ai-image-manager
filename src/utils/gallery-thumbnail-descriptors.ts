import { photoListingActions } from "@/actions/photo-listing";

const queued = new Map<number, Array<(version: string | undefined) => void>>();
let scheduled = false;
/** Array-based search/sequence cards share one host descriptor read per turn. */
export function requestThumbnailVersion(
  id: number
): Promise<string | undefined> {
  return new Promise((resolve) => {
    const consumers = queued.get(id) ?? [];
    consumers.push(resolve);
    queued.set(id, consumers);
    if (scheduled) {
      return;
    }
    scheduled = true;
    queueMicrotask(async () => {
      scheduled = false;
      const batch = new Map(queued);
      queued.clear();
      const ids = [...batch.keys()];
      for (let offset = 0; offset < ids.length; offset += 1000) {
        const page = ids.slice(offset, offset + 1000);
        let versions = new Map<number, string | undefined>();
        try {
          versions = new Map(
            (await photoListingActions.thumbnailVersions(page)).map((item) => [
              item.id,
              item.thumbnailVersion,
            ])
          );
        } catch {
          /* The HTTP request supplies the normal error UI. */
        }
        for (const photoId of page) {
          for (const consumer of batch.get(photoId) ?? []) {
            consumer(versions.get(photoId));
          }
        }
      }
    });
  });
}
