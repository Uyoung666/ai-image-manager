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

export function isRawFile(filePath: string): boolean {
  return RAW_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/**
 * Extract embedded JPEG preview from a RAW file.
 * Tries JpgFromRaw (full-size) first, then PreviewImage fallback.
 * Returns the JPEG buffer, or null if extraction fails.
 */
export async function extractRawPreview(filePath: string): Promise<Buffer | null> {
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
    const buf = await exiftool.extractBinaryTagToBuffer(filePath, "PreviewImage");
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
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
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
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
  } catch {
    /* ignore */
  }
  return null;
}
