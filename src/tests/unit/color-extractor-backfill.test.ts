import { describe, expect, it } from "vitest";
import {
  aggregateFromStoredColors,
  computeColorDistribution,
  hexFromHue,
  invalidateColorCache,
  rgbFromHue,
} from "@/services/color-extractor";

describe("color extraction failure handling", () => {
  it("does not turn a batch of missing files into a cached successful result", async () => {
    invalidateColorCache();
    const photos = Array.from({ length: 12 }, (_, index) => ({
      path: `missing-${index}.png`,
      thumbnailPath: null,
    }));

    await expect(
      computeColorDistribution(photos, photos.length)
    ).resolves.toEqual(
      expect.objectContaining({
        globalPalette: [],
        sampled: 0,
        totalPhotos: photos.length,
      })
    );
  });

  it("counts a secondary palette color for hue drill-downs", () => {
    const primary = rgbFromHue(15);
    const secondary = rgbFromHue(195);
    const result = aggregateFromStoredColors([
      [
        {
          ...primary,
          hex: hexFromHue(15),
          hue: 15,
          lightness: 0.5,
          saturation: 0.7,
          weight: 0.6,
        },
        {
          ...secondary,
          hex: hexFromHue(195),
          hue: 195,
          lightness: 0.5,
          saturation: 0.7,
          weight: 0.4,
        },
      ],
    ]);

    expect(
      result.hueDistribution.find((bucket) => bucket.hex === hexFromHue(195))
        ?.count
    ).toBe(1);
  });
});
