import { describe, expect, it } from "vitest";
import {
  COLOR_MATCH_MAX_DISTANCE_SQUARED,
  colorDistanceToMatchScore,
  hydrateColorSearchResults,
  mergeColorSearchRanks,
} from "@/utils/color-search";

describe("color search result hydration", () => {
  it("preserves rank order and typed thumbnail fields", () => {
    const ranks = mergeColorSearchRanks(
      [
        { photoId: 2, distanceSquared: 25 },
        { photoId: 1, distanceSquared: 100 },
      ],
      [{ photoId: 3, distanceSquared: 144 }],
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
    expect(results.map((result) => result.match)).toEqual([
      { kind: "color", score: 0.95 },
      { kind: "color", score: 0.9 },
      { kind: "color", score: 0.88 },
    ]);
  });

  it("deduplicates supplemental vector results", () => {
    expect(
      mergeColorSearchRanks(
        [{ photoId: 1, distanceSquared: 10 }],
        [
          { photoId: 1, distanceSquared: 12 },
          { photoId: 2, distanceSquared: 20 },
        ],
        10
      )
    ).toEqual([
      { photoId: 1, distanceSquared: 10 },
      { photoId: 2, distanceSquared: 20 },
    ]);
  });

  it("normalizes squared RGB distance against the search boundary", () => {
    expect(colorDistanceToMatchScore(0)).toBe(1);
    expect(colorDistanceToMatchScore(50 * 50)).toBe(0.5);
    expect(colorDistanceToMatchScore(COLOR_MATCH_MAX_DISTANCE_SQUARED)).toBe(0);
  });
});
