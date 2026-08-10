export type FaceReviewReason =
  | "unmatched"
  | "low_confidence"
  | "removed_from_identity"
  | "ignored";

export type FaceReviewStatus = "assigned" | "ignored" | "pending" | "skipped";

export interface FaceReviewClassificationInput {
  confidence: number | null;
  confidenceFilter: number;
  decision?: "rejected" | "removed_from_identity" | null;
  embedding: number[] | null;
  hasMember: boolean;
  isRejected: boolean;
}

export interface FaceReviewClassification {
  reason?: FaceReviewReason;
  status: FaceReviewStatus;
}

/**
 * Keep the review queue definition in one place for both the queue and the
 * per-photo face status UI.
 *
 * Every persisted face with a valid embedding is reviewable unless it is
 * already assigned or explicitly ignored. The detector's own confidence
 * threshold decides which new faces are persisted; confidenceFilter only
 * controls automatic grouping and the explanatory review reason.
 */
export function classifyFaceForReview(
  input: FaceReviewClassificationInput
): FaceReviewClassification {
  if (input.isRejected || input.decision === "rejected") {
    return { reason: "ignored", status: "ignored" };
  }

  if (input.hasMember) {
    return { status: "assigned" };
  }

  if (!input.embedding) {
    return { status: "skipped" };
  }

  if (input.decision === "removed_from_identity") {
    return { reason: "removed_from_identity", status: "pending" };
  }

  return {
    reason:
      input.confidence !== null && input.confidence < input.confidenceFilter
        ? "low_confidence"
        : "unmatched",
    status: "pending",
  };
}
