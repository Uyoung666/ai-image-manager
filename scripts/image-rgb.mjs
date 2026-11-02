import sharp from "sharp";

export function orientPixels(pipeline, orientation) {
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

/** Shared by the import decoder and inference worker; never resize a thumbnail. */
export async function resizeModelRgb(decoder, metadata, image) {
  const swapsAxes = (metadata.orientation ?? 1) >= 5;
  const width = swapsAxes ? metadata.height : metadata.width;
  const height = swapsAxes ? metadata.width : metadata.height;
  if (!(width > 0 && height > 0)) {
    throw new Error("Image dimensions are unavailable");
  }
  if (image.resizeFit !== "fill" || image.resample !== "bicubic") {
    throw new Error("Unsupported image preprocessing resize policy");
  }
  let rgb = decoder.rotate().toColourspace("srgb").removeAlpha();
  if (metadata.hasAlpha || metadata.space !== "srgb") {
    const decoded = await rgb.raw().toBuffer({ resolveWithObject: true });
    rgb = sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: 3,
      },
    });
  }
  const { data, info } = await rgb
    .affine([image.imageSize / width, 0, 0, image.imageSize / height], {
      interpolator: "bicubic",
    })
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== image.imageSize ||
    info.height !== image.imageSize ||
    info.channels !== 3
  ) {
    throw new Error(
      `Image resize mismatch: ${info.width}x${info.height}x${info.channels}`
    );
  }
  return data;
}

export function normalizeModelRgb(data, image) {
  const count = image.imageSize * image.imageSize;
  if (data.length !== count * 3) {
    throw new Error("Invalid model RGB input length");
  }
  const output = new Float32Array(3 * count);
  for (let pixel = 0; pixel < count; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const rescaled = Math.fround(
        data[pixel * 3 + channel] * image.rescaleFactor
      );
      output[channel * count + pixel] =
        (rescaled - image.mean[channel]) / image.std[channel];
    }
  }
  return output;
}
