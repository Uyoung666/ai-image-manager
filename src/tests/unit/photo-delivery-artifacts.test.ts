/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { call, type InferRouterInputs } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import exifr from "exifr";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import yauzl from "yauzl";
import { appSettings, exifData, photos, photoTags, tags } from "@/db/schema";
import { exportPhotos } from "@/ipc/photos/handlers/export";
import { generateSharePage } from "@/services/share-page";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ db: undefined as unknown, cache: "" }));
const JPEG_PREVIEW = /data:image\/jpeg;base64,([^"]+)/;
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/thumbnailer", () => ({
  getThumbnailDir: () => state.cache,
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let runtime: TestRuntime;

beforeEach(() => {
  runtime = new TestRuntime("photo-delivery-artifacts");
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  state.db = db;
  state.cache = runtime.root;
  migrate(db, { migrationsFolder: "drizzle" });
});

afterEach(() => {
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

function testImage(width: number, height: number) {
  return sharp({
    create: { width, height, channels: 3, background: "#486080" },
  });
}

async function addPhoto(filename: string, source: Buffer) {
  const file = path.join(runtime.root, filename);
  await fs.promises.writeFile(file, source);
  const [metadata, stat] = await Promise.all([
    sharp(source).metadata(),
    fs.promises.stat(file),
  ]);
  return db
    .insert(photos)
    .values({
      filename,
      path: file,
      width: metadata.width,
      height: metadata.height,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
    })
    .returning({ id: photos.id })
    .get().id;
}

function withLocation(image: sharp.Sharp) {
  return image.withExif({
    IFD0: { Artist: "PRIVATE_ARTIST" },
    IFD3: {
      GPSLatitudeRef: "N",
      GPSLatitude: "30/1 0/1 0/1",
      GPSLongitudeRef: "E",
      GPSLongitude: "120/1 0/1 0/1",
    },
  });
}

function saveWatermark(settings: object) {
  db.insert(appSettings)
    .values({
      key: "watermark_settings",
      value: JSON.stringify({ enabled: true, ...settings }),
    })
    .run();
}

function unzip(buffer: Buffer): Promise<Map<string, Buffer>> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (error, zip) => {
      if (error || !zip) {
        reject(error ?? new Error("ZIP unavailable"));
        return;
      }
      const entries = new Map<string, Buffer>();
      zip.on("error", reject);
      zip.on("end", () => resolve(entries));
      zip.on("entry", (entry) => {
        zip.openReadStream(entry, async (readError, stream) => {
          if (readError || !stream) {
            reject(readError ?? new Error("ZIP entry unavailable"));
            return;
          }
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of stream) {
              chunks.push(chunk as Buffer);
            }
            entries.set(entry.fileName, Buffer.concat(chunks));
            zip.readEntry();
          } catch (streamError) {
            reject(streamError);
          }
        });
      });
      zip.readEntry();
    });
  });
}

type ArchiveInput = InferRouterInputs<{
  exportPhotos: typeof exportPhotos;
}>["exportPhotos"];

async function exportArchive(input: ArchiveInput) {
  const outputPath = path.join(runtime.root, "delivery.zip");
  const result = await call(exportPhotos, { ...input, outputPath });
  if (!result.success) {
    throw new Error(result.error);
  }
  return unzip(await fs.promises.readFile(outputPath));
}

function entry(archive: Map<string, Buffer>, name: string): Buffer {
  const contents = archive.get(name);
  if (!contents) {
    throw new Error(`Missing ZIP entry: ${name}`);
  }
  return contents;
}

it("honors width and text watermark after rotation while keeping original exports byte-for-byte", async () => {
  const source = await withLocation(
    testImage(800, 1600).withMetadata({ orientation: 6 })
  )
    .jpeg()
    .toBuffer();
  const id = await addPhoto("CLIENT-PROOF.jpg", source);
  saveWatermark({ text: "PROOF", opacity: 100 });
  const options = {
    ids: [id],
    format: "compressed",
    maxWidth: 640,
  } satisfies ArchiveInput;
  const plain = entry(
    await exportArchive({ ...options, ids: [id], applyWatermark: false }),
    "photos/photo-0001.jpg"
  );
  const archive = await exportArchive({
    ...options,
    ids: [id],
    applyWatermark: true,
  });
  const marked = entry(archive, "photos/photo-0001.jpg");
  for (const bytes of [plain, marked]) {
    expect(await sharp(bytes).metadata()).toMatchObject({
      format: "jpeg",
      width: 640,
      height: 320,
    });
    expect(await exifr.gps(bytes)).toBeUndefined();
  }
  expect(entry(archive, "index.html").toString()).toContain('"w":640,"h":320');
  const pixels = await sharp(marked).raw().toBuffer();
  expect(pixels.some((value) => value > 210)).toBe(true);
  expect(
    (await sharp(plain).raw().toBuffer()).some((value) => value > 210)
  ).toBe(false);
  const original = entry(
    await exportArchive({ ids: [id], format: "original" }),
    "photos/CLIENT-PROOF.jpg"
  );
  expect(original.equals(source)).toBe(true);
  expect(await exifr.gps(original)).toEqual({ latitude: 30, longitude: 120 });
}, 20_000);

