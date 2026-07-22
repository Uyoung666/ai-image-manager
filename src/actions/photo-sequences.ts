import { ipc } from "@/ipc/manager";

export const photoSequenceActions = {
  create: (input: { type: "burst" | "timelapse"; photoIds: number[] }) =>
    ipc.client.photos.createSequence(input),
  get: (id: number) => ipc.client.photos.getSequence({ id }),
  ignore: (photoIds: number[]) =>
    ipc.client.photos.ignoreSequencePhotos({ photoIds }),
  list: (input: { folderId?: number; photoIds?: number[] }) =>
    ipc.client.photos.listSequences(input),
  rebuild: (folderId?: number) =>
    ipc.client.photos.rebuildSequences({ folderId }),
};
