import { ipc } from "@/ipc/manager";

export const imageSearchActions = {
  getPreview: (imagePath: string) =>
    ipc.client.photos.getImageSearchPreview({ imagePath }),
  search: (imagePath: string, limit = 500) =>
    ipc.client.photos.searchByImage({ imagePath, limit }),
};
