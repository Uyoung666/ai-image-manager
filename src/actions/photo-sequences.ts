import { ipc } from "@/ipc/manager";

export const photoSequenceActions = {
  create: (input: { type: "burst" | "timelapse"; photoIds: number[] }) =>
    ipc.client.photos.createSequence(input),
  deleteManual: (id: number) => ipc.client.photos.deleteManualSequence({ id }),
  get: (id: number) => ipc.client.photos.getSequence({ id }),
  ignore: (photoIds: number[]) =>
    ipc.client.photos.ignoreSequencePhotos({ photoIds }),
  list: (input: { folderId?: number; photoIds?: number[] }) =>
    ipc.client.photos.listSequences(input),
  listSuggestions: (folderId?: number) =>
    ipc.client.photos.listSequenceSuggestions({ folderId }),
  merge: (sequenceIds: [number, number]) =>
    ipc.client.photos.mergeSequences({ sequenceIds }),
  rebuild: (folderId?: number, dryRun = false) =>
    ipc.client.photos.rebuildSequences({ folderId, dryRun }),
  restoreAutomatic: (id: number) =>
    ipc.client.photos.restoreAutomaticSequence({ id }),
  setRepresentative: (id: number, photoId: number) =>
    ipc.client.photos.setSequenceRepresentative({ id, photoId }),
  split: (id: number, position: number) =>
    ipc.client.photos.splitSequence({ id, position }),
  updateMembers: (id: number, photoIds: number[]) =>
    ipc.client.photos.updateSequenceMembers({ id, photoIds }),
};
