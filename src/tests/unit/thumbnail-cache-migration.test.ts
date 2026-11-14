/** @vitest-environment node */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import {
  deletePhotoThumbnails,
  deleteUnreferencedThumbnail,
  generateDuelPreview,
  generateGalleryThumbnail,
  generateThumbnail,
  initThumbnailer,
  stopThumbnailer,
} from "@/services/thumbnailer";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { makePreviewNewerThanSource } from "@/tests/helpers/thumbnail-fixture";

const state = vi.hoisted(() => ({ db: undefined as unknown, root: "" }));
vi.mock("electron", () => ({
  screen: { getPrimaryDisplay: () => ({ scaleFactor: 1 }) },
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.root }));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn() }),
}));
let runtime: TestRuntime;
let sqlite: Database.Database;
let original: string;
let historical: string;
let current: string;
const previousSharpCache = sharp.cache();

beforeEach(() => {
  sharp.cache(false);
  runtime = new TestRuntime("thumbnail-cache-migration");
  state.root = runtime.root;
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  original = path.join(runtime.root, "disconnected", "source.jpg");
  const cache = path.join(runtime.root, "thumbnails");
  fs.mkdirSync(cache);
  const cacheName = (generation: number) =>
    `${createHash("md5").update(`${original}_md_v${generation}_1`).digest("hex")}.webp`;
  historical = path.join(cache, cacheName(3));
  current = path.join(cache, cacheName(4));
  db.insert(photos)
    .values({
      id: 1,
      path: original,
      filename: "source.jpg",
      thumbnailPath: historical,
      sourceStatus: "unverified",
    })
    .run();
});
afterEach(async () => {
  await stopThumbnailer();
  sqlite.close();
  runtime.cleanup();
  sharp.cache({
    memory: previousSharpCache.memory.max,
    files: previousSharpCache.files.max,
    items: previousSharpCache.items.max,
  });
});

const storedPreview = () =>
  sqlite
    .prepare("SELECT thumbnail_path AS path FROM photos WHERE id=1")
    .get() as { path: string | null };
const writePreview = (file: string) =>
  sharp({
    create: { width: 80, height: 60, channels: 3, background: "#358a99" },
  })
    .webp()
    .toFile(file);

it("retains a real historical cache when the source and new cache are unavailable", async () => {
  await writePreview(historical);
  initThumbnailer();
  expect(storedPreview().path).toBe(historical);
  expect(fs.existsSync(original)).toBe(false);
  expect((await sharp(historical).metadata()).format).toBe("webp");
});

it("retains the recorded preview even when the current source path has a different legacy cache", async () => {
  await writePreview(historical);
  await writePreview(current);
  initThumbnailer();
  expect(storedPreview().path).toBe(historical);
  expect(fs.existsSync(historical)).toBe(true);
});

it("keeps a missing cache eligible for online regeneration", () => {
  initThumbnailer();
  expect(storedPreview().path).toBe(historical);
});

it("does not preserve an existing preview outside the managed cache root", async () => {
  const outside = path.join(runtime.root, "outside.webp");
  await writePreview(outside);
  sqlite.prepare("UPDATE photos SET thumbnail_path=? WHERE id=1").run(outside);
  initThumbnailer();
  expect(storedPreview().path).toBeNull();
});

it("rebases the same managed file after copying the data directory", async () => {
  await writePreview(historical);
  const previous = path.join(
    runtime.root,
    "old-data",
    "thumbnails",
    path.basename(historical)
  );
  sqlite.prepare("UPDATE photos SET thumbnail_path=? WHERE id=1").run(previous);
  initThumbnailer();
  expect(storedPreview().path).toBe(historical);
});

it("retains the recorded v3 duel preview after an offline restart", async () => {
  await fs.promises.mkdir(path.dirname(original));
  await writePreview(original);
  initThumbnailer();
  const preview = await generateDuelPreview(original);
  expect(preview).not.toBeNull();
  if (!preview) {
    throw new Error("Duel preview fixture was not generated");
  }
  sqlite
    .prepare(
      "UPDATE photos SET duel_preview_path=?, source_status='offline' WHERE id=1"
    )
    .run(preview.previewPath);
  await fs.promises.unlink(original);
  await stopThumbnailer();
  initThumbnailer();
  const stored = sqlite
    .prepare("SELECT duel_preview_path AS path FROM photos WHERE id=1")
    .get() as { path: string };
  expect(stored.path).toBe(preview.previewPath);
  expect(fs.existsSync(stored.path)).toBe(true);
});

it.each([
  "v4",
  "v5",
] as const)("keeps the moved photo's %s preview when its old path is reused", async (generation) => {
  const writeSource = (file: string, background: string) =>
    sharp({
      create: { width: 256, height: 256, channels: 3, background },
    })
      .jpeg()
      .toFile(file);
  const red = async (file: string) => (await sharp(file).raw().toBuffer())[0];
  await fs.promises.mkdir(path.dirname(original));
  await writeSource(original, "#ff0000");
  initThumbnailer();
  const first =
    generation === "v5"
      ? (await generateThumbnail(original)).thumbnailPath
      : current;
  if (generation === "v4") {
    await sharp(original).webp().toFile(first);
  }
  const moved = path.join(runtime.root, "moved.jpg");
  await fs.promises.rename(original, moved);
  sqlite
    .prepare("UPDATE photos SET path=?, thumbnail_path=? WHERE id=1")
    .run(moved, first);
  await writeSource(original, "#0000ff");
  await makePreviewNewerThanSource(original, first);

  const online = await generateGalleryThumbnail(original, 256);
  const replacement = await generateThumbnail(original);
  expect(replacement.thumbnailPath).not.toBe(first);
  expect(await red(online.thumbnailPath)).toBeLessThan(15);
  expect(await red(replacement.thumbnailPath)).toBeLessThan(15);
  expect(await red(first)).toBeGreaterThan(240);

  sqlite
    .prepare(
      "INSERT INTO photos (id, path, filename, thumbnail_path, created_at) VALUES (2, ?, ?, ?, 0)"
    )
    .run(original, "replacement.jpg", replacement.thumbnailPath);
  await stopThumbnailer();
  initThumbnailer();
  expect(storedPreview().path).toBe(first);
  expect((await generateThumbnail(original)).thumbnailPath).toBe(
    replacement.thumbnailPath
  );
  await deletePhotoThumbnails(original);
  await deleteUnreferencedThumbnail(first);
  expect(await red(first)).toBeGreaterThan(240);
  expect(await red(replacement.thumbnailPath)).toBeLessThan(15);
  sqlite.prepare("DELETE FROM photos WHERE id=1").run();
  await deleteUnreferencedThumbnail(first);
  expect(fs.existsSync(first)).toBe(false);
  expect(fs.existsSync(replacement.thumbnailPath)).toBe(true);
});
