import { describe, expect, it } from "vitest";
import { shouldShowSequenceEmptyState } from "@/hooks/useCollectionSequences";

describe("collection sequence view mode", () => {
  it("shows an empty state when the loaded collection has no sequences", () => {
    expect(
      shouldShowSequenceEmptyState({
        mode: "sequences",
        sequenceCount: 0,
        sequencesLoaded: true,
      })
    ).toBe(true);
  });

  it("does not hide photos while sequences are still loading", () => {
    expect(
      shouldShowSequenceEmptyState({
        mode: "sequences",
        sequenceCount: 0,
        sequencesLoaded: false,
      })
    ).toBe(false);
  });

  it("keeps sequence mode when sequences are available", () => {
    expect(
      shouldShowSequenceEmptyState({
        mode: "sequences",
        sequenceCount: 2,
        sequencesLoaded: true,
      })
    ).toBe(false);
  });
});
