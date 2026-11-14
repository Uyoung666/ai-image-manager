import { ipc } from "@/ipc/manager";
import type { LibraryStatusFilter } from "@/types/library-reliability";

export const imageSearchActions = {
  getPreview: (imagePath: string) =>
    ipc.client.photos.getImageSearchPreview({ imagePath }),
  search: (
    imagePath: string,
    limit = 500,
    libraryStatus?: LibraryStatusFilter
  ) =>
    ipc.client.photos.searchByImage({
      imagePath,
      limit,
      ...(libraryStatus ? { libraryStatus } : {}),
    }),
};
