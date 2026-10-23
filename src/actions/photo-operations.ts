import { ipc } from "@/ipc/manager";
export const photoOperationActions = {
  deletePhoto: (input: Parameters<typeof ipc.client.photos.deletePhoto>[0]) =>
    ipc.client.photos.deletePhoto(input),
  deletePhotos: async (
    input: Parameters<typeof ipc.client.photos.deletePhotos>[0]
  ) => {
    let deleted = 0;
    for (let offset = 0; offset < input.ids.length; offset += 1000) {
      const result = await ipc.client.photos.deletePhotos({
        ids: input.ids.slice(offset, offset + 1000),
      });
      deleted += result.deleted;
    }
    return { deleted };
  },
  renamePhotos: (input: Parameters<typeof ipc.client.photos.renamePhotos>[0]) =>
    ipc.client.photos.renamePhotos(input),
  convertPhotos: (
    input: Parameters<typeof ipc.client.photos.convertPhotos>[0]
  ) => ipc.client.photos.convertPhotos(input),
};
