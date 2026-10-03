import type { WanderPhoto, WanderSession } from "@/types/wander";
import { preloadImagesWithConcurrency } from "@/utils/image-preloader";
import { toLocalMediaUrl, toPreviewUrl } from "@/utils/local-media-url";

const RAW_EXTENSION =
  /\.(?:cr2|cr3|nef|nrw|arw|srf|sr2|dng|orf|rw2|raf|pef|rwl|3fr|raw)$/i;

export interface PreparedWanderSession extends WanderSession {
  previews?: Record<number, string>;
}

export function wanderPreviewCandidates(photo: WanderPhoto): string[] {
  return [
    ...new Set(
      [
        photo.thumbnailPath ? toLocalMediaUrl(photo.thumbnailPath) : "",
        RAW_EXTENSION.test(photo.path) ? toPreviewUrl(photo.path) : "",
        toLocalMediaUrl(photo.path),
      ].filter(Boolean)
    ),
  ];
}

/** Only the current and prefetched round retain preview URLs. Never preload originals when a thumbnail works. */
export async function prepareWanderSession(
  session: WanderSession,
  cancelled: () => boolean
): Promise<PreparedWanderSession> {
  const photos = [
    ...new Map(session.photos.map((photo) => [photo.id, photo])).values(),
  ];
  const previews: Record<number, string> = {};
  await Promise.all(
    photos.map(async (photo) => {
      for (const url of wanderPreviewCandidates(photo)) {
        if (cancelled()) {
          return;
        }
        const result = await preloadImagesWithConcurrency([url], 4).catch(
          () => ({ loaded: 0 })
        );
        if (result.loaded > 0) {
          previews[photo.id] = url;
          return;
        }
      }
    })
  );
  return {
    ...session,
    photos: photos.filter((photo) => previews[photo.id]),
    previews,
  };
}
