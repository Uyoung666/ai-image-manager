/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearThumbnailDiskCache,
  deletePhotoThumbnails,
  generateGalleryThumbnail,
  generateThumbnail,
  getGalleryThumbnailHint,
  getThumbnailDir,
  getThumbnailPath,
  initThumbnailer,
  stopThumbnailer,
  thumbnailGenerationSlots,
} from "@/services/thumbnailer";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("Isolated thumbnail fixture has no database");
  },
}));
let runtime: TestRuntime;
let original: string;
const previousSharpCache = sharp.cache();
async function damagePixels(file: string): Promise<void> {
  const bytes = await fs.promises.readFile(file);
  const chunk = bytes.indexOf(Buffer.from("VP8 "));
  expect(chunk).toBeGreaterThanOrEqual(0);
  bytes.fill(255, chunk + 18, chunk + 8 + bytes.readUInt32LE(chunk + 4));
  await fs.promises.writeFile(file, bytes);
  expect((await sharp(file).metadata()).width).toBeGreaterThan(0);
  await expect(sharp(file).raw().toBuffer()).rejects.toThrow();
}
beforeEach(async () => {
  sharp.cache(false);
  runtime = new TestRuntime("gallery-thumbnails");
  state.root = runtime.root;
  initThumbnailer();
  original = path.join(runtime.root, "source.jpg");
  await sharp({
    create: { width: 1200, height: 600, channels: 3, background: "#2179ac" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toFile(original);
});
afterEach(async () => {
  await stopThumbnailer();
  runtime.cleanup();
  sharp.cache({
    memory: previousSharpCache.memory.max,
    files: previousSharpCache.files.max,
    items: previousSharpCache.items.max,
  });
});
describe("physical gallery thumbnail generation", () => {
  it("does not create generation work when cancelled during legacy file lookup", async () => {
    const actualStat = fs.promises.stat.bind(fs.promises);
    const legacy = getThumbnailPath(original, "md");
    let resume: (() => void) | undefined;
    const stat = vi.spyOn(fs.promises, "stat").mockImplementation((file) =>
      String(file) === legacy
        ? new Promise<fs.Stats>((resolve, reject) => {
            resume = () => actualStat(file).then(resolve, reject);
          })
        : actualStat(file)
    );
    const acquire = vi.spyOn(thumbnailGenerationSlots, "acquire");
    const controller = new AbortController();
    const pending = generateGalleryThumbnail(original, 256, controller.signal);
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await vi.waitFor(() => expect(resume).toBeTypeOf("function"));
      controller.abort();
      resume?.();
      await cancelled;
      expect(acquire).not.toHaveBeenCalled();
      expect(fs.readdirSync(getThumbnailDir())).toHaveLength(0);
    } finally {
      stat.mockRestore();
      acquire.mockRestore();
    }
  });
  it("allows only the selection response a one-pixel preview rounding tolerance", async () => {
    await sharp({
      create: { width: 205, height: 1025, channels: 3, background: "#2179ac" },
    })
      .jpeg()
      .toFile(original);
    const preview = await generateThumbnail(original, "md");
    expect(Math.max(preview.width, preview.height)).toBe(1024);
    const selected = await generateGalleryThumbnail(
      original,
      2048,
      undefined,
      0,
      { width: 205, height: 1025 },
      true
    );
    expect(selected.thumbnailPath).toBe(preview.thumbnailPath);
    const exact = await generateGalleryThumbnail(original, 2048, undefined, 0, {
      width: 205,
      height: 1025,
    });
    expect(Math.max(exact.width, exact.height)).toBe(1025);
    expect(exact.thumbnailPath).not.toBe(preview.thumbnailPath);
  });
  it("advertises the real available edge until the preferred variant exists", async () => {
    const preview = await generateThumbnail(original, "md");
    const bytes = await sharp(original)
      .rotate()
      .resize(1024, 1024, { fit: "inside" })
      .webp()
      .toBuffer();
    await fs.promises.writeFile(preview.thumbnailPath, bytes);
    const photo = { path: original, width: 1200, height: 600 };
    const stat = fs.statSync(original);
    const readStat = (file: string) =>
      fs.promises.stat(file).catch(() => undefined);
    expect(await getGalleryThumbnailHint(photo, 256, stat, readStat)).toBe(
      1024
    );
    await generateGalleryThumbnail(original, 256);
    expect(await getGalleryThumbnailHint(photo, 256, stat, readStat)).toBe(256);
  });
  it("resamples oversized previews without decoding the original, and reuses exact variants", async () => {
    const preview = await generateThumbnail(original, "md");
    const large = await sharp(original)
      .rotate()
      .resize(1024, 1024, { fit: "inside" })
      .webp()
      .toBuffer();
    await fs.promises.writeFile(preview.thumbnailPath, large);
    // A readable source identity with undecodable pixels proves the preview is
    // used as input. Make the preview newer than this deliberately bad source.
    await fs.promises.writeFile(
      original,
      "source pixels intentionally unavailable"
    );
    const fresh = new Date(Date.now() + 1000);
    await fs.promises.utimes(preview.thumbnailPath, fresh, fresh);
    for (const edge of [256, 512] as const) {
      const result = await generateGalleryThumbnail(original, edge);
      expect(Math.max(result.width, result.height)).toBe(edge);
      expect(result.thumbnailPath).not.toBe(preview.thumbnailPath);
      const write = vi.spyOn(fs.promises, "rename");
      expect(
        (await generateGalleryThumbnail(original, edge)).thumbnailPath
      ).toBe(result.thumbnailPath);
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    }
  });
  it("directly reuses an exactly sized legacy preview", async () => {
    const preview = await generateThumbnail(original, "md");
    const bytes = await sharp(preview.thumbnailPath)
      .resize(512, 512, { fit: "inside" })
      .webp()
      .toBuffer();
    await fs.promises.writeFile(preview.thumbnailPath, bytes);
    const result = await generateGalleryThumbnail(original, 512);
    expect(result.thumbnailPath).toBe(preview.thumbnailPath);
    expect(Math.max(result.width, result.height)).toBe(512);
  });
  it("does not treat a legacy preview with unapplied orientation as an upright input", async () => {
    const preview = await generateThumbnail(original, "md");
    await fs.promises.writeFile(
      preview.thumbnailPath,
      await sharp(original)
        .resize(1024, 1024, { fit: "inside" })
        .withMetadata({ orientation: 6 })
        .webp()
        .toBuffer()
    );
    const result = await generateGalleryThumbnail(original, 256);
    expect(result).toMatchObject({ width: 128, height: 256 });
  });
  it("recovers from a preview whose metadata is readable but pixel decode fails", async () => {
    const preview = await generateThumbnail(original, "md");
    const metadata = await sharp(preview.thumbnailPath).metadata();
    const bytes = await fs.promises.readFile(preview.thumbnailPath);
    // Preserve the container and VP8 dimension header, corrupt only its pixels.
    const chunk = bytes.indexOf(Buffer.from("VP8 "));
    expect(chunk).toBeGreaterThanOrEqual(0);
    bytes.fill(255, chunk + 18, chunk + 8 + bytes.readUInt32LE(chunk + 4));
    await fs.promises.writeFile(preview.thumbnailPath, bytes);
    expect((await sharp(preview.thumbnailPath).metadata()).width).toBe(
      metadata.width
    );
    await expect(
      sharp(preview.thumbnailPath).raw().toBuffer()
    ).rejects.toThrow();
    const result = await generateGalleryThumbnail(original, 256);
    expect(Math.max(result.width, result.height)).toBe(256);
    expect((await sharp(result.thumbnailPath).metadata()).height).toBe(256);
  });
  it("repairs an exactly sized legacy preview from the source without reusing its readable damaged metadata", async () => {
    const preview = await generateThumbnail(original, "md");
    await fs.promises.writeFile(
      preview.thumbnailPath,
      await sharp(preview.thumbnailPath)
        .resize(512, 512, { fit: "inside" })
        .webp()
        .toBuffer()
    );
    await damagePixels(preview.thumbnailPath);
    const selected = await generateGalleryThumbnail(original, 512);
    expect(selected.thumbnailPath).toBe(preview.thumbnailPath);
    const repaired = await generateGalleryThumbnail(
      original,
      512,
      undefined,
      0,
      undefined,
      false,
      true
    );
    expect(repaired.thumbnailPath).not.toBe(preview.thumbnailPath);
    expect(Math.max(repaired.width, repaired.height)).toBe(512);
    await expect(
      sharp(repaired.thumbnailPath).raw().toBuffer()
    ).resolves.toBeInstanceOf(Buffer);
    expect((await generateGalleryThumbnail(original, 512)).thumbnailPath).toBe(
      repaired.thumbnailPath
    );
  });
  it("deduplicates repairs of an exact variant whose metadata remains readable", async () => {
    const first = await generateGalleryThumbnail(original, 256);
    await damagePixels(first.thumbnailPath);
    const writes = vi.spyOn(fs.promises, "rename");
    try {
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          generateGalleryThumbnail(
            original,
            256,
            undefined,
            0,
            undefined,
            false,
            true
          )
        )
      );
      expect(new Set(results.map((item) => item.thumbnailPath))).toEqual(
        new Set([first.thumbnailPath])
      );
      expect(
        writes.mock.calls.filter(
          ([, target]) => String(target) === first.thumbnailPath
        )
      ).toHaveLength(1);
      await expect(
        sharp(first.thumbnailPath).raw().toBuffer()
      ).resolves.toBeInstanceOf(Buffer);
    } finally {
      writes.mockRestore();
    }
  });
  it("does not reuse an old preview when a replacement preserves the source mtime", async () => {
    const old = new Date(Date.now() - 60_000);
    await fs.promises.utimes(original, old, old);
    const preview = await generateThumbnail(original, "md");
    const replacement = await sharp({
      create: { width: 700, height: 700, channels: 3, background: "#b68229" },
    })
      .jpeg()
      .toBuffer();
    await fs.promises.writeFile(original, replacement);
    await fs.promises.utimes(original, old, old);
    const result = await generateGalleryThumbnail(original, 512, undefined, 0, {
      width: 700,
      height: 700,
    });
    expect(result.thumbnailPath).not.toBe(preview.thumbnailPath);
    expect(result).toMatchObject({ width: 512, height: 512 });
  });
  it("indexes variants once for batch deletion and removes every physical tier", async () => {
    const second = path.join(runtime.root, "second.jpg");
    await fs.promises.copyFile(original, second);
    await Promise.all(
      [original, second].flatMap((file) =>
        [256, 512].map((edge) =>
          generateGalleryThumbnail(file, edge as 256 | 512)
        )
      )
    );
    const read = vi.spyOn(fs.promises, "readdir");
    try {
      await Promise.all([
        deletePhotoThumbnails(original),
        deletePhotoThumbnails(second),
      ]);
      expect(read).toHaveBeenCalledTimes(1);
    } finally {
      read.mockRestore();
    }
    expect(fs.readdirSync(getThumbnailDir())).toHaveLength(0);
  });
  it("shares maintenance generation with foreground consumers and promotes queued work", async () => {
    for (let index = 0; index < 4; index++) {
      await thumbnailGenerationSlots.acquire();
    }
    const acquire = vi.spyOn(thumbnailGenerationSlots, "acquire");
    const promote = vi.spyOn(thumbnailGenerationSlots, "promote");
    const background = generateGalleryThumbnail(original, 512, undefined, 2);
    const controller = new AbortController();
    try {
      await vi.waitFor(() => expect(acquire).toHaveBeenCalledTimes(1));
      const foreground = generateGalleryThumbnail(
        original,
        512,
        controller.signal,
        0
      );
      const cancelled = expect(foreground).rejects.toMatchObject({
        name: "AbortError",
      });
      await vi.waitFor(() =>
        expect(promote).toHaveBeenCalledWith(expect.any(AbortSignal), 0)
      );
      controller.abort();
      await cancelled;
      expect(acquire).toHaveBeenCalledTimes(1);
    } finally {
      acquire.mockRestore();
      promote.mockRestore();
      for (let index = 0; index < 4; index++) {
        thumbnailGenerationSlots.release();
      }
    }
    expect((await background).height).toBe(512);
    expect(
      fs.readdirSync(getThumbnailDir()).filter((file) => file.endsWith(".webp"))
    ).toHaveLength(1);
  });
  it("cancels queued generation before a service restart and leaves the new scope usable", async () => {
    for (let index = 0; index < 4; index++) {
      await thumbnailGenerationSlots.acquire();
    }
    const acquire = vi.spyOn(thumbnailGenerationSlots, "acquire");
    const pending = generateGalleryThumbnail(original, 256);
    const cancelled = expect(pending).rejects.toMatchObject({
      name: "AbortError",
    });
    try {
      await vi.waitFor(() => expect(acquire).toHaveBeenCalled());
      await stopThumbnailer();
      await cancelled;
      expect(fs.readdirSync(getThumbnailDir())).toHaveLength(0);
    } finally {
      acquire.mockRestore();
      for (let index = 0; index < 4; index++) {
        thumbnailGenerationSlots.release();
      }
    }
    initThumbnailer();
    expect((await generateGalleryThumbnail(original, 256)).height).toBe(256);
  });
  it("clears only application-named thumbnails and preserves unrelated images", async () => {
    await generateGalleryThumbnail(original, 256);
    const unmanaged = path.join(getThumbnailDir(), "unrelated-photo.jpg");
    await fs.promises.writeFile(unmanaged, "unmanaged image");
    expect((await clearThumbnailDiskCache()).fileCount).toBe(1);
    expect(fs.existsSync(unmanaged)).toBe(true);
  });
  it("reuses an orientation-safe preview when the original is smaller than the requested tier", async () => {
    await sharp({
      create: { width: 64, height: 128, channels: 3, background: "#aabbcc" },
    })
      .jpeg()
      .toFile(original);
    const preview = await generateThumbnail(original, "md");
    const result = await generateGalleryThumbnail(
      original,
      2048,
      undefined,
      0,
      { width: 64, height: 128 }
    );
    expect(result.thumbnailPath).toBe(preview.thumbnailPath);
    expect(result).toMatchObject({ width: 64, height: 128 });
  });
  it("deduplicates concurrent generation and applies physical pixels with orientation", async () => {
    const writes = vi.spyOn(fs.promises, "rename");
    const results = await Promise.all(
      Array.from({ length: 12 }, () => generateGalleryThumbnail(original, 256))
    );
    expect(new Set(results.map((result) => result.thumbnailPath)).size).toBe(1);
    expect(results[0]).toMatchObject({ width: 128, height: 256 });
    expect(
      writes.mock.calls.filter(([, _target]) =>
        String(_target).endsWith(".webp")
      )
    ).toHaveLength(1);
    writes.mockRestore();
    expect(
      fs.readdirSync(getThumbnailDir()).filter((name) => name.endsWith(".tmp"))
    ).toHaveLength(0);
  });
  it("regenerates corrupt variants and changes identity when the source changes", async () => {
    const first = await generateGalleryThumbnail(original, 512);
    await fs.promises.writeFile(first.thumbnailPath, "corrupt");
    const restored = await generateGalleryThumbnail(original, 512);
    expect((await sharp(restored.thumbnailPath).metadata()).height).toBe(512);
    await sharp({
      create: { width: 800, height: 1200, channels: 3, background: "#b68229" },
    })
      .jpeg()
      .toFile(original);
    const changed = await generateGalleryThumbnail(original, 512);
    expect(changed.sourceIdentity).not.toBe(first.sourceIdentity);
    expect(changed.thumbnailPath).not.toBe(first.thumbnailPath);
  });
});
