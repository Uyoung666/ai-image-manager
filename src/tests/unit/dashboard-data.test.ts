import { describe, expect, it } from "vitest";
import {
  buildApertureChartData,
  buildFocalChartData,
  buildMonthlyChartData,
  buildRangeSearchParams,
  buildShootingGuidance,
  buildYearDrillParams,
  calculateCoverage,
  fillYearlyChartData,
  getDashboardTimeRange,
  getTopItems,
  mergeDashboardDrillParams,
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

  it("builds local half-open ranges for common presets", () => {
    const result = getDashboardTimeRange("year", new Date(2026, 6, 15, 12));
    expect(new Date(result.from ?? 0).toString()).toContain("Jan 01 2026");
    expect(new Date(result.toExclusive ?? 0).toString()).toContain(
      "Jul 16 2026"
    );
  });

  it("includes the custom end date by advancing to the next local day", () => {
    const result = getDashboardTimeRange(
      "custom",
      new Date(2026, 0, 1),
      "2026-02-01",
      "2026-02-28"
    );
    expect(new Date(result.from ?? 0).getDate()).toBe(1);
    expect(new Date(result.toExclusive ?? 0).getDate()).toBe(1);
    expect(new Date(result.toExclusive ?? 0).getMonth()).toBe(2);
  });

  it("fills missing years without smoothing over the gap", () => {
    expect(
      fillYearlyChartData([
        { year: "2023", count: 4 },
        { year: "2025", count: 7 },
      ])
    ).toEqual([
      { name: "2023", count: 4, year: 2023 },
      { name: "2024", count: 0, year: 2024 },
      { name: "2025", count: 7, year: 2025 },
    ]);
  });

  it("fills all twelve month preference buckets", () => {
    const result = buildMonthlyChartData([{ month: "02", count: 9 }], "en");
    expect(result).toHaveLength(12);
    expect(result[1].count).toBe(9);
    expect(result[1].month).toBe(2);
    expect(result.reduce((sum, item) => sum + item.count, 0)).toBe(9);
  });

  it("intersects a drilled year with the active dashboard range", () => {
    expect(
      buildYearDrillParams(2026, {
        from: new Date(2026, 2, 15).getTime(),
        toExclusive: new Date(2026, 8, 2).getTime(),
      })
    ).toEqual({
      dateFrom: "2026-03-15",
      dateTo: "2026-09-01",
    });
  });

  it("does not let the dashboard range overwrite an explicit drill range", () => {
    expect(
      mergeDashboardDrillParams(
        { dateFrom: "2026-03-15", dateTo: "2026-09-01" },
        {
          from: new Date(2026, 0, 1).getTime(),
          toExclusive: new Date(2027, 0, 1).getTime(),
        }
      )
    ).toMatchObject({
      dateFrom: "2026-03-15",
      dateTo: "2026-09-01",
    });
  });

  it("calculates bounded coverage and selects top items", () => {
    expect(calculateCoverage(3, 4)).toBe(75);
    expect(calculateCoverage(3, 0)).toBe(0);
    expect(getTopItems([{ count: 1 }, { count: 4 }, { count: 2 }], 2)).toEqual([
      { count: 4 },
      { count: 2 },
    ]);
  });

  it("builds readable guidance from dominant shooting habits", () => {
    expect(
      buildShootingGuidance({
        advancedExif: 20,
        apertureStats: [
          { aperture: 2.8, count: 30 },
          { aperture: 8, count: 4 },
        ],
        avgIso: 2000,
        focalStats: [
          { focalLength: "24", count: 40 },
          { focalLength: "85", count: 8 },
        ],
        totalPhotos: 100,
      }).map((item) => item.kind)
    ).toEqual(["wideAngle", "wideAperture", "highIso", "lowMetadataCoverage"]);
  });

  it("does not add warnings when metadata coverage and ISO are healthy", () => {
    expect(
      buildShootingGuidance({
        advancedExif: 90,
        apertureStats: [{ aperture: 5.6, count: 20 }],
        avgIso: 400,
        focalStats: [{ focalLength: "50", count: 20 }],
        totalPhotos: 100,
      })
    ).toEqual([{ kind: "standardFocal", value: 50 }]);
  });

  it("preserves dashboard date scope when drilling down", () => {
    const result = mergeDashboardDrillParams(
      { cameraModel: "Example" },
      {
        from: new Date(2026, 0, 1).getTime(),
        toExclusive: new Date(2026, 1, 1).getTime(),
      }
    );
    expect(result).toMatchObject({
      cameraModel: "Example",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });
  });
});
