// @vitest-environment node
import type { ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import sharp from "sharp";
import { afterAll, describe, expect, it, vi } from "vitest";
import { getActiveEmbeddingAdapter } from "@/services/ai/model-adapter";
import { normalizeImageInput } from "../../../scripts/face-image.mjs";
import { decodeHeif, isHeifHeader } from "../../../scripts/heif-decoder.mjs";
import {
  createHeifResolver,
  resolveHeifInput,
  stopHeifDecoder,
} from "../../../scripts/heif-input.mjs";
import { preprocessImage } from "../../../scripts/image-preprocessing.mjs";
import { heifFixturePath, withHeifProperty } from "../helpers/heif-fixture";
import { TestRuntime } from "../helpers/test-runtime";

afterAll(() => stopHeifDecoder());

const pixelHash = (buffer: Buffer) =>
  createHash("sha256").update(buffer).digest("hex");
describe("offline HEIC decoding", () => {
  it("selects the primary image, returns display dimensions and normalized orientation", async () => {
    const result = await decodeHeif(heifFixturePath);
    expect(result).toMatchObject({
      width: 1280,
      height: 854,
      originalWidth: 1280,
      originalHeight: 854,
      orientationApplied: true,
    });
    expect(await sharp(result.buffer).metadata()).toMatchObject({
      format: "png",
      orientation: 1,
    });
  });

  it.each([1, 2, 3])("applies container rotation %i once", async (angle) => {
    const original = await decodeHeif(heifFixturePath);
    const rotated = await decodeHeif(
      withHeifProperty("irot", Buffer.from([angle]))
    );
    const expected = await sharp(original.buffer)
      .rotate((360 - angle * 90) % 360)
      .raw()
      .toBuffer();
    expect(pixelHash(await sharp(rotated.buffer).raw().toBuffer())).toBe(
      pixelHash(expected)
    );
  });

  it.each([0, 1])("applies container mirror axis %i", async (axis) => {
    const original = await decodeHeif(heifFixturePath);
    const mirrored = await decodeHeif(
      withHeifProperty("imir", Buffer.from([axis]))
    );
    const pipeline = sharp(original.buffer);
    const expected = await (axis === 0 ? pipeline.flip() : pipeline.flop())
      .raw()
      .toBuffer();
    expect(pixelHash(await sharp(mirrored.buffer).raw().toBuffer())).toBe(
      pixelHash(expected)
    );
  });

  it("uses EXIF only when the primary image has no container rotation", async () => {
    const runtime = new TestRuntime("heif-exif");
    const exiftool = createRequire(import.meta.url)(
      "exiftool-vendored.exe"
    ) as string;
    try {
      for (const containerRotation of [false, true]) {
        const bytes = containerRotation
          ? withHeifProperty("irot", Buffer.from([1]))
          : fs.readFileSync(heifFixturePath);
        const input = path.join(
          runtime.root,
          `orientation-${containerRotation}.heic`
        );
        fs.writeFileSync(input, bytes);
        execFileSync(
          exiftool,
          ["-overwrite_original", "-Orientation#=6", input],
          { stdio: "ignore" }
        );
        const actual = await decodeHeif(input);
        const before = await decodeHeif(heifFixturePath);
        const expected = await sharp(before.buffer)
          .rotate(containerRotation ? 270 : 90)
          .raw()
          .toBuffer();
        expect(pixelHash(await sharp(actual.buffer).raw().toBuffer())).toBe(
          pixelHash(expected)
        );
      }
    } finally {
      runtime.cleanup();
    }
  });
  it("decodes 10-bit HEIF into usable 8-bit display pixels", async () => {
    const input = path.resolve("src/tests/fixtures/heif/rgb-10bit.heif");
    expect((await sharp(input).metadata()).bitsPerSample).toBe(10);
    const result = await decodeHeif(input);
    expect(await sharp(result.buffer).metadata()).toMatchObject({
      width: 128,
      height: 128,
      depth: "uchar",
    });
  });

  it("preserves embedded color information through sRGB conversion", async () => {
    const { icc } = await sharp({
      create: { width: 1, height: 1, channels: 3, background: "red" },
    })
      .withIccProfile("p3")
      .png()
      .toBuffer()
      .then((buffer) => sharp(buffer).metadata());
    if (!icc) {
      throw new Error("Missing fixture ICC profile");
    }
    const result = await decodeHeif(
      withHeifProperty("colr", Buffer.concat([Buffer.from("prof"), icc]))
    );
    const baseline = await decodeHeif(heifFixturePath);
    const actual = await sharp(result.buffer).raw().toBuffer();
    const before = await sharp(baseline.buffer).raw().toBuffer();
    expect(actual.equals(before)).toBe(false);
    expect((await sharp(result.buffer).metadata()).hasProfile).toBe(true);
  });

  it("rejects oversized dimensions before pixel allocation", async () => {
    const bytes = fs.readFileSync(heifFixturePath);
    bytes.writeUInt32BE(100_001, 509);
    bytes.writeUInt32BE(100_001, 513);
    await expect(decodeHeif(bytes)).rejects.toThrow("limit");
  });

  it("keeps AVIF on its original path and recovers after a damaged HEIC", async () => {
    const avif = await sharp({
      create: { width: 16, height: 16, channels: 3, background: "red" },
    })
      .avif()
      .toBuffer();
    expect(isHeifHeader(avif)).toBe(false);
    expect(await resolveHeifInput(avif)).toBe(avif);
    await expect(
      resolveHeifInput(fs.readFileSync(heifFixturePath).subarray(0, 50))
    ).rejects.toThrow();
    expect(
      await sharp(await resolveHeifInput(heifFixturePath)).metadata()
    ).toMatchObject({ width: 1280, height: 854 });
  });

  it("coalesces Chinese-path requests in one tracked decoder", async () => {
    const runtime = new TestRuntime("heif-coalescing");
    const input = path.join(runtime.root, "中文照片.heif");
    fs.copyFileSync(heifFixturePath, input);
    const exits: Promise<unknown>[] = [];
    const track = vi.fn((child: ChildProcess) => {
      runtime.trackProcess(child);
      exits.push(once(child, "exit"));
      return child;
    });
    const resolver = createHeifResolver({ track });
    try {
      const [a, b] = await Promise.all([
        resolver.resolveInput(input),
        resolver.resolveInput(input),
      ]);
      expect(a).toBe(b);
      expect(track).toHaveBeenCalledTimes(1);
    } finally {
      resolver.stop();
      await Promise.all(exits);
      runtime.cleanup();
    }
  });

  it("kills a timed-out decoder and starts a new decoder for the next photo", async () => {
    const runtime = new TestRuntime("heif-timeout");
    const workerPath = path.join(runtime.root, "worker.mjs");
    const marker = path.join(runtime.root, "started");
    fs.writeFileSync(
      workerPath,
      `import fs from 'node:fs';import {decodeHeif} from ${JSON.stringify(new URL("../../../scripts/heif-decoder.mjs", import.meta.url).href)};process.on('message',async({input})=>{if(!fs.existsSync(${JSON.stringify(marker)})){fs.writeFileSync(${JSON.stringify(marker)},'1');return;}process.send({result:await decodeHeif(input)});});`
    );
    const exits: Promise<unknown>[] = [];
    const resolver = createHeifResolver({
      workerPath,
      timeoutMs: 1500,
      track: (child) => {
        runtime.trackProcess(child);
        exits.push(once(child, "exit"));
        return child;
      },
    });
    try {
      await expect(resolver.resolveInput(heifFixturePath)).rejects.toThrow(
        "timed out"
      );
      expect(
        await sharp(await resolver.resolveInput(heifFixturePath)).metadata()
      ).toMatchObject({ width: 1280 });
    } finally {
      resolver.stop();
      await Promise.all(exits);
      runtime.cleanup();
    }
  }, 15_000);

  it("feeds HEIC to the real AI preprocessor and face normalization", async () => {
    const tensor = await preprocessImage(
      heifFixturePath,
      getActiveEmbeddingAdapter().embeddingSpace.image
    );
    expect(tensor).toHaveLength(3 * 224 * 224);
    expect(tensor.every(Number.isFinite)).toBe(true);
    const face = await normalizeImageInput(heifFixturePath, heifFixturePath);
    expect(face).toMatchObject({ width: 1280, height: 854 });
    expect(face.data).toHaveLength(1280 * 854 * 3);
  });
});
