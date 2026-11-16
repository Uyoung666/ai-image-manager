import { ipc } from "@/ipc/manager";
import { MAX_PHOTO_IDS_PER_REQUEST, type Photo } from "@/types/photo";
import type { GalleryThumbnailEdge } from "@/utils/gallery-config";

export const photoListingActions = {
  page: (input: Parameters<typeof ipc.client.photos.listPhotoPage>[0]) =>
    ipc.client.photos.listPhotoPage(input),
  layoutPrefix: (
    input: Parameters<typeof ipc.client.photos.getPhotoLayoutPrefix>[0]
  ) => ipc.client.photos.getPhotoLayoutPrefix(input),
  byIds: async (ids: number[]) => {
    const uniqueIds = [...new Set(ids)];
    const photos: Photo[] = [];
    for (let i = 0; i < uniqueIds.length; i += MAX_PHOTO_IDS_PER_REQUEST) {
      const batch = await ipc.client.photos.getPhotosByIds({
        ids: uniqueIds.slice(i, i + MAX_PHOTO_IDS_PER_REQUEST),
      });
      photos.push(...batch);
    }
    return photos;
  },
  thumbnailVersions: (
    ids: number[],
    priority: 0 | 1 | 2 = 2,
    edge?: GalleryThumbnailEdge | Map<number, GalleryThumbnailEdge>
  ) =>
    ipc.client.photos.getPhotoThumbnailVersions({
      ids,
      priority,
      edge: typeof edge === "number" ? edge : undefined,
      edges:
        edge instanceof Map
          ? [...edge].map(([id, edge]) => ({ id, edge }))
          : undefined,
    }),
  backfillThumbnails: (
    input: Parameters<typeof ipc.client.photos.backfillMissingThumbnails>[0]
  ) => ipc.client.photos.backfillMissingThumbnails(input),
};
