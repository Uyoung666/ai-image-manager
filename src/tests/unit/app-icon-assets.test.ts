// @vitest-environment node
import fs from "node:fs";
import sharp from "sharp";
import { describe, expect, it } from "vitest";

describe("application branding artifacts", () => {
  it("ships decodable transparent PNGs at every supported size", async () => {
    for (const size of [16, 20, 24, 32, 40, 48, 64, 128, 180, 256, 512, 1024]) {
      const file = `assets/icons/icon-${size}.png`;
      const metadata = await sharp(file).metadata();
      expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([
        size,
        size,
        true,
      ]);
      const { data } = await sharp(file)
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      // Lanczos downsampling can introduce a one-step alpha fringe.
      expect(data[3]).toBeLessThanOrEqual(2);
    }
  });

  it("includes small DPI sizes and the 256px Explorer icon in the ICO", () => {
    const ico = fs.readFileSync("assets/icon.ico");
    expect(ico.readUInt16LE(2)).toBe(1);
    const sizes = Array.from({ length: ico.readUInt16LE(4) }, (_, index) => {
      const offset = 6 + index * 16;
      const size = ico[offset] || 256;
      expect(ico[offset + 1] || 256).toBe(size);
      expect(
        ico.readUInt32LE(offset + 12) + ico.readUInt32LE(offset + 8)
      ).toBeLessThanOrEqual(ico.length);
      return size;
    });
    expect(sizes).toEqual([16, 20, 24, 32, 40, 48, 64, 128, 256]);
  });

  it("ships both MSI backgrounds and a static Squirrel waiting image", async () => {
    for (const [file, width, height] of [
      ["wix-dialog.jpg", 493, 312],
      ["wix-banner.jpg", 493, 58],
      ["squirrel-loading.gif", 268, 167],
    ] as const) {
      const metadata = await sharp(`assets/installers/${file}`).metadata();
      expect([metadata.width, metadata.height]).toEqual([width, height]);
      expect(metadata.pages ?? 1).toBe(1);
    }
  });
});
