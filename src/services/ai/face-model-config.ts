/**
 * Face model configuration — single source of truth for the face pipeline.
 *
 * YuNet detection (MIT) + SFace embedding (Apache-2.0), 128-d, with
 * 5-point landmark alignment. This is the only product face runtime.
 * The detection confidence / clustering thresholds here are calibration seeds;
 * the worker embeds its own copy of the detection constants (scripts/*.mjs
 * cannot import TS), so keep them in sync when recalibrating.
 */
import path from "node:path";

export type FaceModelKind = "yunet-sface";

export interface FaceModelConfig {
  clustering: {
    /** Cosine-similarity threshold for assigning a face to an identity centroid. */
    threshold: number;
    /** Minimum detection confidence for a face to participate in clustering. */
    confidenceFilter: number;
    /** Minimum detection confidence retained for manual review. */
    reviewConfidenceFloor: number;
  };
  detection: {
    fileName: string;
    inputSizeW: number;
    inputSizeH: number;
    confidenceThreshold: number;
    nmsIoU: number;
    maxFaces: number;
    minFaceSize: number;
  };
  displayName: string;
  kind: FaceModelKind;
  modelFiles: string[];
  recognition: {
    fileName: string;
    inputSize: number;
    vectorDimensions: number;
    useLandmarkAlign: boolean;
  };
}

const ACTIVE_FACE_MODEL: FaceModelConfig = {
  kind: "yunet-sface",
  displayName: "YuNet + SFace",
  detection: {
    fileName: "face_detection_yunet_2023mar.onnx",
    inputSizeW: 640,
    inputSizeH: 640,
    // Retain candidates at 0.5 so low-confidence detections can be reviewed;
    // automatic grouping remains protected by clustering.confidenceFilter.
    confidenceThreshold: 0.5,
    nmsIoU: 0.3,
    maxFaces: 20,
    minFaceSize: 40,
  },
  recognition: {
    fileName: "face_recognition_sface_2021dec.onnx",
    inputSize: 112,
    vectorDimensions: 128,
    useLandmarkAlign: true,
  },
  clustering: {
    threshold: 0.363, // SFace official cosine threshold (calibration seed)
    // Do not let low-confidence detector candidates create identities.
    confidenceFilter: 0.85,
    // Keep lower-confidence detections for the review queue.
    reviewConfidenceFloor: 0.5,
  },
  modelFiles: [
    "face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx",
  ],
};

export function getActiveFaceModel(): FaceModelConfig {
  return ACTIVE_FACE_MODEL;
}

export function getFaceModelFile(modelsRoot: string, fileName: string): string {
  return path.join(modelsRoot, "face", fileName);
}
