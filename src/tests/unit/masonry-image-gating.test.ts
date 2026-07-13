import { describe, expect, it } from "vitest";
import {
  shouldRenderItemImage,
  shouldUpdateScrollRenderTop,
} from "@/components/MasonryGrid";

describe("masonry image gating", () => {
  it("renders images near the viewport", () => {
    expect(
      shouldRenderItemImage(
        { top: 1200, height: 200 },
        1000,
        600
      )
    ).toBe(true);
  });

  it("skips image nodes for far overscan items", () => {
    expect(
      shouldRenderItemImage(
        { top: 2600, height: 200 },
        1000,
        600
      )
    ).toBe(false);
  });

  it("only updates render scrollTop after crossing the render step", () => {
    expect(shouldUpdateScrollRenderTop(95, 0)).toBe(false);
    expect(shouldUpdateScrollRenderTop(96, 0)).toBe(true);
    expect(shouldUpdateScrollRenderTop(400, 500)).toBe(true);
  });
});
