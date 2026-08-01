/**
 * Face model configuration — single source of truth for the face pipeline.
 *
 * Two kinds:
 *   - "yunet-sface"   (default): YuNet detection (MIT) + SFace embedding
 *                      (Apache-2.0), 128-d, 5-point landmark alignment.
 *   - "ultraface-w600k" (legacy): UltraFace + w600k_r50 ArcFace (512-d, no
 *                      alignment). InsightFace weights are research-only, so
 *                      this kind is retained strictly as a rollback path.
 *
 * YuNet+SFace is the only normal runtime model. The legacy kind requires the
 * explicit `FACE_MODEL_ALLOW_RESEARCH_ONLY=1` opt-in in addition to
 * `FACE_MODEL_KIND=ultraface-w600k`; this keeps rollback tooling available
 * without leaving the research model on the normal application path.
 * The detection confidence / clustering thresholds here are calibration seeds;
 * the worker embeds its own copy of the detection constants (scripts/*.mjs
 * cannot import TS), so keep them in sync when recalibrating.
 */
import path from "node:path";

export type FaceModelKind = "yunet-sface" | "ultraface-w600k";

export interface FaceModelConfig {
  clustering: {
    /** Cosine-similarity threshold for assigning a face to an identity centroid. */
    threshold: number;
    /** Minimum detection confidence for a face to participate in clustering. */
    confidenceFilter: number;
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

const FACE_MODEL_CONFIGS: Record<FaceModelKind, FaceModelConfig> = {
  "yunet-sface": {
    kind: "yunet-sface",
    displayName: "YuNet + SFace",
    detection: {
      fileName: "face_detection_yunet_2023mar.onnx",
      inputSizeW: 640,
      inputSizeH: 640,
      // OpenCV's demo uses 0.9. Open Images validation showed that 0.5
      // produces too many non-face detections in photo archives; 0.85 is the
      // precision-first operating point retained for this application.
      confidenceThreshold: 0.85,
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
    },
    modelFiles: [
      "face_detection_yunet_2023mar.onnx",
      "face_recognition_sface_2021dec.onnx",
    ],
  },
  "ultraface-w600k": {
    kind: "ultraface-w600k",
    displayName: "UltraFace + ArcFace (legacy)",
    detection: {
      fileName: "ultraface-320.onnx",
      inputSizeW: 320,
      inputSizeH: 240,
      confidenceThreshold: 0.85,
      nmsIoU: 0.3,
      maxFaces: 20,
      minFaceSize: 40,
    },
    recognition: {
      fileName: "w600k_r50.onnx",
      inputSize: 112,
      vectorDimensions: 512,
      useLandmarkAlign: false,
    },
    clustering: {
      threshold: 0.55,
      confidenceFilter: 0.88,
    },
    modelFiles: ["ultraface-320.onnx", "w600k_r50.onnx"],
  },
};

export function getActiveFaceModel(): FaceModelConfig {
  const requested = process.env.FACE_MODEL_KIND?.trim().toLowerCase();
  const researchOptIn =
    process.env.FACE_MODEL_ALLOW_RESEARCH_ONLY?.trim() === "1";
  return requested === "ultraface-w600k" && researchOptIn
    ? FACE_MODEL_CONFIGS["ultraface-w600k"]
    : FACE_MODEL_CONFIGS["yunet-sface"];
}

export function getFaceModelFile(modelsRoot: string, fileName: string): string {
  return path.join(modelsRoot, "face", fileName);
}
