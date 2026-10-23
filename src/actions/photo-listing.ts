import { ipc } from "@/ipc/manager";

export const photoListingActions = {
  page: (input: Parameters<typeof ipc.client.photos.listPhotoPage>[0]) =>
    ipc.client.photos.listPhotoPage(input),
  layoutPrefix: (
    input: Parameters<typeof ipc.client.photos.getPhotoLayoutPrefix>[0]
  ) => ipc.client.photos.getPhotoLayoutPrefix(input),
  byIds: (ids: number[]) => ipc.client.photos.getPhotosByIds({ ids }),
  thumbnailVersions: (ids: number[]) =>
    ipc.client.photos.getPhotoThumbnailVersions({ ids }),
  backfillThumbnails: (
    input: Parameters<typeof ipc.client.photos.backfillMissingThumbnails>[0]
  ) => ipc.client.photos.backfillMissingThumbnails(input),
};
