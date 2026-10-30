import { ipc } from "@/ipc/manager";
import { trackCullWrite } from "@/utils/cull-write-state";

/** All renderer culling operations pass through this typed boundary. */
export const cullActions = {
  listTaskSummaries: (
    input: Parameters<typeof ipc.client.cull.listTaskSummaries>[0]
  ) => ipc.client.cull.listTaskSummaries(input),
  archiveSession: (
    input: Parameters<typeof ipc.client.cull.archiveSession>[0]
  ) => ipc.client.cull.archiveSession(input),
  getProjectResults: (
    input: Parameters<typeof ipc.client.cull.getProjectResults>[0]
  ) => ipc.client.cull.getProjectResults(input),
  getPhotoMedia: (input: Parameters<typeof ipc.client.cull.getPhotoMedia>[0]) =>
    ipc.client.cull.getPhotoMedia(input),
  getPhotoExif: (input: Parameters<typeof ipc.client.cull.getPhotoExif>[0]) =>
    ipc.client.cull.getPhotoExif(input),
  createSession: (input: Parameters<typeof ipc.client.cull.createSession>[0]) =>
    ipc.client.cull.createSession(input),
  startProjectSession: (
    input: Parameters<typeof ipc.client.cull.startProjectSession>[0]
  ) => ipc.client.cull.startProjectSession(input),
  listProjectSessions: (
    input: Parameters<typeof ipc.client.cull.listProjectSessions>[0]
  ) => ipc.client.cull.listProjectSessions(input),
  applyProjectPkTopN: (
    input: Parameters<typeof ipc.client.cull.applyProjectPkTopN>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.applyProjectPkTopN(input)
    ),
  listSessions: (input: Parameters<typeof ipc.client.cull.listSessions>[0]) =>
    ipc.client.cull.listSessions(input),
  getSession: (input: Parameters<typeof ipc.client.cull.getSession>[0]) =>
    ipc.client.cull.getSession(input),
  getSessionSummary: (
    input: Parameters<typeof ipc.client.cull.getSessionSummary>[0]
  ) => ipc.client.cull.getSessionSummary(input),
  getNextPair: (input: Parameters<typeof ipc.client.cull.getNextPair>[0]) =>
    ipc.client.cull.getNextPair(input),
  submitComparison: (
    input: Parameters<typeof ipc.client.cull.submitComparison>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.submitComparison(input)
    ),
  recordSkip: (input: Parameters<typeof ipc.client.cull.recordSkip>[0]) =>
    trackCullWrite(input.sessionId, () => ipc.client.cull.recordSkip(input)),
  updatePhotoStatus: (
    input: Parameters<typeof ipc.client.cull.updatePhotoStatus>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.updatePhotoStatus(input)
    ),
  batchUpdatePhotoStatus: (
    input: Parameters<typeof ipc.client.cull.batchUpdatePhotoStatus>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.batchUpdatePhotoStatus(input)
    ),
  skipSimilarPhotos: (
    input: Parameters<typeof ipc.client.cull.skipSimilarPhotos>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.skipSimilarPhotos(input)
    ),
  undoLastAction: (
    input: Parameters<typeof ipc.client.cull.undoLastAction>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.undoLastAction(input)
    ),
  completeSession: (
    input: Parameters<typeof ipc.client.cull.completeSession>[0]
  ) =>
    trackCullWrite(input.sessionId, () =>
      ipc.client.cull.completeSession(input)
    ),
  resumeSession: (input: Parameters<typeof ipc.client.cull.resumeSession>[0]) =>
    ipc.client.cull.resumeSession(input),
  deleteSession: (input: Parameters<typeof ipc.client.cull.deleteSession>[0]) =>
    ipc.client.cull.deleteSession(input),
  duplicateSession: (
    input: Parameters<typeof ipc.client.cull.duplicateSession>[0]
  ) => ipc.client.cull.duplicateSession(input),
  renameSession: (input: Parameters<typeof ipc.client.cull.renameSession>[0]) =>
    ipc.client.cull.renameSession(input),
  ensureDuelPreview: (
    input: Parameters<typeof ipc.client.cull.ensureDuelPreview>[0]
  ) => ipc.client.cull.ensureDuelPreview(input),
  addPhotosToSession: (
    input: Parameters<typeof ipc.client.cull.addPhotosToSession>[0]
  ) => ipc.client.cull.addPhotosToSession(input),
};
