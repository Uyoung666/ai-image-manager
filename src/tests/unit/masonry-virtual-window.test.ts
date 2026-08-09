import { describe, expect, it } from "vitest";
import type { MasonryItem } from "@/hooks/useMasonryLayout";
import {
  clampDynamicOverscanPx,
  estimateOverscanPx,
  getVelocityOverscanMultiplier,
  getVisibleMasonryHeaders,
  getVisibleMasonryItems,
} from "@/hooks/useMasonryVirtualWindow";
import { buildMasonryVisibilityIndex } from "@/utils/masonry-utils";

function makePositions(count: number): MasonryItem[] {
  return Array.from({ length: count }, (_, i) => ({
    top: i * 100,
    left: (i % 3) * 110,
    width: 100,
    height: 90,
  }));
}

function makeSixColumnPositions(count: number): MasonryItem[] {
  const columnCount = 6;
  const itemSize = 220;
  const gap = 8;
  return Array.from({ length: count }, (_, i) => ({
    top: Math.floor(i / columnCount) * (itemSize + gap),
    left: (i % columnCount) * (itemSize + gap),
    width: itemSize,
    height: itemSize,
  }));
}

describe("masonry virtual window helpers", () => {
  it("estimates overscan from average item height for small lists", () => {
    const positions = makePositions(4);
    expect(estimateOverscanPx(positions, 2, 3)).toBe(180);
  });

  it("uses sampled average for larger lists", () => {
    const positions = makePositions(120);
    expect(estimateOverscanPx(positions, 3, 3)).toBe(270);
  });

  it("maps scroll velocity to three overscan tiers", () => {
    expect(getVelocityOverscanMultiplier(0)).toBe(1);
    expect(getVelocityOverscanMultiplier(60)).toBe(2);
    expect(getVelocityOverscanMultiplier(180)).toBe(3);
  });

  it("clamps dynamic overscan by viewport height", () => {
    expect(clampDynamicOverscanPx(500, 180, 300)).toBe(600);
    expect(clampDynamicOverscanPx(500, 180, 0)).toBe(1500);
  });

  it("caps very-fast six-column windows for large galleries", () => {
    const viewportHeight = 900;
    const rowStride = 228;
    const peakMountedCounts = [200, 300, 1600].map((count) => {
      const positions = makeSixColumnPositions(count);
      const visibilityIndex = buildMasonryVisibilityIndex(positions);
      const overscanPx = estimateOverscanPx(positions, 5, 6);
      const velocityOverscanPx = clampDynamicOverscanPx(
        overscanPx,
        180,
        viewportHeight
      );
      const lastPosition = positions.at(-1);
      if (!lastPosition) {
        return 0;
      }
      const totalHeight = lastPosition.top + lastPosition.height;
      const maxScrollTop = Math.max(0, totalHeight - viewportHeight);
      let peakMounted = 0;

      for (
        let scrollTop = 0;
        scrollTop <= maxScrollTop;
        scrollTop += rowStride
      ) {
        peakMounted = Math.max(
          peakMounted,
          getVisibleMasonryItems(
            positions,
            scrollTop,
            viewportHeight,
            velocityOverscanPx,
            visibilityIndex
          ).length
        );
      }

      return peakMounted;
    });

    expect(Math.max(...peakMountedCounts)).toBeLessThanOrEqual(132);
    expect(peakMountedCounts[0]).toBeLessThan(200);
  });

  it("returns visible items with overscan", () => {
    const visible = getVisibleMasonryItems(makePositions(10), 250, 200, 50);
    expect(visible.map((item) => item.index)).toEqual([2, 3, 4, 5]);
    expect(visible[0].style).toMatchObject({
      position: "absolute",
      top: 200,
      width: 100,
    });
  });

  it("keeps a tall earlier card that still intersects the viewport", () => {
    const positions: MasonryItem[] = [
      { top: 0, left: 0, width: 100, height: 500 },
      { top: 0, left: 110, width: 100, height: 100 },
      { top: 110, left: 110, width: 100, height: 100 },
      { top: 220, left: 110, width: 100, height: 100 },
      { top: 330, left: 110, width: 100, height: 100 },
    ];

    expect(
      getVisibleMasonryItems(positions, 400, 50, 0).map((item) => item.index)
    ).toEqual([0, 4]);
  });

  it("returns visible headers with header height included", () => {
    const headers = [
      { label: "一月", top: 0 },
      { label: "二月", top: 500 },
      { label: "三月", top: 1000 },
    ];
    expect(
      getVisibleMasonryHeaders(headers, 470, 100, 0).map((h) => h.label)
    ).toEqual(["二月"]);
  });
});
