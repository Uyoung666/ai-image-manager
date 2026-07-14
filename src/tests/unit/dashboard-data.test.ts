import { describe, expect, it } from "vitest";
import {
  buildApertureChartData,
  buildFocalChartData,
  buildRangeSearchParams,
} from "@/utils/dashboard-data";

describe("dashboard chart data", () => {
  it("selects the most-used focal lengths before sorting them for display", () => {
    const result = buildFocalChartData(
      [
        { focalLength: "6", count: 1 },
        { focalLength: "24", count: 8 },
        { focalLength: "35", count: 20 },
        { focalLength: "50", count: 30 },
        { focalLength: "85", count: 10 },
      ],
      3
    );

    expect(result.map((item) => item.name)).toEqual(["35mm", "50mm", "85mm"]);
    expect(result.map((item) => item.count)).toEqual([20, 30, 10]);
  });

  it("uses drill-down ranges matching the rounded focal-length bucket", () => {
    const [result] = buildFocalChartData([{ focalLength: "50", count: 4 }]);

    expect(result.focalMin).toBe(49.5);
    expect(result.focalMax).toBeCloseTo(50.499_999);
  });

  it("merges aperture values that resolve to the same standard stop", () => {
    const result = buildApertureChartData([
      { aperture: 1.8, count: 7 },
      { aperture: 1.9, count: 3 },
      { aperture: 2.8, count: 9 },
    ]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ name: "f/1.8", count: 10 });
    expect(Number(result[0].apertureMin)).toBeCloseTo(1.75);
    expect(Number(result[0].apertureMax)).toBeCloseTo(1.949_999);
  });

  it("selects aperture preferences by usage count", () => {
    const result = buildApertureChartData(
      [
        { aperture: 1.4, count: 1 },
        { aperture: 2.8, count: 30 },
        { aperture: 5.6, count: 20 },
      ],
      2
    );

    expect(result.map((item) => item.name)).toEqual(["f/2.8", "f/5.6"]);
  });

  it("keeps open-ended ISO and shutter ranges drillable", () => {
    expect(buildRangeSearchParams("iso", 1600)).toEqual({ isoMin: "1600" });
    expect(buildRangeSearchParams("iso", undefined, 200)).toEqual({
      isoMax: "200",
    });
    expect(buildRangeSearchParams("shutter", 0.0333)).toEqual({
      shutterMin: "0.0333",
    });
  });
});
