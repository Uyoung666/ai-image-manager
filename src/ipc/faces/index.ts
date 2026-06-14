import {
  cancelFaceDetection_h,
  createFaceIdentity,
  deleteFaceIdentity,
  getDetectionProgress,
  getFaceIdentity,
  listFaceIdentities,
  mergeIdentities,
  recluster,
  removeFaceFromIdentity,
  startFaceDetection,
  updateFaceIdentity,
} from "./handlers";

export const faces = {
  cancelFaceDetection: cancelFaceDetection_h,
  createFaceIdentity,
  deleteFaceIdentity,
  getDetectionProgress,
  getFaceIdentity,
  listFaceIdentities,
  mergeIdentities,
  recluster,
  removeFaceFromIdentity,
  startFaceDetection,
  updateFaceIdentity,
};
