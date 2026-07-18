import sharp from "sharp";
import { vi } from "vitest";
import {
  applyExifOrientation,
  type ExifOrientation,
  getOrientedDimensions,
  resolveImageOrientation,
} from "@/services/image-orientation";

vi.mock("exifr", () => ({
  default: {
    orientation: vi.fn(async () => 6),
  },
}));

function createTaggedFixture(orientation: ExifOrientation): Promise<Buffer> {
  const pixels = Buffer.from([
    255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 0, 255, 0, 255, 0, 255, 255,
  ]);

  return sharp(pixels, {
    raw: { width: 3, height: 2, channels: 3 },
  })
    .jpeg({ chromaSubsampling: "4:4:4", quality: 100 })
    .withMetadata({ orientation })
    .toBuffer();
}

describe("image orientation", () => {
  it.each([
    1, 2, 3, 4, 5, 6, 7, 8,
  ] as ExifOrientation[])("matches Sharp auto-orient for EXIF orientation %i", async (orientation) => {
    const input = await createTaggedFixture(orientation);
    const expected = await sharp(input).autoOrient().raw().toBuffer({
      resolveWithObject: true,
    });
    const actual = await applyExifOrientation(sharp(input), orientation)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(actual.info.width).toBe(expected.info.width);
    expect(actual.info.height).toBe(expected.info.height);
    expect(actual.data.equals(expected.data)).toBe(true);
  });

  it("falls back to EXIF parsing when decoder metadata has no orientation", async () => {
    const input = await createTaggedFixture(6);
    const resolved = await resolveImageOrientation(input, {});
    expect(resolved).toBe(6);
  });

  it.each([
    [1, 400, 300],
    [4, 400, 300],
    [5, 300, 400],
    [6, 300, 400],
    [7, 300, 400],
    [8, 300, 400],
  ] as const)("computes display dimensions for orientation %i", (orientation, width, height) => {
    expect(getOrientedDimensions(400, 300, orientation)).toEqual({
      width,
      height,
    });
  });
});
