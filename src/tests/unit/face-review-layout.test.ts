import { describe, expect, it } from "vitest";
import {
  getContainFrame,
  getFaceReviewOverlayPixelStyle,
  getFaceReviewOverlayStyle,
} from "@/components/face-candidate-dialog";
import { getFaceOverlayStyle } from "@/components/PhotoCard";
import { createPhotoGridItemStateVersion } from "@/components/PhotoGrid";

describe("face review media layout", () => {
  it("keeps a wide image inside a fixed preview stage", () => {
    expect(getContainFrame(1600, 400)).toEqual({
      height: "33.33333333333333%",
      left: "0%",
      top: "33.333333333333336%",
      width: "100%",
    });
  });

  it("uses CSS percentages so portrait previews fill the stage height", () => {
    const frame = getContainFrame(900, 1600);
    expect(frame.height).toBe("100%");
    expect(frame.top).toBe("0%");
    expect(Number.parseFloat(frame.width)).toBeCloseTo(42.19, 2);
    expect(Number.parseFloat(frame.left)).toBeCloseTo(28.91, 2);
  });

  it("maps face boxes inside the image wrapper", () => {
    const style = getFaceReviewOverlayStyle(
      { bboxHeight: 160, bboxWidth: 90, bboxX: 450, bboxY: 800 },
      900,
      1600
    );

    expect(Number.parseFloat(style.left)).toBeCloseTo(50, 2);
    expect(Number.parseFloat(style.top)).toBeCloseTo(50, 2);
    expect(Number.parseFloat(style.width)).toBeCloseTo(10, 2);
    expect(Number.parseFloat(style.height)).toBeCloseTo(10, 2);
  });

  it("maps face boxes to the measured image rectangle", () => {
    const style = getFaceReviewOverlayPixelStyle(
      { bboxHeight: 100, bboxWidth: 200, bboxX: 300, bboxY: 400 },
      1000,
      800,
      { height: 400, left: 80, top: 20, width: 800 }
    );

    expect(style).toEqual({
      height: "50px",
      left: "320px",
      top: "220px",
      width: "160px",
    });
  });

  it("clips invalid face boxes to the photo bounds", () => {
    const style = getFaceReviewOverlayStyle(
      { bboxHeight: 300, bboxWidth: 300, bboxX: -100, bboxY: -50 },
      1000,
      1000
    );

    expect(style.left).toBe("0%");
    expect(style.top).toBe("0%");
    expect(Number.parseFloat(style.width)).toBeCloseTo(20, 2);
    expect(Number.parseFloat(style.height)).toBeCloseTo(25, 2);
  });

  it("falls back safely when a face box contains non-finite values", () => {
    const style = getFaceReviewOverlayStyle(
      {
        bboxHeight: Number.NaN,
        bboxWidth: Number.POSITIVE_INFINITY,
        bboxX: Number.NaN,
        bboxY: 20,
      },
      1000,
      1000
    );

    expect(style.left).toBe("0%");
    expect(style.top).toBe("2%");
    expect(style.width).toBe("0%");
    expect(style.height).toBe("0%");
  });

  it("maps face boxes to the visible object-cover area", () => {
    const style = getFaceOverlayStyle(
      { height: 0.2, width: 0.2, x: 0.4, y: 0.4 },
      1600,
      900,
      1
    );
    expect(Number.parseFloat(String(style.left))).toBeCloseTo(32.22, 2);
    expect(style.top).toBe("40%");
    expect(Number.parseFloat(String(style.width))).toBeCloseTo(35.56, 2);
  });

  it("invalidates virtualized cards when face box visibility changes", () => {
    const selectedIds = new Set<number>();
    const overlays = new Map([
      [1, [{ height: 0.2, width: 0.2, x: 0.4, y: 0.4 }]],
    ]);
    const hidden = createPhotoGridItemStateVersion(
      undefined,
      overlays,
      false,
      selectedIds
    );
    const visible = createPhotoGridItemStateVersion(
      undefined,
      overlays,
      true,
      selectedIds
    );

    expect(hidden).not.toEqual(visible);
    expect(hidden.faceOverlaysVisible).toBe(false);
    expect(visible.faceOverlaysVisible).toBe(true);
  });
});
