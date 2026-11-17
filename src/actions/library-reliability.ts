import { ipc } from "@/ipc/manager";

export const libraryReliabilityActions = {
  getImportQueueStatus: () => ipc.client.photos.getImportQueueStatus({}),
  retrySourceUpdates: (folderId: number) =>
    ipc.client.photos.retryLibrarySourceUpdates({ folderId }),
  getUpdateState: () => ipc.client.photos.getAiStatus({ loadModel: false }),
  retryRelink: (taskId: string) =>
    ipc.client.photos.retryLibraryRelink({ taskId }),
  dismissTask: (taskId: string) =>
    ipc.client.photos.dismissLibraryTask({ taskId }),
  getAttention: () => ipc.client.photos.getLibraryAttention({}),
  getPhotos: (
    input: Parameters<typeof ipc.client.photos.getLibraryPhotos>[0]
  ) => ipc.client.photos.getLibraryPhotos(input),
  getMoveCandidates: (photoId: number) =>
    ipc.client.photos.getLibraryMoveCandidates({ photoId }),
  getActiveTask: () => ipc.client.photos.getActiveLibraryTask({}),
  beginRelink: (input: Parameters<typeof ipc.client.photos.beginRelink>[0]) =>
    ipc.client.photos.beginRelink(input),
  beginApplyRelink: (token: string, confirmedPhotoIds: number[]) =>
    ipc.client.photos.beginApplyRelink({ token, confirmedPhotoIds }),
  noteForegroundActivity: () =>
    ipc.client.photos.noteLibraryForegroundActivity({}),
  getHealth: (folderId?: number) =>
    ipc.client.photos.getLibraryHealth({ folderId }),
  reconcile: (
    input: Parameters<typeof ipc.client.photos.reconcileLibrary>[0]
  ) => ipc.client.photos.reconcileLibrary(input),
  getTask: (taskId: string, offset = 0) =>
    ipc.client.photos.getLibraryTask({ taskId, offset }),
  cancelTask: (taskId: string) =>
    ipc.client.photos.cancelLibraryTask({ taskId }),
  getRelinkInspection: (
    token: string,
    offset: number,
    status?: Parameters<
      typeof ipc.client.photos.getRelinkInspection
    >[0]["status"]
  ) => ipc.client.photos.getRelinkInspection({ token, offset, status }),
  inspectMissingRemoval: (photoIds: number[]) =>
    ipc.client.photos.inspectMissingRecordRemoval({ photoIds }),
  removeMissing: (token: string) =>
    ipc.client.photos.removeMissingRecords({ token }),
  retryRefresh: (photoIds: number[], mode?: "retry" | "preview" | "analysis") =>
    ipc.client.photos.retryPhotoRefresh({ photoIds, mode }),
};