it("limits the displayed width and keeps TIFF originals separate from full-size watermarked JPEGs", async () => {
  const rotated = await testImage(600, 1500)
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const rotatedId = await addPhoto("Second-angle.jpg", rotated);
  const archive = await exportArchive({
    ids: [rotatedId],
    format: "compressed",
    maxWidth: 640,
  });
  expect(
    await sharp(entry(archive, "photos/photo-0001.jpg")).metadata()
  ).toMatchObject({ width: 640, height: 256 });
  const tiff = await testImage(800, 450).tiff().toBuffer();
  const tiffId = await addPhoto("Studio.tif", tiff);
  saveWatermark({ text: "PROOF" });
  expect(
    entry(await exportArchive({ ids: [tiffId] }), "photos/Studio.tif").equals(
      tiff
    )
  ).toBe(true);
  const jpeg = await exportArchive({
    ids: [tiffId],
    format: "compressed",
    maxWidth: null,
    applyWatermark: true,
    disclosure: { filenames: true },
  });
  expect(
    await sharp(entry(jpeg, "photos/Studio.jpg")).metadata()
  ).toMatchObject({ format: "jpeg", width: 800, height: 450 });
});

it("keeps an existing archive when any photo fails and removes staging files", async () => {
  const source = await testImage(80, 40).jpeg().toBuffer();
  const first = await addPhoto("First.jpg", source);
  const second = await addPhoto("Second.jpg", source);
  await fs.promises.writeFile(
    path.join(runtime.root, "Second.jpg"),
    "invalid photo"
  );
  db.update(photos).set({ sourceSize: null }).run();
  const outputPath = path.join(runtime.root, "delivery.zip");
  const original = await exportArchive({ ids: [first] });
  const before = await fs.promises.readFile(outputPath);
  expect(original.has("photos/First.jpg")).toBe(true);
  const result = await call(exportPhotos, {
    ids: [first, second],
    format: "compressed",
    outputPath,
  });
  expect(result).toMatchObject({
    success: false,
    error: expect.stringContaining("Second.jpg"),
  });
  saveWatermark({
    mode: "image",
    imagePath: path.join(runtime.root, "missing.png"),
  });
  await expect(
    call(exportPhotos, {
      ids: [first],
      format: "compressed",
      applyWatermark: true,
      outputPath,
    })
  ).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining("First.jpg"),
  });
  expect((await fs.promises.readFile(outputPath)).equals(before)).toBe(true);
  expect(
    (await fs.promises.readdir(runtime.root)).some((name) =>
      name.startsWith(".aim-export-")
    )
  ).toBe(false);
});

it("applies disclosure to both HTML outputs and strips cached preview metadata", async () => {
  const source = await withLocation(testImage(800, 400)).jpeg().toBuffer();
  const id = await addPhoto("PRIVATE_FILENAME.jpg", source);
  const thumbnailPath = path.join(runtime.root, "cached.webp");
  await withLocation(testImage(800, 400)).webp().toFile(thumbnailPath);
  expect(
    (await sharp(await fs.promises.readFile(thumbnailPath)).metadata()).exif
  ).toBeDefined();
  db.update(photos).set({ thumbnailPath }).run();
  db.insert(exifData)
    .values({
      photoId: id,
      cameraModel: "PRIVATE_CAMERA",
      dateTaken: Date.UTC(2024, 1, 1),
      gpsLatitude: 30,
      artist: "PRIVATE_ARTIST",
    })
    .run();
  const inputTags = [
    {
      name: "MANUAL_TAG",
      origin: "manual",
      userConfirmed: false,
      isConfirmed: true,
    },
    {
      name: "REVIEWED_TAG",
      origin: "auto",
      userConfirmed: true,
      isConfirmed: true,
    },
    {
      name: "AUTO_ONLY_TAG",
      origin: "auto",
      userConfirmed: false,
      isConfirmed: true,
    },
  ] as const;
  for (const { name, ...attributes } of inputTags) {
    const tagId = db
      .insert(tags)
      .values({ name })
      .returning({ id: tags.id })
      .get().id;
    db.insert(photoTags)
      .values({ photoId: id, tagId, ...attributes })
      .run();
  }
  const options = {
    ids: [id],
    format: "compressed",
    locale: "en-US",
  } satisfies ArchiveInput;
  const hiddenZip = await exportArchive(options);
  const hiddenShare = await generateSharePage([id], "en-US");
  for (const html of [entry(hiddenZip, "index.html").toString(), hiddenShare]) {
    expect(html).toContain("photo-0001");
    for (const key of ['"tags":', '"dt":', '"c":', '"l":']) {
      expect(html).not.toContain(key);
    }
    for (const secret of [
      "PRIVATE_FILENAME",
      "PRIVATE_CAMERA",
      "MANUAL_TAG",
      "REVIEWED_TAG",
      "AUTO_ONLY_TAG",
    ]) {
      expect(html).not.toContain(secret);
    }
  }
  const disclosure = { filenames: true, captureDetails: true, tags: true };
  const disclosedZip = await exportArchive({ ...options, disclosure });
  const disclosedShare = await generateSharePage([id], "en-US", disclosure);
  expect(
    await exifr.gps(entry(disclosedZip, "photos/PRIVATE_FILENAME.jpg"))
  ).toBeUndefined();
  for (const html of [
    entry(disclosedZip, "index.html").toString(),
    disclosedShare,
  ]) {
    for (const allowed of [
      "PRIVATE_FILENAME",
      "PRIVATE_CAMERA",
      "2024",
      "MANUAL_TAG",
      "REVIEWED_TAG",
    ]) {
      expect(html).toContain(allowed);
    }
    expect(html).not.toContain("AUTO_ONLY_TAG");
    expect(html).not.toContain("PRIVATE_ARTIST");
  }
  const preview = JPEG_PREVIEW.exec(disclosedShare)?.[1];
  expect(preview).toBeTruthy();
  const metadata = await sharp(Buffer.from(preview ?? "", "base64")).metadata();
  expect(metadata).toMatchObject({ format: "jpeg", width: 600, height: 300 });
  expect(metadata.exif).toBeUndefined();
});
