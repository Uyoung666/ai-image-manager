import { describe, expect, it } from "vitest";
import {
  computeColorDistribution,
  invalidateColorCache,
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
});
