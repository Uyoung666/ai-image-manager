/** @vitest-environment node */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { appSettings, photos } from "@/db/schema";
import { runColorMigration } from "@/services/color-migration";
import { releaseGalleryResources } from "@/utils/gallery-lifecycle";

const fixture = vi.hoisted(() => ({
  db: undefined as unknown,
  extract: vi.fn<(image: string | Buffer) => Promise<string | null>>(),
  invalidate: vi.fn(),
  read: vi.fn<(thumbnail: string) => Promise<Buffer>>(),
}));

vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: fixture.read,
}));
vi.mock("@/db", () => ({ getDatabase: () => fixture.db }));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: fixture.extract,
  invalidateColorCache: fixture.invalidate,
}));

const source = {
  id: 1,
  filename: "original.jpg",
  path: "original.jpg",
  thumbnailPath: "thumbnail.webp",
  sourceStatus: "available",
  contentRevision: 2,
  fileRevision: 3,
  metadataRevision: 2,
} as const;
const palette = JSON.stringify([{ hue: 237.5, weight: 1 }]);
const thumbnailBytes = Buffer.from("synthetic thumbnail bytes");
const connections: Database.Database[] = [];
type TestDatabase = ReturnType<typeof drizzle>;
let db: TestDatabase;

function createDatabase() {
  const sqlite = new Database(":memory:");
  connections.push(sqlite);
  const result = drizzle(sqlite);
  migrate(result, { migrationsFolder: "drizzle" });
  result.insert(photos).values(source).run();
  return result;
}

function readPhoto(database = db) {
  return database.select().from(photos).where(eq(photos.id, source.id)).get();
}

function readMarker(database = db) {
  return database
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "colors_migrated"))
    .get()?.value;
}

function delayExtraction() {
  const started = Promise.withResolvers<void>();
  const result = Promise.withResolvers<string | null>();
  fixture.extract.mockImplementationOnce(() => {
    started.resolve();
    return result.promise;
  });
  return { started: started.promise, finish: result.resolve };
}

beforeEach(() => {
  fixture.extract.mockReset().mockResolvedValue(palette);
  fixture.invalidate.mockClear();
  fixture.read.mockReset().mockResolvedValue(thumbnailBytes);
  db = createDatabase();
  fixture.db = db;
});

afterEach(() => {
  releaseGalleryResources();
  for (const connection of connections.splice(0)) {
    connection.close();
  }
});

it("fills the current palette and hue bucket before marking the pass complete", async () => {
  await expect(runColorMigration()).resolves.toEqual({
    processed: 1,
    total: 1,
    complete: true,
  });
  expect(fixture.read).toHaveBeenCalledExactlyOnceWith(source.thumbnailPath);
  expect(fixture.extract).toHaveBeenCalledExactlyOnceWith(thumbnailBytes);
  expect(readPhoto()).toMatchObject({
    dominantColors: palette,
    colorBucket: 23,
  });
  expect(readMarker()).toBe("true");
  expect(fixture.invalidate).toHaveBeenCalledOnce();
});

it("rejects a palette extracted before same-path content replacement", async () => {
  const extraction = delayExtraction();
  const run = runColorMigration();
  await extraction.started;
  db.update(photos)
    .set({ contentRevision: 3, metadataRevision: 3, fileRevision: 4 })
    .where(eq(photos.id, source.id))
    .run();
  extraction.finish(palette);
  await run;
  expect(readPhoto()).toMatchObject({
    path: source.path,
    thumbnailPath: source.thumbnailPath,
    contentRevision: 3,
    dominantColors: null,
    colorBucket: null,
  });
});

it("preserves a palette committed by another writer for the same version", async () => {
  const extraction = delayExtraction();
  const run = runColorMigration();
  await extraction.started;
  const newerPalette = JSON.stringify([{ hue: 42, weight: 1 }]);
  db.update(photos)
    .set({ dominantColors: newerPalette, colorBucket: 4 })
    .where(eq(photos.id, source.id))
    .run();
  extraction.finish(palette);
  await run;
  expect(readPhoto()).toMatchObject({
    dominantColors: newerPalette,
    colorBucket: 4,
  });
});

it("abandons a pending extraction when the runtime generation is released", async () => {
  const marker = readMarker();
  const extraction = delayExtraction();
  const run = runColorMigration();
  await extraction.started;
  releaseGalleryResources();
  extraction.finish(palette);
  await expect(run).resolves.toMatchObject({ complete: false });
  expect(readPhoto()).toMatchObject({
    dominantColors: null,
    colorBucket: null,
  });
  expect(readMarker()).toBe(marker);
  expect(fixture.invalidate).not.toHaveBeenCalled();
});

it("does not write to either database after the data directory switches", async () => {
  const replacement = createDatabase();
  const markers = [readMarker(), readMarker(replacement)];
  const extraction = delayExtraction();
  const run = runColorMigration();
  await extraction.started;
  fixture.db = replacement;
  extraction.finish(palette);
  await expect(run).resolves.toMatchObject({ complete: false });
  for (const [index, database] of [db, replacement].entries()) {
    expect(readPhoto(database)).toMatchObject({
      dominantColors: null,
      colorBucket: null,
    });
    expect(readMarker(database)).toBe(markers[index]);
  }
  expect(fixture.invalidate).not.toHaveBeenCalled();
});
