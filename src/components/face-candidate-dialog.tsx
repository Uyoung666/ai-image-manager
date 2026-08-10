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

export interface FaceReviewBox {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
}

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

function finitePositive(value: number, fallback: number) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function clampUnit(value: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(Math.max(value, 0), 1);
}

/**
 * Map a face box from photo pixels to the visible image area of the 4:3
 * review stage. The image itself is letterboxed, so the stage offset must be
 * included before drawing the overlay.
 */
export function getContainedFaceOverlayStyle(
  face: FaceReviewBox,
  photoWidth: number,
  photoHeight: number
) {
  const width = finitePositive(photoWidth, 1);
  const height = finitePositive(photoHeight, 1);
  const frame = getContainFrame(width, height);
  const frameWidth = Number.parseFloat(frame.width);
  const frameHeight = Number.parseFloat(frame.height);
  const frameLeft = Number.parseFloat(frame.left);
  const frameTop = Number.parseFloat(frame.top);
  const left = clampUnit(face.bboxX / width);
  const top = clampUnit(face.bboxY / height);
  const right = clampUnit((face.bboxX + face.bboxWidth) / width);
  const bottom = clampUnit((face.bboxY + face.bboxHeight) / height);

  return {
    height: `${Math.max(0, bottom - top) * frameHeight}%`,
    left: `${frameLeft + left * frameWidth}%`,
    top: `${frameTop + top * frameHeight}%`,
    width: `${Math.max(0, right - left) * frameWidth}%`,
  };
}

/** Map a face box to the image wrapper itself, without stage letterbox math. */
export function getFaceReviewOverlayStyle(
  face: FaceReviewBox,
  photoWidth: number,
  photoHeight: number
) {
  const width = finitePositive(photoWidth, 1);
  const height = finitePositive(photoHeight, 1);
  const left = clampUnit(face.bboxX / width);
  const top = clampUnit(face.bboxY / height);
  const right = clampUnit((face.bboxX + face.bboxWidth) / width);
  const bottom = clampUnit((face.bboxY + face.bboxHeight) / height);

  return {
    height: `${Math.max(0, bottom - top) * 100}%`,
    left: `${left * 100}%`,
    top: `${top * 100}%`,
    width: `${Math.max(0, right - left) * 100}%`,
  };
}
