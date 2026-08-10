import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { exiftool } from "exiftool-vendored";

export const RAW_EXTENSIONS = new Set([
  ".cr2",
  ".cr3",
  ".nef",
  ".nrw",
  ".arw",
  ".srf",
  ".sr2",
  ".dng",
  ".orf",
  ".rw2",
  ".raf",
  ".pef",
  ".rwl",
  ".3fr",
  ".raw",
]);
const IMAGE_SIZE_RE = /^(\d+)x(\d+)$/;

export function isRawFile(filePath: string): boolean {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export interface RawDimensions {
  height: number;
  width: number;
}

function toPositiveInteger(value: unknown): number | null {
  const numberValue =
    typeof value === "number" ? value : Number.parseInt(String(value), 10);
  return Number.isInteger(numberValue) && numberValue > 0 ? numberValue : null;
}

/**
 * Read the RAW capture dimensions from ExifTool.
 *
 * RAW files often contain a much smaller embedded JPEG. Its dimensions must
 * never be used as the dimensions of the original capture.
 */
export async function readRawDimensions(
  filePath: string
): Promise<RawDimensions | null> {
  try {
    const tags = await exiftool.read(filePath, { readArgs: ["-fast"] });
    const width =
      toPositiveInteger(tags.ImageWidth) ??
      toPositiveInteger(tags.RawImageWidth) ??
      toPositiveInteger(tags.ExifImageWidth);
    const height =
      toPositiveInteger(tags.ImageHeight) ??
      toPositiveInteger(tags.RawImageHeight) ??
      toPositiveInteger(tags.ExifImageHeight);

    if (width && height) {
      return { height, width };
    }

    const imageSize = typeof tags.ImageSize === "string" ? tags.ImageSize : "";
    const sizeMatch = imageSize.match(IMAGE_SIZE_RE);
    if (sizeMatch) {
      const fallbackWidth = toPositiveInteger(sizeMatch[1]);
      const fallbackHeight = toPositiveInteger(sizeMatch[2]);
      if (fallbackWidth && fallbackHeight) {
        return { height: fallbackHeight, width: fallbackWidth };
      }
    }
  } catch {
    // ExifTool may not be able to read a damaged or unsupported RAW file.
  }

  return null;
}

/**
 * Extract embedded JPEG preview from a RAW file.
 * Tries JpgFromRaw (full-size) first, then PreviewImage fallback.
 * Returns the JPEG buffer, or null if extraction fails.
 */
export async function extractRawPreview(
  filePath: string
): Promise<Buffer | null> {
  // Try full-size JPEG embedded in the RAW (JpgFromRaw tag)
  try {
    const buf = await exiftool.extractBinaryTagToBuffer(filePath, "JpgFromRaw");
    if (buf && buf.length > 0) {
      return buf;
    }
  } catch {
    // Tag may not exist for this format
  }

  // Fallback: PreviewImage (smaller, but available on more formats)
  try {
    const buf = await exiftool.extractBinaryTagToBuffer(
      filePath,
      "PreviewImage"
    );
    if (buf && buf.length > 0) {
      return buf;
    }
  } catch {
    // Not available
  }

  // Last resort: extract using extractJpgFromRaw / extractPreview (file-based)
  const tmpFile = path.join(
    os.tmpdir(),
    `aim-raw-${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`
  );
  try {
    await exiftool.extractJpgFromRaw(filePath, tmpFile);
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
      const buf = fs.readFileSync(tmpFile);
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      return buf;
    }
  } catch {
    /* ignore */
  }

  try {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
    await exiftool.extractPreview(filePath, tmpFile);
    if (fs.existsSync(tmpFile) && fs.statSync(tmpFile).size > 0) {
      const buf = fs.readFileSync(tmpFile);
      try {
        fs.unlinkSync(tmpFile);
      } catch {
        /* ignore */
      }
      return buf;
    }
  } catch {
    /* ignore */
  }

  try {
    if (fs.existsSync(tmpFile)) {
      fs.unlinkSync(tmpFile);
    }
  } catch {
    /* ignore */
  }
  return null;
}
