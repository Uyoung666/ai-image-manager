import { describe, expect, it } from "vitest";
import {
  binarySearchStart,
  binarySearchVisibilityStart,
  buildMasonryVisibilityIndex,
} from "@/utils/masonry-utils";

describe("binarySearchStart", () => {
  it("should return 0 for empty array", () => {
    expect(binarySearchStart([], 0)).toBe(0);
    expect(binarySearchStart([], 100)).toBe(0);
  });

  it("should return 0 when threshold is 0", () => {
    const positions = [
      { top: 0, height: 100 },
      { top: 100, height: 200 },
    ];
    expect(binarySearchStart(positions, 0)).toBe(0);
  });

  it("should return the index of first element crossing threshold", () => {
    const positions = [
      { top: 0, height: 100 },
      { top: 100, height: 200 },
      { top: 300, height: 150 },
    ];
    // threshold=50: element 0 bottom=100 >= 50 -> index 0
    expect(binarySearchStart(positions, 50)).toBe(0);
    // threshold=100: element 0 bottom=100 >= 100 -> index 0
    expect(binarySearchStart(positions, 100)).toBe(0);
    // threshold=101: element 0 bottom=100 < 101, element 1 bottom=300 >=101 -> index 1
    expect(binarySearchStart(positions, 101)).toBe(1);
    // threshold=300: element 1 bottom=300 >= 300 -> index 1
    expect(binarySearchStart(positions, 300)).toBe(1);
    // threshold=301: element 1 bottom=300 < 301, element 2 bottom=450 >=301 -> index 2
    expect(binarySearchStart(positions, 301)).toBe(2);
  });

  it("should work with uniform heights", () => {
    const positions = Array.from({ length: 100 }, (_, i) => ({
      top: i * 50,
      height: 50,
    }));
    expect(binarySearchStart(positions, 0)).toBe(0);
    // threshold=49: element 0 bottom=50 >= 49 -> index 0
    expect(binarySearchStart(positions, 49)).toBe(0);
    // threshold=50: element 0 bottom=50 >= 50 -> index 0
    expect(binarySearchStart(positions, 50)).toBe(0);
    // threshold=51: element 0 bottom=50 < 51, element 1 bottom=100 >=51 -> index 1
    expect(binarySearchStart(positions, 51)).toBe(1);
    // threshold=250: element 4 bottom=250 >= 250 -> index 4
    // (positions[4] = {top:200, height:50}, bottom=250 >= 250)
    expect(binarySearchStart(positions, 250)).toBe(4);
    // threshold=251: element 4 bottom=250 < 251, element 5 bottom=300 >=251 -> index 5
    expect(binarySearchStart(positions, 251)).toBe(5);
    // threshold=5000: element 99 bottom=5000 >= 5000 -> index 99
    expect(binarySearchStart(positions, 5000)).toBe(99);
    // threshold=5001: beyond all elements -> index 100
    expect(binarySearchStart(positions, 5001)).toBe(100);
  });

  it("should handle threshold beyond all elements", () => {
    const positions = [
      { top: 0, height: 100 },
      { top: 100, height: 100 },
    ];
    // All elements end at 200, threshold=200 means element 1 (100+100=200 >= 200) -> 1
    expect(binarySearchStart(positions, 200)).toBe(1);
    // threshold=201 means nothing crosses -> returns 2 (positions.length)
    expect(binarySearchStart(positions, 201)).toBe(2);
  });

  it("should handle single element array", () => {
    const positions = [{ top: 10, height: 50 }];
    expect(binarySearchStart(positions, 0)).toBe(0);
    expect(binarySearchStart(positions, 30)).toBe(0);
    expect(binarySearchStart(positions, 61)).toBe(1);
  });
});

describe("masonry visibility index", () => {
  it("stays monotonic when item bottoms are not monotonic", () => {
    const positions = [
      { top: 0, height: 500 },
      { top: 0, height: 100 },
      { top: 110, height: 100 },
      { top: 220, height: 100 },
      { top: 330, height: 100 },
    ];
    const index = buildMasonryVisibilityIndex(positions);

    expect(index).toEqual([500, 500, 500, 500, 500]);
    expect(binarySearchVisibilityStart(index, 400)).toBe(0);
    expect(binarySearchVisibilityStart(index, 501)).toBe(positions.length);
  });

  it("extends an existing index for paginated layouts", () => {
    const first = buildMasonryVisibilityIndex([{ top: 0, height: 100 }]);
    const next = buildMasonryVisibilityIndex(
      [
        { top: 110, height: 80 },
        { top: 200, height: 120 },
      ],
      first
    );

    expect(next).toEqual([100, 190, 320]);
    expect(first).toEqual([100]);
  });
});
