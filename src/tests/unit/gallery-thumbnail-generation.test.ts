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
  getThumbnailDir,
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
