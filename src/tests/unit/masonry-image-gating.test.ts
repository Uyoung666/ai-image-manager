import { describe, expect, it } from "vitest";
import {
  getMasonryImageRequests,
  shouldRenderItemImage,
  shouldUpdateScrollRenderTop,
} from "@/components/MasonryGrid";

describe("masonry image gating", () => {
  it("promotes newly exposed small cards below the usual scroll render step", () => {
    const viewport = {
      positions: [
        { top: 0, left: 0, width: 140, height: 40 },
        { top: 70, left: 0, width: 140, height: 40 },
      ],
      visibilityIndex: [40, 110],
      height: 60,
    };
    expect(shouldUpdateScrollRenderTop(5, 0, viewport)).toBe(false);
    expect(shouldUpdateScrollRenderTop(15, 0, viewport)).toBe(true);
  });
  it("keeps every visible card and only twelve nearby offscreen candidates", () => {
    const candidates = Array.from({ length: 120 }, (_, id) => ({
      id,
      style: { top: Math.floor(id / 8) * 100, height: 90 },
    }));
    const requested = getMasonryImageRequests(candidates, 500, 300, 1);
    const visible = candidates.filter(
      (item) => item.style.top + 90 >= 500 && item.style.top <= 800
    );
    expect(visible.every((item) => requested.has(item.id))).toBe(true);
    expect(requested.size - visible.length).toBe(12);
    expect(requested.has(72)).toBe(true);
    expect(requested.has(0)).toBe(false);
    const reverse = getMasonryImageRequests(candidates, 500, 300, -1);
    expect(reverse.has(32)).toBe(true);
  });
  it("renders images near the viewport", () => {
    expect(shouldRenderItemImage({ top: 1200, height: 200 }, 1000, 600)).toBe(
      true
    );
  });

  it("skips image nodes for far overscan items", () => {
    expect(shouldRenderItemImage({ top: 2600, height: 200 }, 1000, 600)).toBe(
      false
    );
  });

  it("only updates render scrollTop after crossing the render step", () => {
    expect(shouldUpdateScrollRenderTop(95, 0)).toBe(false);
    expect(shouldUpdateScrollRenderTop(96, 0)).toBe(true);
    expect(shouldUpdateScrollRenderTop(400, 500)).toBe(true);
  });
});
