import { ipc } from "@/ipc/manager";
export const photoOperationActions = {
  deletePhoto: (input: Parameters<typeof ipc.client.photos.deletePhoto>[0]) =>
    ipc.client.photos.deletePhoto(input),
  deletePhotos: (input: Parameters<typeof ipc.client.photos.deletePhotos>[0]) =>
    ipc.client.photos.deletePhotos(input),
  renamePhotos: (input: Parameters<typeof ipc.client.photos.renamePhotos>[0]) =>
    ipc.client.photos.renamePhotos(input),
  convertPhotos: (
    input: Parameters<typeof ipc.client.photos.convertPhotos>[0]
  ) => ipc.client.photos.convertPhotos(input),
};
