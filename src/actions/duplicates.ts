import { ipc } from "@/ipc/manager";

export const duplicateActions = {
  getScanProgress: () => ipc.client.photos.getDuplicateScanProgress(),
  cancelScan: () => ipc.client.photos.cancelDuplicateScan(),
  listCleanupBatches: () => ipc.client.photos.listDuplicateCleanupBatches(),
  dismissGroup: (groupKey: string, dismissed = true) =>
    ipc.client.photos.dismissDuplicates({ groupKey, dismissed }),
  getGroupPhotos: (input: {
    groupKey: string;
    limit?: number;
    offset?: number;
  }) => ipc.client.photos.getDuplicateGroupPhotos(input),
  getScan: (runId: string) => ipc.client.photos.getDuplicateScan({ runId }),
  scan: (forceRescan = false) =>
    ipc.client.photos.findDuplicates({ forceRescan }),
  startScan: (forceRescan = false) =>
    ipc.client.photos.startDuplicateScan({ forceRescan }),
  getSettings: () => ipc.client.settings.getDuplicateSettings(),
  updateSettings: (input: {
    expectedRevision?: string;
    preset: "strict" | "standard" | "loose";
  }) => ipc.client.settings.updateDuplicateSettings(input),
  updateReview: (input: {
    decisions: Array<{
      decision: "KEEP" | "DELETE" | "UNDECIDED";
      photoId: number;
    }>;
    expectedReviewRevision: number;
    groupKey: string;
    groupVersion: string;
    ignoreState?: "ACTIVE" | "IGNORED";
  }) => ipc.client.photos.updateDuplicateReview(input),
  applyKeepCount: (input: {
    count: number;
    expectedReviewRevision: number;
    groupKey: string;
    groupVersion: string;
  }) => ipc.client.photos.applyDuplicateKeepCount(input),
  cleanGroups: (
    groups: Array<{
      deletePhotoIds: number[];
      groupKey: string;
      keepPhotoIds: number[];
    }>
  ) => ipc.client.photos.cleanDuplicateGroups({ groups }),
  createCleanupPlan: (input: {
    groups: Array<{
      deletePhotoIds: number[];
      groupKey: string;
      groupVersion: string;
      keepPhotoIds: number[];
      matchType: "exact" | "similar";
      reviewRevision: number;
    }>;
  }) => ipc.client.photos.createDuplicateCleanupPlan(input),
  executeCleanupPlan: (planId: string) =>
    ipc.client.photos.executeDuplicateCleanupPlan({ planId }),
  restoreCleanupBatch: (batchId: string) =>
    ipc.client.photos.restoreDuplicateCleanupBatch({ batchId }),
};
