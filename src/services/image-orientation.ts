import exifr from "exifr";
import type { Metadata, Sharp } from "sharp";

export type ExifOrientation = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;

export interface OrientedDimensions {
  height: number;
  width: number;
}

function normalizeOrientation(value: number | undefined): ExifOrientation {
  return value && value >= 1 && value <= 8 ? (value as ExifOrientation) : 1;
}

/**
 * Resolve the display orientation from decoder metadata first, then fall back
 * to EXIF parsing on the original file. The fallback is important for RAW
 * embedded previews and containers whose orientation is not exposed by libvips.
 */
export async function resolveImageOrientation(
  originalPath: string | Buffer,
  metadata?: Pick<Metadata, "orientation">
): Promise<ExifOrientation> {
  if (metadata?.orientation != null) {
    return normalizeOrientation(metadata.orientation);
  }

  try {
    return normalizeOrientation(await exifr.orientation(originalPath));
  } catch {
    return 1;
  }
}

export function getOrientedDimensions(
  width: number | undefined,
  height: number | undefined,
  orientation: ExifOrientation
): OrientedDimensions {
  const rawWidth = width ?? 0;
  const rawHeight = height ?? 0;
  return orientation >= 5
    ? { width: rawHeight, height: rawWidth }
    : { width: rawWidth, height: rawHeight };
}

/**
 * Apply an already-resolved EXIF orientation explicitly. Sharp executes flop
 * before rotation, so mirrored quarter-turn mappings use the inverse angle.
 */
export function applyExifOrientation(
  pipeline: Sharp,
  orientation: ExifOrientation
): Sharp {
  switch (orientation) {
    case 2:
      return pipeline.flop();
    case 3:
      return pipeline.rotate(180);
    case 4:
      return pipeline.flop().rotate(180);
    case 5:
      return pipeline.flop().rotate(270);
    case 6:
      return pipeline.rotate(90);
    case 7:
      return pipeline.flop().rotate(90);
    case 8:
      return pipeline.rotate(270);
    default:
      return pipeline;
  }
}
