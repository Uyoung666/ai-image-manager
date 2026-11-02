// @vitest-environment node
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { getActiveEmbeddingAdapter } from "@/services/ai/model-adapter";
import { decodeHeif } from "../../../scripts/heif-decoder.mjs";
import { stopHeifDecoder } from "../../../scripts/heif-input.mjs";
import {
  describeHeifModelCache,
  invalidateHeifModelCache,
  readHeifModelCache,
  writeHeifModelCache,
} from "../../../scripts/heif-model-cache.mjs";
import { preprocessImage } from "../../../scripts/image-preprocessing.mjs";
import { normalizeModelRgb } from "../../../scripts/image-rgb.mjs";
import { heifFixturePath } from "../helpers/heif-fixture";
import { TestRuntime } from "../helpers/test-runtime";

it("reuses exact model pixels and safely rebuilds damaged or invalidated caches", async () => {
  const runtime = new TestRuntime("heif-model-cache");
  const input = path.join(runtime.root, "source.heic");
  const cacheDir = path.join(runtime.root, "thumbnails");
  const image = getActiveEmbeddingAdapter().embeddingSpace.image;
  fs.copyFileSync(heifFixturePath, input);
  try {
    const prepared = await decodeHeif(input, {
      output: "import",
      thumbnailSize: 512,
      image,
    });
    if (!prepared.modelRgb) {
      throw new Error("Missing prepared pixels");
    }
    const decoded = await decodeHeif(input);
    expect(await preprocessImage(decoded.buffer, image)).toEqual(
      normalizeModelRgb(prepared.modelRgb, image)
    );
    const descriptor = await describeHeifModelCache(input, image, cacheDir);
    if (!descriptor) {
      throw new Error("Missing cache descriptor");
    }
    await Promise.all([
      writeHeifModelCache(descriptor, prepared.modelPng),
      writeHeifModelCache(descriptor, prepared.modelPng),
    ]);
    expect(await readHeifModelCache(descriptor)).toEqual(prepared.modelRgb);
    const seen: boolean[] = [];
    expect(
      await preprocessImage(input, image, {
        cacheDir,
        onTimings: (detail) => seen.push(Boolean(detail.cacheHit)),
      })
    ).toEqual(normalizeModelRgb(prepared.modelRgb, image));
    expect(seen).toEqual([true]);
    fs.writeFileSync(descriptor.file, "broken");
    expect(await readHeifModelCache(descriptor)).toBeNull();
    await preprocessImage(input, image, { cacheDir });
    expect(await readHeifModelCache(descriptor)).toEqual(prepared.modelRgb);
    await invalidateHeifModelCache(cacheDir);
    await writeHeifModelCache(descriptor, prepared.modelPng);
    expect(await readHeifModelCache(descriptor)).toBeNull();
    const updated = await describeHeifModelCache(input, image, cacheDir);
    if (!updated) {
      throw new Error("Missing updated descriptor");
    }
    expect(updated.file).not.toBe(descriptor.file);
    expect(
      (
        await describeHeifModelCache(
          input,
          { ...image, preprocessingVersion: "changed" },
          cacheDir
        )
      )?.file
    ).not.toBe(updated.file);
    await writeHeifModelCache(
      updated,
      await sharp({
        create: { width: 1, height: 1, channels: 3, background: "black" },
      })
        .png()
        .toBuffer()
    );
    expect(await readHeifModelCache(updated)).toBeNull();
    fs.utimesSync(input, new Date(), new Date(Date.now() + 2000));
    expect(
      (await describeHeifModelCache(input, image, cacheDir))?.file
    ).not.toBe(updated.file);
    expect(
      await describeHeifModelCache(fs.readFileSync(input), image, cacheDir)
    ).toBeNull();
  } finally {
    stopHeifDecoder();
    runtime.cleanup();
  }
}, 20_000);
