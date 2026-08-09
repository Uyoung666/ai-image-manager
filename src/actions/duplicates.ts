import { ipc } from "@/ipc/manager";

export const duplicateActions = {
  dismissGroup: (groupKey: string) =>
    ipc.client.photos.dismissDuplicates({ groupKey }),
  getGroupPhotos: (input: {
    groupKey: string;
    limit?: number;
    offset?: number;
  }) => ipc.client.photos.getDuplicateGroupPhotos(input),
  scan: (forceRescan = false) =>
    ipc.client.photos.findDuplicates({ threshold: 8, forceRescan }),
  cleanGroups: (groups: Array<{ groupKey: string; keepPhotoId: number }>) =>
    ipc.client.photos.cleanDuplicateGroups({ groups }),
};
