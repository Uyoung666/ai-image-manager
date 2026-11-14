/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { thumbnailSourceIdentity } from "@/services/thumbnail-identity";
import {
  clearThumbnailDiskCache,
  deletePhotoThumbnails,
  generateDuelPreview,
  generateGalleryThumbnail,
  generateThumbnail,
  getGalleryThumbnailHint,
  getThumbnailDir,
  getThumbnailPath,
  getVersionedThumbnailPath,
  initThumbnailer,
  preserveRelinkThumbnail,
  stopThumbnailer,
  thumbnailGenerationSlots,
} from "@/services/thumbnailer";
import { heifFixturePath } from "@/tests/helpers/heif-fixture";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { makePreviewNewerThanSource } from "@/tests/helpers/thumbnail-fixture";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ all: () => [], where: () => ({ get: () => undefined }) }),
    }),
    transaction: vi.fn(),
  }),
}));
let runtime: TestRuntime;
let original: string;
const previousSharpCache = sharp.cache();

it("keeps comparison preview pixels separate after an overwrite", async () => {
  const prior = await generateDuelPreview(original);
  expect(prior).not.toBeNull();
  await sharp({
    create: { width: 300, height: 150, channels: 3, background: "#f0272f" },
  })
    .jpeg()
    .toFile(original);
  const next = await generateDuelPreview(original);
  expect(next?.previewPath).not.toBe(prior?.previewPath);
  const pixels = await sharp(next?.previewPath ?? "")
    .raw()
    .toBuffer();
  expect(pixels[0]).toBeGreaterThan(200);
  expect(pixels[1]).toBeLessThan(80);
});

