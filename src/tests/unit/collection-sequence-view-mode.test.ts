import { describe, expect, it } from "vitest";
import {
  getSequenceMemberIds,
  shouldShowSequenceEmptyState,
} from "@/hooks/useCollectionSequences";

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

  it("treats a sequence with one matched member as sequence-owned content", () => {
    expect(
      getSequenceMemberIds([
        {
          endedAt: 2,
          frameCount: 4,
          id: 1,
          matchedCount: 1,
          matchedPhotoIds: [42],
          memberPhotoIds: [41, 42, 43, 44],
          photo: {} as never,
          representativePhotoId: 41,
          source: "auto",
          startedAt: 1,
          type: "burst",
        },
      ])
    ).toEqual([42]);
  });
});
