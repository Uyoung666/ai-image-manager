/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { advancedExifData, photos } from "@/db/schema";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { releaseGalleryResources } from "@/utils/gallery-lifecycle";

const state = vi.hoisted(() => ({ db: undefined as unknown, read: vi.fn() }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("exiftool-vendored", () => ({ exiftool: { readRaw: state.read } }));
vi.mock("@/services/import-queue", () => ({
  getImportQueueStatus: () => ({ current: null }),
}));
vi.mock("@/services/photo-sequences", () => ({
  detectPhotoSequences: vi.fn(),
}));

import { runAdvancedExifEnrichment } from "@/services/advanced-exif";

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;

beforeEach(async () => {
  vi.clearAllMocks();
  runtime = new TestRuntime("advanced-exif-version");
  source = path.join(runtime.root, "photo.jpg");
  await fs.writeFile(source, "original");
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  const stat = await fs.stat(source);
  db.insert(photos)
    .values({
      id: 1,
      path: source,
      filename: "photo.jpg",
      sourceStatus: "available",
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
    })
    .run();
});

afterEach(() => {
  releaseGalleryResources();
  sqlite.close();
  runtime.cleanup();
});

it("does not recreate EXIF removed by a newer content revision", async () => {
  let release: (value: Record<string, unknown>) => void = () => undefined;
  state.read.mockImplementation(
    () =>
      new Promise<Record<string, unknown>>((resolve) => {
        release = resolve;
      })
  );
  const work = runAdvancedExifEnrichment();
  await vi.waitFor(() => expect(state.read).toHaveBeenCalledOnce());
  db.update(photos)
    .set({ contentRevision: 1, fileRevision: 1 })
    .where(eq(photos.id, 1))
    .run();
  db.delete(advancedExifData).where(eq(advancedExifData.photoId, 1)).run();
  release({ Make: "Canon", Model: "old-camera" });
  await work;
  expect(db.select().from(advancedExifData).all()).toEqual([]);
});

it("does not accept metadata read while the underlying bytes change", async () => {
  state.read.mockImplementation(async () => {
    await fs.writeFile(source, "replacement-image");
    return { Make: "Canon", Model: "old-camera" };
  });
  await runAdvancedExifEnrichment();
  expect(db.select().from(advancedExifData).get()?.status).toBe("processing");
});
