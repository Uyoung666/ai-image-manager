import fs from "node:fs/promises";
import { crc32, deflateSync } from "node:zlib";
import exifr from "exifr";
import sharp from "sharp";
import { orientPixels, resizeModelRgb } from "./image-rgb.mjs";

const HEVC_BRANDS = new Set([
  "heic",
  "heix",
  "hevc",
  "hevx",
  "heim",
  "heis",
  "hevm",
  "hevs",
]);
export const MAX_HEIF_PIXELS = 100_000_000;

/** Inspect ftyp, including compatible brands; AVIF must keep its existing decoder. */
export function isHeifHeader(bytes) {
  if (bytes.length < 16 || bytes.toString("ascii", 4, 8) !== "ftyp") {
    return false;
  }
  const end = Math.min(bytes.readUInt32BE(0), bytes.length);
  const brands = [bytes.toString("ascii", 8, 12)];
  for (let offset = 16; offset + 4 <= end; offset += 4) {
    brands.push(bytes.toString("ascii", offset, offset + 4));
  }
  return (
    !brands.some((brand) => brand === "avif" || brand === "avis") &&
    brands.some((brand) => HEVC_BRANDS.has(brand))
  );
}

export async function isHeifInput(input) {
  if (typeof input !== "string") {
    return isHeifHeader(input);
  }
  let file;
  try {
    file = await fs.open(input, "r");
  } catch {
    return false;
  }
  try {
    const header = Buffer.alloc(512);
    const { bytesRead } = await file.read(header, 0, header.length, 0);
    return isHeifHeader(header.subarray(0, bytesRead));
  } finally {
    await file.close();
  }
}

// Preserve source ICC in the intermediate PNG so Sharp can convert to sRGB.
function attachIcc(png, profile) {
  const payload = Buffer.concat([
    Buffer.from("HEIF\0\0"),
    deflateSync(profile),
  ]);
  const chunk = Buffer.alloc(payload.length + 12);
  chunk.writeUInt32BE(payload.length);
  chunk.write("iCCP", 4);
  payload.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4);
  return Buffer.concat([png.subarray(0, 33), chunk, png.subarray(33)]);
}

/** Runs only inside an isolated decoder process. libheif applies irot/imir itself. */
export async function decodeHeif(input, options = {}) {
  const started = performance.now();
  const timings = {};
  let checkpoint = started;
  const mark = (stage) => {
    const now = performance.now();
    timings[stage] = now - checkpoint;
    checkpoint = now;
  };
  const bytes =
    typeof input === "string" ? await fs.readFile(input) : Buffer.from(input);
  if (!isHeifHeader(bytes)) {
    throw new Error("Unsupported HEIC/HEIF container");
  }
  const { default: lib } = await import("libheif-js/wasm-bundle.js");
  const decoder = new lib.HeifDecoder();
  let images = [];
  try {
    images = decoder.decode(bytes);
    const image = images.find((candidate) => candidate.is_primary());
    if (!image) {
      throw new Error("HEIC primary image is unavailable");
    }
    const width = image.get_width();
    const height = image.get_height();
    if (!(width > 0 && height > 0) || width * height > MAX_HEIF_PIXELS) {
      throw new Error("HEIC image exceeds the 100 megapixel decode limit");
    }
    // Embind wraps handles; the pinned build exposes these additional C APIs.
    const handle = image.handle.$$.ptr;
    const originalWidth = lib._heif_image_handle_get_ispe_width(handle);
    const originalHeight = lib._heif_image_handle_get_ispe_height(handle);
    mark("readMetadataMs");
    const rgba = await new Promise((resolve, reject) => {
      image.display(
        { data: new Uint8ClampedArray(width * height * 4), width, height },
        (result) => {
          if (result) {
            resolve(result.data);
          } else {
            reject(new Error("HEIC pixel decoding failed"));
          }
        }
      );
    });
    mark("decodeMs");
    const raw = { width, height, channels: 4 };
    const pixels = Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    const profile = await readColorProfile(lib, handle);
    let pipeline = sharp(pixels, { raw });
    if (profile) {
      // PNG is only an ICC carrier, never a compressed full-size transport.
      const carrier = await pipeline.png({ compressionLevel: 0 }).toBuffer();
      pipeline = sharp(attachIcc(carrier, profile));
    }
    const orientation = hasContainerOrientation(lib, decoder.decoder.$$.ptr)
      ? 1
      : await readExifOrientation(lib, handle);
    const normalized = await orientPixels(pipeline, orientation)
      .toColourspace("srgb")
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    mark("normalizeMs");
    const normalizedRaw = {
      width: normalized.info.width,
      height: normalized.info.height,
      channels: 4,
    };
    const source = () => sharp(normalized.data, { raw: normalizedRaw });
    const result = {
      width: normalized.info.width,
      height: normalized.info.height,
      originalWidth,
      originalHeight,
      orientationApplied: true,
      channels: 4,
      timings,
    };
    if (options.output === "import" || options.output === "embedding") {
      if (options.image) {
        const rgb = await resizeModelRgb(
          source(),
          { ...normalizedRaw, orientation: 1, hasAlpha: true, space: "srgb" },
          options.image
        );
        result.modelPng = await sharp(rgb, {
          raw: {
            width: options.image.imageSize,
            height: options.image.imageSize,
            channels: 3,
          },
        })
          .png()
          .toBuffer();
        result.modelRgb = rgb;
      }
      if (options.output === "import") {
        result.buffer = await source()
          .resize(options.thumbnailSize, options.thumbnailSize, {
            fit: "inside",
            withoutEnlargement: true,
          })
          .webp({ quality: 85, effort: 1 })
          .toBuffer();
      }
    } else if (options.output === "pixels") {
      result.buffer = normalized.data;
    } else {
      result.buffer = await source()
        .withMetadata({ orientation: 1 })
        .png()
        .toBuffer();
    }
    mark("deriveMs");
    timings.totalMs = performance.now() - started;
    return result;
  } finally {
    for (const image of images) {
      image.free();
    }
    if (decoder.decoder) {
      lib.heif_context_free(decoder.decoder);
      decoder.decoder = null;
    }
  }
}

