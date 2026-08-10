import { describe, expect, it } from "vitest";
import { getFaceFocusedCoverStyle } from "@/utils/face-cover-style";

describe("face focused cover style", () => {
  it("centers and zooms the cover on a valid face bbox", () => {
    const style = getFaceFocusedCoverStyle(
      { x: 200, y: 400, width: 40, height: 80 },
      432,
      768
    );

    expect(style.objectPosition).toBe("50.92592592592593% 57.291666666666664%");
    expect(style.transformOrigin).toBe(style.objectPosition);
    expect(style.transform).toBe("scale(4)");
  });

  it("falls back safely for invalid or missing bbox data", () => {
    expect(getFaceFocusedCoverStyle(null, 432, 768)).toEqual({
      objectFit: "cover",
    });
    expect(
      getFaceFocusedCoverStyle(
        { x: Number.NaN, y: 0, width: 10, height: 10 },
        432,
        768
      )
    ).toEqual({ objectFit: "cover" });
  });

  it("clamps a bbox extending beyond the photo bounds", () => {
    const style = getFaceFocusedCoverStyle(
      { x: -20, y: -10, width: 100, height: 80 },
      100,
      100
    );
    expect(style.objectPosition).toBe("40% 35%");
  });
});
