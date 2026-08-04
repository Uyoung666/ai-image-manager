export type FaceReviewReason =
  | "ignored"
  | "low_confidence"
  | "removed_from_identity"
  | "unmatched";

export interface FaceCandidate {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
  bestIdentityId: number | null;
  bestIdentityName: string | null;
  detectionConfidence: number | null;
  faceIndex: number;
  id: number;
  identitySimilarity: number | null;
  photoHeight: number | null;
  photoId: number;
  photoPath: string;
  photoWidth: number | null;
  reason?: FaceReviewReason;
  sourceIdentityId?: number | null;
  sourceIdentityName?: string | null;
  status?: "ignored" | "pending";
  thumbnailPath: string | null;
}

const STAGE_ASPECT = 4 / 3;

export function getContainFrame(width: number, height: number) {
  const imageAspect = width / Math.max(height, 1);
  if (imageAspect > STAGE_ASPECT) {
    const frameHeight = (STAGE_ASPECT / imageAspect) * 100;
    return {
      height: `${frameHeight}%`,
      left: "0%",
      top: `${(100 - frameHeight) / 2}%`,
      width: "100%",
    };
  }
  const frameWidth = (imageAspect / STAGE_ASPECT) * 100;
  return {
    height: "100%",
    left: `${(100 - frameWidth) / 2}%`,
    top: "0%",
    width: `${frameWidth}%`,
  };
}