let p3Profile;
async function readColorProfile(lib, handle) {
  let profile;
  const profileSize = lib._heif_image_handle_get_raw_color_profile_size(handle);
  if (profileSize > 4 * 1024 * 1024) {
    throw new Error("HEIC color profile exceeds decode limit");
  }
  if (profileSize > 0) {
    const pointer = lib._malloc(profileSize);
    const errorPointer = lib._malloc(12);
    try {
      lib._heif_image_handle_get_raw_color_profile(
        errorPointer,
        handle,
        pointer
      );
      if (lib.HEAP32[errorPointer / 4] !== 0) {
        throw new Error("HEIC color profile could not be read");
      }
      profile = Buffer.from(
        lib.HEAPU8.subarray(pointer, pointer + profileSize)
      );
    } finally {
      lib._free(pointer);
      lib._free(errorPointer);
    }
  } else {
    const errorPointer = lib._malloc(12);
    const pointerPointer = lib._malloc(4);
    let profilePointer = 0;
    try {
      lib._heif_image_handle_get_nclx_color_profile(
        errorPointer,
        handle,
        pointerPointer
      );
      if (lib.HEAP32[errorPointer / 4] === 0) {
        profilePointer = lib.HEAPU32[pointerPointer / 4];
        const primaries = lib.HEAP32[(profilePointer + 4) / 4];
        const transfer = lib.HEAP32[(profilePointer + 8) / 4];
        if (primaries === 12 && transfer === 13) {
          p3Profile ??= await sharp({
            create: { width: 1, height: 1, channels: 3, background: "black" },
          })
            .withIccProfile("p3")
            .png()
            .toBuffer()
            .then((data) => sharp(data).metadata());
          const { icc } = p3Profile;
          if (icc) {
            profile = icc;
          }
        }
      }
    } finally {
      if (profilePointer) {
        lib._heif_nclx_color_profile_free(profilePointer);
      }
      lib._free(pointerPointer);
      lib._free(errorPointer);
    }
  }

  return profile;
}

function hasContainerOrientation(lib, context) {
  const error = lib._malloc(12);
  const pointer = lib._malloc(4);
  let properties = 0;
  try {
    lib._heif_context_get_primary_image_ID(error, context, pointer);
    if (lib.HEAP32[error / 4] !== 0) {
      throw new Error("HEIC primary image ID unavailable");
    }
    const id = lib.HEAPU32[pointer / 4];
    const count = lib._heif_item_get_transformation_properties(
      context,
      id,
      0,
      0
    );
    properties = lib._malloc(Math.max(1, count) * 4);
    lib._heif_item_get_transformation_properties(
      context,
      id,
      properties,
      count
    );
    for (let index = 0; index < count; index++) {
      const property = lib.HEAPU32[properties / 4 + index];
      const type = lib._heif_item_get_property_type(context, id, property);
      if (type === 0x69_72_6f_74 || type === 0x69_6d_69_72) {
        return true;
      }
    }
    return false;
  } finally {
    if (properties) {
      lib._free(properties);
    }
    lib._free(pointer);
    lib._free(error);
  }
}

async function readExifOrientation(lib, handle) {
  const type = lib._malloc(5);
  const idPointer = lib._malloc(4);
  const error = lib._malloc(12);
  let data = 0;
  try {
    lib.HEAPU8.set(Buffer.from("Exif\0"), type);
    const count = lib._heif_image_handle_get_list_of_metadata_block_IDs(
      handle,
      type,
      idPointer,
      1
    );
    if (count < 1) {
      return 1;
    }
    const id = lib.HEAPU32[idPointer / 4];
    const size = lib._heif_image_handle_get_metadata_size(handle, id);
    if (size < 12 || size > 16 * 1024 * 1024) {
      return 1;
    }
    data = lib._malloc(size);
    lib._heif_image_handle_get_metadata(error, handle, id, data);
    if (lib.HEAP32[error / 4] !== 0) {
      return 1;
    }
    const metadata = Buffer.from(lib.HEAPU8.subarray(data, data + size));
    const offset = 4 + metadata.readUInt32BE(0);
    return await exifr.orientation(metadata.subarray(offset)).catch(() => 1);
  } finally {
    if (data) {
      lib._free(data);
    }
    lib._free(type);
    lib._free(idPointer);
    lib._free(error);
  }
}
