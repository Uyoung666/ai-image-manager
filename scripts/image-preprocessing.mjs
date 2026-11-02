import sharp from "sharp";
import { isHeifInput } from "./heif-decoder.mjs";
import { resolveHeifResult } from "./heif-input.mjs";
import {
  describeHeifModelCache,
  readHeifModelCache,
  writeHeifModelCache,
} from "./heif-model-cache.mjs";
import { normalizeModelRgb, resizeModelRgb } from "./image-rgb.mjs";

/** The cached RGB is already resized by exactly the same bicubic processor. */
export async function preprocessImage(input, image, options = {}) {
  if (await isHeifInput(input)) {
    const descriptor = await describeHeifModelCache(
      input,
      image,
      options.cacheDir
    );
    let data = await readHeifModelCache(descriptor);
    if (data) {
      options.onTimings?.({ cacheHit: true });
    } else {
      const result = await resolveHeifResult(input, {
        output: "embedding",
        image,
      });
      data = Buffer.from(result.modelRgb);
      await writeHeifModelCache(descriptor, result.modelPng);
      options.onTimings?.({ ...result.timings, cacheHit: false });
    }
    return normalizeModelRgb(data, image);
  }
  const decoder = sharp(input, { failOn: "none" });
  return normalizeModelRgb(
    await resizeModelRgb(decoder, await decoder.metadata(), image),
    image
  );
}
