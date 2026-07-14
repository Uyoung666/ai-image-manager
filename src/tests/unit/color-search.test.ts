import { describe, expect, it } from "vitest";
import {
  hydrateColorSearchResults,
  mergeColorSearchRanks,
} from "@/utils/color-search";

describe("color search result hydration", () => {
  it("preserves rank order and typed thumbnail fields", () => {
    const ranks = mergeColorSearchRanks(
      [
        { photoId: 2, distance: 25 },
        { photoId: 1, distance: 100 },
      ],
      [{ photoId: 3, distance: 144 }],
      3
    );
    const results = hydrateColorSearchResults(ranks, [
      { id: 1, thumbnailPath: "one.webp" },
      { id: 2, thumbnailPath: "two.webp" },
      { id: 3, thumbnailPath: "three.webp" },
    ]);

    expect(results.map((result) => result.id)).toEqual([2, 1, 3]);
    expect(results.map((result) => result.thumbnailPath)).toEqual([
      "two.webp",
      "one.webp",
      "three.webp",
    ]);
  });

  it("deduplicates supplemental vector results", () => {
    expect(
      mergeColorSearchRanks(
        [{ photoId: 1, distance: 10 }],
        [
          { photoId: 1, distance: 12 },
          { photoId: 2, distance: 20 },
        ],
        10
      )
    ).toEqual([
      { photoId: 1, distance: 10 },
      { photoId: 2, distance: 20 },
    ]);
  });
});
