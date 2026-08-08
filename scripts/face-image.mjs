import exifr from "exifr";
import sharp from "sharp";

function normalizeOrientation(value) {
  const orientation = Number(value);
  return Number.isInteger(orientation) && orientation >= 1 && orientation <= 8
    ? orientation
    : 1;
}

async function resolveImageOrientation(originalPath, inputMetadata) {
  if (inputMetadata?.orientation != null) {
    return normalizeOrientation(inputMetadata.orientation);
  }

  try {
    return normalizeOrientation(await exifr.orientation(originalPath));
  } catch {
    return 1;
  }
}

function applyExifOrientation(pipeline, orientation) {
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

/**
 * Decode an image into display-oriented RGB pixels.
 *
 * RAW embedded JPEGs may not carry the orientation stored on the original
 * RAW file, so the original path is used as the fallback metadata source.
 * Detection and embedding must consume this same normalized pixel buffer.
 */
export async function normalizeImageInput(input, originalPath) {
  const inputMetadata = await sharp(input, { failOn: "none" }).metadata();
  const orientation = await resolveImageOrientation(
    originalPath,
    inputMetadata
  );
  const { data, info } = await applyExifOrientation(
    sharp(input, { failOn: "none" }),
    orientation
  )
    .toColourspace("srgb")
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  if (info.channels !== 3 || !info.width || !info.height) {
    throw new Error(
      `Normalized face input must be RGB, got ${info.width}x${info.height}x${info.channels}`
    );
  }

  return {
    data: new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    height: info.height,
    width: info.width,
  };
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Map a YuNet box back to image pixels and clip all four edges to the image.
 * Boxes fully outside the image are discarded by returning null.
 */
export function mapYuNetBoxToImage(box, imageWidth, imageHeight, inputSize) {
  const scaleX = imageWidth / inputSize;
  const scaleY = imageHeight / inputSize;
  const left = clamp(Math.round(box.x1 * scaleX), 0, imageWidth);
  const top = clamp(Math.round(box.y1 * scaleY), 0, imageHeight);
  const right = clamp(Math.round((box.x1 + box.w) * scaleX), 0, imageWidth);
  const bottom = clamp(Math.round((box.y1 + box.h) * scaleY), 0, imageHeight);

  if (right <= left || bottom <= top) {
    return null;
  }

  return {
    height: bottom - top,
    width: right - left,
    x: left,
    y: top,
  };
}