function legacyEvidence(thumbnailPath: string) {
  const source = fs.statSync(original);
  return {
    thumbnailPath,
    sourceSize: source.size,
    sourceMtimeMs: source.mtimeMs,
    sourceCtimeMs: source.ctimeMs,
    metadataRevision: 0,
    contentRevision: 0,
  };
}
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
  it("serves a relinked HEIF viewport from its preview without reading the original again", async () => {
    const input = path.join(runtime.root, "source.heic");
    await fs.promises.copyFile(heifFixturePath, input);
    const source = await fs.promises.stat(input);
    const preview = await generateThumbnail(input);
    const destination = path.join(runtime.root, "relinked.heic");
    await fs.promises.rename(input, destination);
    const started = performance.now();
    const transferred = await preserveRelinkThumbnail(input, destination, {
      thumbnailPath: preview.thumbnailPath,
      metadataRevision: 0,
      contentRevision: 0,
      sourceSize: source.size,
      sourceMtimeMs: source.mtimeMs,
      sourceCtimeMs: source.ctimeMs,
    });
    const committedAt = performance.now();
    expect(transferred).toBeTruthy();
    const read = vi.spyOn(fs.promises, "readFile");
    const decode = vi.spyOn(
      await import("@/services/heif-input"),
      "resolveHeifInput"
    );
    try {
      await generateGalleryThumbnail(destination, 256);
      expect(decode.mock.calls.some(([file]) => file === destination)).toBe(
        false
      );
      expect(read.mock.calls.some(([file]) => file === destination)).toBe(
        false
      );
      console.log(
        "RELINK_PREVIEW_EVIDENCE",
        JSON.stringify({
          transferMs: committedAt - started,
          viewportMs: performance.now() - committedAt,
          originalReads: 0,
        })
      );
    } finally {
      decode.mockRestore();
      read.mockRestore();
    }
  });
  it("releases original files after decoding with the production Sharp cache enabled", async () => {
    sharp.cache({ memory: 50, files: 20, items: 100 });
    const replacement = path.join(runtime.root, "replacement.jpg");
    const bytes = await sharp({
      create: { width: 80, height: 60, channels: 3, background: "red" },
    })
      .jpeg()
      .toBuffer();
    await fs.promises.writeFile(replacement, bytes);
    await generateThumbnail(original);
    await generateGalleryThumbnail(original, 256);
    await fs.promises.copyFile(replacement, original);
    expect(await fs.promises.readFile(original)).toEqual(bytes);
  });

  it("transfers only the version-owned preview when full-content relinking is proven", async () => {
    const source = await fs.promises.stat(original);
    const preview = await generateThumbnail(original);
    const destination = path.join(runtime.root, "relocated.jpg");
    await fs.promises.rename(original, destination);
    const evidence = {
      thumbnailPath: preview.thumbnailPath,
      metadataRevision: 0,
      contentRevision: 0,
      sourceSize: source.size,
      sourceMtimeMs: source.mtimeMs,
      sourceCtimeMs: source.ctimeMs,
    };
    const transferred = await preserveRelinkThumbnail(
      original,
      destination,
      evidence
    );
    expect(transferred).toBeTruthy();
    expect(await fs.promises.readFile(transferred ?? "")).toEqual(
      await fs.promises.readFile(preview.thumbnailPath)
    );
    expect((await generateThumbnail(destination)).thumbnailPath).toBe(
      transferred
    );
    expect(
      await preserveRelinkThumbnail(original, destination, {
        ...evidence,
        metadataRevision: -1,
      })
    ).toBeUndefined();
    await fs.promises.writeFile(preview.thumbnailPath, "damaged cache");
    expect(
      await preserveRelinkThumbnail(original, destination, evidence)
    ).toBeUndefined();
  });
  it("does not reuse an old in-flight preview or remove the replacement after an overwrite", async () => {
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: "#ff0000" },
    })
      .jpeg()
      .toFile(original);
    const source = fs.statSync(original);
    const identity = thumbnailSourceIdentity(source);
    const destination = getVersionedThumbnailPath(original, "md", identity);
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const rename = fs.promises.rename.bind(fs.promises);
    let first = true;
    const interception = vi
      .spyOn(fs.promises, "rename")
      .mockImplementation(async (source, target) => {
        if (target === destination && first) {
          first = false;
          entered();
          await blocked;
        }
        return rename(source, target);
      });
    const oldResult = generateThumbnail(original, "md", {
      expectedIdentity: identity,
    }).catch((error: unknown) => error);
    await writing;
    await sharp({
      create: { width: 80, height: 60, channels: 3, background: "#0000ff" },
    })
      .jpeg()
      .toFile(original);
    await fs.promises.utimes(original, new Date(0), new Date(0));
    const refreshed = generateThumbnail(original);
    try {
      const result = await refreshed;
      release();
      const { data } = await sharp(result.buffer)
        .raw()
        .toBuffer({ resolveWithObject: true });
      expect(data[2]).toBeGreaterThan(240);
      expect(data[0]).toBeLessThan(15);
      expect(await oldResult).toBeInstanceOf(Error);
      expect(fs.existsSync(destination)).toBe(false);
      expect(fs.existsSync(result.thumbnailPath)).toBe(true);
      await expect(
        generateThumbnail(original, "md", { expectedIdentity: identity })
      ).rejects.toThrow("Source changed");
    } finally {
      release();
      await oldResult;
      await refreshed.catch(() => undefined);
      interception.mockRestore();
    }
  });
  it("does not create generation work when cancelled during versioned preview lookup", async () => {
    const actualStat = fs.promises.stat.bind(fs.promises);
    const preview = getVersionedThumbnailPath(
      original,
      "md",
      thumbnailSourceIdentity(fs.statSync(original))
    );
    let resume: (() => void) | undefined;
    const stat = vi.spyOn(fs.promises, "stat").mockImplementation((file) =>
      String(file) === preview
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
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
    const preview = getThumbnailPath(original, "md");
    const large = await sharp(original)
      .rotate()
      .resize(1024, 1024, { fit: "inside" })
      .webp()
      .toBuffer();
    await fs.promises.writeFile(preview, large);
    // A readable source identity with undecodable pixels proves the preview is
    // used as input. Make the preview newer than this deliberately bad source.
    await fs.promises.writeFile(
      original,
      "source pixels intentionally unavailable"
    );
    await makePreviewNewerThanSource(original, preview);
    const evidence = legacyEvidence(preview);
    for (const edge of [256, 512] as const) {
      const result = await generateGalleryThumbnail(
        original,
        edge,
        undefined,
        0,
        undefined,
        false,
        false,
        evidence
      );
      expect(Math.max(result.width, result.height)).toBe(edge);
      expect(result.thumbnailPath).not.toBe(preview);
      const write = vi.spyOn(fs.promises, "rename");
      expect(
        (await generateGalleryThumbnail(original, edge)).thumbnailPath
      ).toBe(result.thumbnailPath);
      expect(write).not.toHaveBeenCalled();
      write.mockRestore();
    }
  });
  it("directly reuses an exactly sized legacy preview", async () => {
    const preview = getThumbnailPath(original, "md");
    await sharp(original)
      .rotate()
      .resize(512, 512, { fit: "inside" })
      .webp()
      .toFile(preview);
    await makePreviewNewerThanSource(original, preview);
    const evidence = legacyEvidence(preview);
    const result = await generateGalleryThumbnail(
      original,
      512,
      undefined,
      0,
      undefined,
      false,
      false,
      evidence
    );
    expect(result.thumbnailPath).toBe(preview);
    expect(Math.max(result.width, result.height)).toBe(512);
    expect(
      (await generateGalleryThumbnail(original, 512)).thumbnailPath
    ).not.toBe(preview);
  });
  it("does not treat a preview with unapplied orientation as an upright input", async () => {
    const preview = await generateThumbnail(original, "md");
    await fs.promises.writeFile(
      preview.thumbnailPath,
      await sharp(original)
        .resize(1024, 1024, { fit: "inside" })
        .withMetadata({ orientation: 6 })
        .webp()
        .toBuffer()
    );
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
  it("repairs an exactly sized preview from the source without reusing its readable damaged metadata", async () => {
    const preview = await generateThumbnail(original, "md");
    await fs.promises.writeFile(
      preview.thumbnailPath,
      await sharp(preview.thumbnailPath)
        .resize(512, 512, { fit: "inside" })
        .webp()
        .toBuffer()
    );
    await damagePixels(preview.thumbnailPath);
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
  it.each([
    0, 1000,
  ])("does not trust a legacy preview at or before the source change (source ahead by %i ms)", async (offset) => {
    const preview = getThumbnailPath(original, "md");
    await sharp(original).rotate().resize(512).webp().toFile(preview);
    const replacement = await sharp({
      create: { width: 700, height: 700, channels: 3, background: "#b68229" },
    })
      .jpeg()
      .toBuffer();
    await fs.promises.writeFile(original, replacement);
    const timestamp = fs.statSync(preview).mtimeMs + offset;
    const tiedSource = Object.assign(fs.statSync(original), {
      mtimeMs: timestamp,
      ctimeMs: timestamp,
      birthtimeMs: timestamp,
    });
    const actualStat = fs.promises.stat.bind(fs.promises);
    const evidence = {
      ...legacyEvidence(preview),
      sourceMtimeMs: timestamp,
      sourceCtimeMs: timestamp,
    };
    const stat = vi
      .spyOn(fs.promises, "stat")
      .mockImplementation((file) =>
        String(file) === original
          ? Promise.resolve(tiedSource)
          : actualStat(file)
      );
    try {
      expect(
        await getGalleryThumbnailHint(
          { path: original, width: 700, height: 700 },
          512,
          tiedSource,
          (file) => actualStat(file).catch(() => undefined),
          evidence
        )
      ).toBeUndefined();
      const result = await generateGalleryThumbnail(
        original,
        512,
        undefined,
        0,
        {
          width: 700,
          height: 700,
        },
        false,
        false,
        evidence
      );
      expect(result.thumbnailPath).not.toBe(preview);
      expect(result).toMatchObject({ width: 512, height: 512 });
    } finally {
      stat.mockRestore();
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
    await makePreviewNewerThanSource(original, preview.thumbnailPath);
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
