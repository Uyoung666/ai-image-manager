import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createImageSearchPreview } from "@/services/image-search-preview";

const JPEG_DATA_URL_PATTERN = /^data:image\/jpeg;base64,/;

const { extractRawPreview } = vi.hoisted(() => ({
  extractRawPreview: vi.fn<() => Promise<Buffer | null>>(),
}));

vi.mock("@/services/raw-preview", () => ({
  extractRawPreview,
  isRawFile: (filePath: string) => filePath.toLowerCase().endsWith(".dng"),
}));

describe("image-search preview", () => {
  let jpegBuffer: Buffer;
  let tempDir: string;
  let jpegPath: string;

  beforeAll(async () => {
    tempDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "aim-image-search-preview-")
    );
    jpegPath = path.join(tempDir, "reference.jpg");
    jpegBuffer = await sharp({
      create: {
        background: { alpha: 1, b: 40, g: 80, r: 120 },
        channels: 4,
        height: 160,
        width: 240,
      },
    })
      .jpeg()
      .toBuffer();
    await fs.promises.writeFile(jpegPath, jpegBuffer);
  });

  afterAll(async () => {
    await fs.promises.rm(tempDir, { force: true, recursive: true });
  });

  it("returns a bounded JPEG data URL for a regular image", async () => {
    const result = await createImageSearchPreview(jpegPath);

    expect(result.exists).toBe(true);
    expect(result.dataUrl).toMatch(JPEG_DATA_URL_PATTERN);
    const output = Buffer.from(result.dataUrl?.split(",")[1] ?? "", "base64");
    const metadata = await sharp(output).metadata();
    expect(metadata.width).toBeLessThanOrEqual(96);
    expect(metadata.height).toBeLessThanOrEqual(96);
  });

  it("uses the extracted preview for RAW references", async () => {
    const rawPath = path.join(tempDir, "reference.dng");
    await fs.promises.writeFile(rawPath, Buffer.from("raw-placeholder"));
    extractRawPreview.mockResolvedValueOnce(jpegBuffer);

    const result = await createImageSearchPreview(rawPath);

    expect(extractRawPreview).toHaveBeenCalledWith(rawPath);
    expect(result).toMatchObject({ exists: true });
    expect(result.dataUrl).toMatch(JPEG_DATA_URL_PATTERN);
  });

  it("reports a missing source without exposing file contents", async () => {
    await expect(
      createImageSearchPreview(path.join(tempDir, "missing.jpg"))
    ).resolves.toEqual({ dataUrl: null, exists: false });
  });
});
