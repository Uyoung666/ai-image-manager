import { ipc } from "@/ipc/manager";

export const faceActions = {
  confirm: (faceVectorId: number, identityId: number) =>
    ipc.client.faces.reviewFace({ action: "assign", faceVectorId, identityId }),
  createIdentity: (name: string, faceVectorIds: number[]) =>
    ipc.client.faces.createFaceIdentity({ name, faceVectorIds }),
  deleteIdentity: (id: number) => ipc.client.faces.deleteFaceIdentity({ id }),
  getDetectionProgress: () => ipc.client.faces.getDetectionProgress({}),
  getIdentity: (id: number) => ipc.client.faces.getFaceIdentity({ id }),
  getScanScope: () => ipc.client.faces.getScanScope({}),
  hideIdentity: (id: number) => ipc.client.faces.hideFaceIdentity({ id }),
  listCandidates: (limit?: number) =>
    ipc.client.faces.listFaceCandidates(
      limit === undefined ? undefined : { limit }
    ),
  listReviewQueue: (input?: {
    category?:
      | "all"
      | "unmatched"
      | "low_confidence"
      | "removed_from_identity"
      | "ignored";
    limit?: number;
    status?: "pending" | "ignored";
    cursor?: string;
  }) => ipc.client.faces.listFaceReviewQueue(input),
  listPhotoFaces: (photoId: number) =>
    ipc.client.faces.listPhotoFaces({ photoId }),
  removeFromIdentity: (identityId: number, faceVectorId: number) =>
    ipc.client.faces.removeFaceFromIdentity({ identityId, faceVectorId }),
  listIdentities: () => ipc.client.faces.listFaceIdentities({}),
  listHiddenIdentities: () => ipc.client.faces.listHiddenFaceIdentities(),
  merge: (targetId: number, sourceIds: number[]) =>
    ipc.client.faces.mergeIdentities({ targetId, sourceIds }),
  recluster: () => ipc.client.faces.recluster({}),
  reset: () => ipc.client.faces.resetFaceData({}),
  reject: (faceVectorId: number) =>
    ipc.client.faces.reviewFace({ action: "reject", faceVectorId }),
  restoreRejected: (faceVectorId: number) =>
    ipc.client.faces.restoreRejectedFace({ id: faceVectorId }),
  restoreToIdentity: (identityId: number, faceVectorId: number) =>
    ipc.client.faces.restoreFaceToIdentity({ identityId, faceVectorId }),
  restoreHiddenIdentity: (id: number) =>
    ipc.client.faces.restoreHiddenFaceIdentity({ id }),
  setScanScope: (folderIds: number[]) =>
    ipc.client.faces.setScanScope({ folderIds }),
  startDetection: (rescan = false) =>
    ipc.client.faces.startFaceDetection({ rescan }),
  updateIdentity: (
    id: number,
    input: { name?: string; representativePhotoId?: number | null }
  ) => ipc.client.faces.updateFaceIdentity({ id, ...input }),
};
