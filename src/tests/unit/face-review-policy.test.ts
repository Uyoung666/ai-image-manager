import { describe, expect, it } from "vitest";
import {
  classifyFaceForReview,
  type FaceReviewClassificationInput,
} from "@/services/face-review-policy";

function classify(overrides: Partial<FaceReviewClassificationInput> = {}) {
  return classifyFaceForReview({
    confidence: 0.9,
    confidenceFilter: 0.85,
    decision: null,
    embedding: [0.1, 0.2],
    hasMember: false,
    isRejected: false,
    ...overrides,
  });
}

describe("face review policy", () => {
  it("keeps an unassigned high-confidence face pending when it was not matched", () => {
    expect(classify()).toEqual({ reason: "unmatched", status: "pending" });
  });

  it("keeps every detected low-confidence face with an embedding reviewable", () => {
    expect(classify({ confidence: 0.5 })).toEqual({
      reason: "low_confidence",
      status: "pending",
    });
    expect(classify({ confidence: null })).toEqual({
      reason: "unmatched",
      status: "pending",
    });
  });

  it("does not review assigned, ignored, or invalid faces as pending", () => {
    expect(classify({ hasMember: true })).toEqual({ status: "assigned" });
    expect(classify({ isRejected: true })).toEqual({
      reason: "ignored",
      status: "ignored",
    });
    expect(classify({ decision: "rejected" })).toEqual({
      reason: "ignored",
      status: "ignored",
    });
    expect(classify({ embedding: null })).toEqual({ status: "skipped" });
  });

  it("returns removed faces to pending without allowing auto-grouping to hide them", () => {
    expect(classify({ decision: "removed_from_identity" })).toEqual({
      reason: "removed_from_identity",
      status: "pending",
    });
  });
});
