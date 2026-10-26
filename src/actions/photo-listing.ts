import { ipc } from "@/ipc/manager";
import type { GalleryThumbnailEdge } from "@/utils/gallery-config";

export const photoListingActions = {
  page: (input: Parameters<typeof ipc.client.photos.listPhotoPage>[0]) =>
    ipc.client.photos.listPhotoPage(input),
  layoutPrefix: (
    input: Parameters<typeof ipc.client.photos.getPhotoLayoutPrefix>[0]
  ) => ipc.client.photos.getPhotoLayoutPrefix(input),
  byIds: (ids: number[]) => ipc.client.photos.getPhotosByIds({ ids }),
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
