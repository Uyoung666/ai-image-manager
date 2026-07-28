import { describe, expect, it } from "vitest";
import {
  getStaleSequenceVisualPairIds,
  isSameSequenceVisualPair,
} from "@/ipc/photos/handlers/stats";

describe("duplicate sequence filter", () => {
  const sequenceByPhoto = new Map([
    [1, 10],
    [2, 10],
    [3, 20],
  ]);

  it("excludes visual matches within the same sequence", () => {
    expect(
      isSameSequenceVisualPair(1, 2, "clip_confirmed", sequenceByPhoto)
    ).toBe(true);
  });

  it("keeps exact copies even within the same sequence", () => {
    expect(isSameSequenceVisualPair(1, 2, "exact", sequenceByPhoto)).toBe(
      false
    );
  });

  it("keeps visual matches across sequences and outside sequences", () => {
    expect(isSameSequenceVisualPair(1, 3, "phash", sequenceByPhoto)).toBe(
      false
    );
    expect(isSameSequenceVisualPair(1, 99, "phash", sequenceByPhoto)).toBe(
      false
    );
  });

  it("removes only cached visual pairs within the same sequence", () => {
    expect(
      getStaleSequenceVisualPairIds(
        [
          { id: 1, photoAId: 1, photoBId: 2, matchType: "clip_confirmed" },
          { id: 2, photoAId: 1, photoBId: 2, matchType: "exact" },
          { id: 3, photoAId: 1, photoBId: 3, matchType: "phash" },
        ],
        sequenceByPhoto
      )
    ).toEqual([1]);
  });
});
