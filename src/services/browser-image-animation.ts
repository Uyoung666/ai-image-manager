import { open } from "node:fs/promises";
import path from "node:path";

const PREFIX_BYTES = 64 * 1024;

/** Keep native playback when an animation-capable container isn't proven still. */
export async function needsNativePlayback(filePath: string): Promise<boolean> {
  const ext = path.extname(filePath).toLowerCase();
  if (!(ext === ".png" || ext === ".webp" || ext === ".avif")) {
    return false;
  }
  const handle = await open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(PREFIX_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bytes = buffer.subarray(0, bytesRead);
    if (ext === ".png") {
      return pngMayAnimate(bytes);
    }
    if (ext === ".webp") {
      if (bytes.length < 21 || bytes.toString("ascii", 8, 12) !== "WEBP") {
        return true;
      }
      const chunk = bytes.toString("ascii", 12, 16);
      return chunk === "VP8X"
        ? // biome-ignore lint/suspicious/noBitwiseOperators: VP8X uses bit 1 for its animation flag.
          (bytes[20] & 2) !== 0
        : chunk !== "VP8 " && chunk !== "VP8L";
    }
    if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") {
      return true;
    }
    const end = bytes.readUInt32BE(0);
    if (end < 16 || end > bytes.length) {
      return true;
    }
    if (bytes.toString("ascii", 8, 12) === "avis") {
      return true;
    }
    for (let offset = 16; offset + 4 <= end; offset += 4) {
      if (bytes.toString("ascii", offset, offset + 4) === "avis") {
        return true;
      }
    }
    return false;
  } finally {
    await handle.close();
  }
}

function pngMayAnimate(bytes: Buffer): boolean {
  for (let offset = 8; offset + 8 <= bytes.length; ) {
    const chunk = bytes.toString("ascii", offset + 4, offset + 8);
    if (chunk === "acTL") {
      return true;
    }
    if (chunk === "IDAT") {
      return false;
    }
    offset += 12 + bytes.readUInt32BE(offset);
  }
  return true;
}
