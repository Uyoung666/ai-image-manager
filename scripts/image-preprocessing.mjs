import sharp from "sharp";
import { resolveHeifInput } from "./heif-input.mjs";

/** The fixed SigLIP Processor uses a bicubic affine resize, not resize's
 * Lanczos kernel. Decode orientation and RGB before resampling, and round
 * rescaling to float32 before normalization as Transformers.js does.
 */
export async function preprocessImage(input, image) {
  const decodedInput = await resolveHeifInput(input);
  const decoder = sharp(decodedInput, { failOn: "none" });
  const metadata = await decoder.metadata();
  const swapsAxes = (metadata.orientation ?? 1) >= 5;
  const width = swapsAxes ? metadata.height : metadata.width;
  const height = swapsAxes ? metadata.width : metadata.height;
  if (!(width > 0 && height > 0)) {
    throw new Error("Image dimensions are unavailable");
  }
  if (image.resizeFit !== "fill" || image.resample !== "bicubic") {
    throw new Error("Unsupported image preprocessing resize policy");
  }
  let rgbInput = decoder.rotate().toColourspace("srgb").removeAlpha();
  if (metadata.hasAlpha || metadata.space !== "srgb") {
    // Sharp applies affine before channel removal in a single pipeline and
    // premultiplies alpha. The Processor drops alpha first; materialize RGB
    // for alpha/non-RGB images so interpolation sees the decoded RGB pixels.
    const decoded = await rgbInput.raw().toBuffer({ resolveWithObject: true });
    rgbInput = sharp(decoded.data, {
      raw: {
        width: decoded.info.width,
        height: decoded.info.height,
        channels: 3,
      },
    });
  }
  const { data, info } = await rgbInput
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
  const pixelsPerChannel = image.imageSize * image.imageSize;
  const output = new Float32Array(3 * pixelsPerChannel);
  for (let pixel = 0; pixel < pixelsPerChannel; pixel++) {
    for (let channel = 0; channel < 3; channel++) {
      const rescaled = Math.fround(
        data[pixel * 3 + channel] * image.rescaleFactor
      );
      output[channel * pixelsPerChannel + pixel] =
        (rescaled - image.mean[channel]) / image.std[channel];
    }
  }
  return output;
}
