import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { SIGLIP_V1_ADAPTER } from "@/services/ai/model-adapter";
import { preprocessImage } from "../../../scripts/image-preprocessing.mjs";

const imageSpec = SIGLIP_V1_ADAPTER.embeddingSpace.image;
const configPath = path.resolve(
  "models/Xenova/siglip-base-patch16-224/preprocessor_config.json"
);
// Unit tests also run in CI without the 200 MB model payload. This is the
// checked artifact's Processor configuration; use the local file when present.
const config = fs.existsSync(configPath)
  ? JSON.parse(fs.readFileSync(configPath, "utf8"))
  : {
      do_normalize: true,
      do_rescale: true,
      do_resize: true,
      image_processor_type: "SiglipImageProcessor",
      image_mean: [0.5, 0.5, 0.5],
      image_std: [0.5, 0.5, 0.5],
      resample: 3,
      rescale_factor: 1 / 255,
      size: { height: 224, width: 224 },
    };

function patternedImage(width: number, height: number, channels: 3 | 4) {
  const data = Buffer.alloc(width * height * channels);
  for (let pixel = 0; pixel < width * height; pixel++) {
    for (let channel = 0; channel < channels; channel++) {
      data[pixel * channels + channel] =
        (pixel * (channel * 11 + 7) + Math.floor(pixel / width) * 19) % 256;
    }
  }
  return sharp(data, { raw: { width, height, channels } });
}

function referenceTensorHash(input: Buffer): string {
  // Transformers.js bundles another Sharp/libvips. Keep that native library
  // in its own process instead of loading both Sharp versions into a worker.
  const reference = `
    import fs from 'node:fs';
    import { createHash } from 'node:crypto';
    import { SiglipImageProcessor, RawImage } from '@xenova/transformers';
    const request=JSON.parse(fs.readFileSync(0,'utf8'));
    const image=await RawImage.fromBlob(new Blob([Buffer.from(request.image,'base64')]));
    const result=await new SiglipImageProcessor(request.config)(image);
    const data=result.pixel_values.data;
    console.log(createHash('sha256').update(Buffer.from(data.buffer,data.byteOffset,data.byteLength)).digest('hex'));
  `;
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", reference],
    {
      cwd: process.cwd(),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      input: JSON.stringify({ config, image: input.toString("base64") }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    }
  );
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

describe("SigLIP image preprocessing", () => {
  it.each([
    ["RGB", 513, 337, 3, "normal"],
    ["grayscale", 171, 93, 3, "grayscale"],
    ["transparent", 513, 257, 4, "normal"],
    ["EXIF rotation", 43, 21, 3, "orientation"],
    ["panorama", 1000, 7, 3, "normal"],
    ["portrait", 7, 1000, 3, "normal"],
    ["native size", 224, 224, 3, "normal"],
  ] as const)(
    "matches the fixed Processor tensor for %s",
    async (_name, width, height, channels, mode) => {
      let fixture = patternedImage(width, height, channels);
      if (mode === "grayscale") {
        fixture = fixture.greyscale();
      }
      if (mode === "orientation") {
        fixture = fixture.withMetadata({ orientation: 6 });
      }
      const input = await (mode === "orientation"
        ? fixture.jpeg()
        : fixture.png()
      ).toBuffer();
      const tensor = await preprocessImage(input, imageSpec);
      expect(tensor).toHaveLength(3 * 224 * 224);
      expect(tensor.every(Number.isFinite)).toBe(true);
      const actualHash = createHash("sha256")
        .update(
          Buffer.from(tensor.buffer, tensor.byteOffset, tensor.byteLength)
        )
        .digest("hex");
      expect(actualHash).toBe(referenceTensorHash(input));
    },
    45_000
  );

  it("decodes CMYK into a finite RGB tensor using the host decoder", async () => {
    // libvips versions differ in CMYK-to-RGB colour conversion before the
    // Processor resizes. Keep the host decoder and test that space explicitly.
    const input = await patternedImage(173, 91, 3)
      .toColourspace("cmyk")
      .jpeg()
      .toBuffer();
    const tensor = await preprocessImage(input, imageSpec);
    expect(tensor).toHaveLength(3 * 224 * 224);
    expect(tensor.every(Number.isFinite)).toBe(true);
    expect(tensor.every((value) => value >= -1 && value <= 1)).toBe(true);
  });

  it("rejects an unsupported resize contract instead of producing another space", async () => {
    const input = await patternedImage(10, 10, 3).png().toBuffer();
    await expect(
      preprocessImage(input, { ...imageSpec, resizeFit: "cover" })
    ).rejects.toThrow("Unsupported image preprocessing resize policy");
  });

  it("rejects unreadable input", async () => {
    await expect(
      preprocessImage(Buffer.from("not an image"), imageSpec)
    ).rejects.toThrow();
  });
});
