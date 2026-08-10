import { describe, expect, it, vi } from "vitest";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));

vi.mock("exiftool-vendored", () => ({
  exiftool: {
    extractBinaryTagToBuffer: vi.fn(),
    extractJpgFromRaw: vi.fn(),
    extractPreview: vi.fn(),
    read,
  },
}));

import { readRawDimensions } from "../../services/raw-preview";

describe("readRawDimensions", () => {
  it("uses ExifTool capture dimensions instead of embedded preview dimensions", async () => {
    read.mockResolvedValue({
      ImageHeight: 4000,
      ImageWidth: 6000,
      PreviewImageHeight: 1080,
      PreviewImageWidth: 1920,
    });

    await expect(readRawDimensions("D:/photos/IMG_0001.ARW")).resolves.toEqual({
      height: 4000,
      width: 6000,
    });
    expect(read).toHaveBeenCalledWith("D:/photos/IMG_0001.ARW", {
      readArgs: ["-fast"],
    });
  });

  it("falls back to ExifTool ImageSize when individual dimensions are absent", async () => {
    read.mockResolvedValue({ ImageSize: "6240x4160" });

    await expect(readRawDimensions("D:/photos/IMG_0002.NEF")).resolves.toEqual({
      height: 4160,
      width: 6240,
    });
  });

  it("returns null when ExifTool has no capture dimensions", async () => {
    read.mockResolvedValue({
      PreviewImageWidth: 1920,
      PreviewImageHeight: 1080,
    });

    await expect(
      readRawDimensions("D:/photos/IMG_0003.CR3")
    ).resolves.toBeNull();
  });
});
