import { ipc } from "@/ipc/manager";

export const libraryReliabilityActions = {
  getIssues: (
    input: Parameters<typeof ipc.client.photos.getLibraryIssues>[0]
  ) => ipc.client.photos.getLibraryIssues(input),
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
  inspectPhotoRelink: (photoId: number) =>
    ipc.client.photos.inspectPhotoRelink({ photoId }),
  inspectFolderRelink: (folderId: number) =>
    ipc.client.photos.inspectFolderRelink({ folderId }),
  getRelinkInspection: (token: string, offset: number) =>
    ipc.client.photos.getRelinkInspection({ token, offset }),
  applyRelink: (token: string, confirmedPhotoIds: number[]) =>
    ipc.client.photos.applyLibraryRelink({ token, confirmedPhotoIds }),
  inspectMissingRemoval: (photoIds: number[]) =>
    ipc.client.photos.inspectMissingRecordRemoval({ photoIds }),
  removeMissing: (token: string) =>
    ipc.client.photos.removeMissingRecords({ token }),
  retryRefresh: (photoIds: number[]) =>
    ipc.client.photos.retryPhotoRefresh({ photoIds }),
};
