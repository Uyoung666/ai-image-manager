import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import {
  mapYuNetBoxToImage,
  normalizeImageInput,
} from "../../../scripts/face-image.mjs";

function createJpeg(
  width: number,
  height: number,
  orientation?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8
) {
  const pixels = Buffer.alloc(width * height * 3, 128);
  const pipeline = sharp(pixels, {
    raw: { channels: 3, height, width },
  }).jpeg({ quality: 100 });
  return orientation
    ? pipeline.withMetadata({ orientation }).toBuffer()
    : pipeline.toBuffer();
}

describe("face image normalization", () => {
  it.each([
    6, 8,
  ] as const)("uses original-file EXIF orientation %i when embedded preview has no orientation", async (orientation) => {
    const preview = await createJpeg(4, 2);
    const original = await createJpeg(4, 2, orientation);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "aim-face-"));
    const originalPath = path.join(tempDir, "original.jpg");

    try {
      await writeFile(originalPath, original);
      const normalized = await normalizeImageInput(preview, originalPath);

      expect(normalized.width).toBe(2);
      expect(normalized.height).toBe(4);
      expect(normalized.data).toHaveLength(2 * 4 * 3);
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  });

  it("clips YuNet boxes to the normalized image boundaries", () => {
    expect(
      mapYuNetBoxToImage({ h: 400, w: 500, x1: 500, y1: 300 }, 1000, 600, 640)
    ).toEqual({ height: 319, width: 219, x: 781, y: 281 });
  });

  it("discards boxes that do not intersect the image", () => {
    expect(
      mapYuNetBoxToImage({ h: 100, w: 100, x1: 700, y1: 700 }, 640, 640, 640)
    ).toBeNull();
  });
});
