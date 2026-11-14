/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  albumPhotos,
  albums,
  cullSessionPhotos,
  cullSessions,
  faceVectors,
  folders,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import {
  computeFullFileHash,
  FULL_FILE_HASH_VERSION,
} from "@/services/file-hash";
import {
  applyLibraryRelink,
  inspectFolderRelink,
  inspectPhotoRelink,
} from "@/services/library-relink";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  busy: false,
  invalidate: vi.fn(),
  wake: vi.fn(),
  notify: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/indexer", () => ({
  getSupportedExtensions: () => [".jpg"],
  isIndexing: () => state.busy,
  watchFolder: vi.fn(),
  unwatchFolder: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/import-queue", () => ({
  isImportQueueBusy: () => state.busy,
}));
vi.mock("@/services/library-change", () => ({
  notifyLibraryChange: state.notify,
}));
vi.mock("@/services/library-content-refresh", () => ({
  invalidateLibraryPhotoContent: state.invalidate,
  wakeLibraryContentRefresh: state.wake,
}));
vi.mock("@/services/folder-matcher", () => ({
  reloadFolderMatcher: vi.fn(),
  getFolderMatcher: () => ({ match: () => null }),
}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let runtime: TestRuntime;
let source: string;
let target: string;
beforeEach(async () => {
  vi.clearAllMocks();
  state.busy = false;
  runtime = new TestRuntime("library-relink");
  source = path.join(runtime.root, "source");
  target = path.join(runtime.root, "target");
  await fs.mkdir(source);
  await fs.mkdir(target);
  await fs.writeFile(path.join(source, "one.jpg"), "original pixels");
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({
      id: 1,
      path: source,
      displayName: "original",
      appearanceColor: "#aa6600",
      photoCount: 1,
    })
    .run();
  const original = path.join(source, "one.jpg");
  const stat = await fs.stat(original);
  db.insert(photos)
    .values({
      id: 1,
      path: original,
      filename: "one.jpg",
      folderId: 1,
      isFavorite: true,
      fileSize: stat.size,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
      sourceHash: await computeFullFileHash(original),
      sourceHashVersion: FULL_FILE_HASH_VERSION,
      sourceHashFileRevision: 0,
      sourceStatus: "available",
    })
    .run();
  db.insert(tags).values({ id: 1, name: "manual" }).run();
  db.insert(photoTags).values({ photoId: 1, tagId: 1, origin: "manual" }).run();
  db.insert(albums).values({ id: 1, name: "album" }).run();
  db.insert(albumPhotos).values({ albumId: 1, photoId: 1 }).run();
  db.insert(faceVectors)
    .values({ photoId: 1, bboxX: 0, bboxY: 0, bboxWidth: 1, bboxHeight: 1 })
    .run();
  db.insert(cullSessions)
    .values({ id: 1, name: "review", mode: "curate" })
    .run();
  db.insert(cullSessionPhotos)
    .values({ sessionId: 1, photoId: 1, status: "kept" })
    .run();
});
afterEach(() => {
  sqlite.close();
  runtime.cleanup();
});

function expectRelationships() {
  expect(db.select().from(photos).get()?.id).toBe(1);
  expect(db.select().from(photos).get()?.isFavorite).toBe(true);
  expect(db.select().from(photoTags).all().length).toBe(1);
  expect(db.select().from(albumPhotos).all().length).toBe(1);
  expect(db.select().from(faceVectors).all().length).toBe(1);
  expect(db.select().from(cullSessionPhotos).all().length).toBe(1);
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
}

it("relocates a folder atomically while preserving IDs, appearance and relationships", async () => {
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  expect(preview.items[0].status).toBe("matched");
  expect(await applyLibraryRelink(preview.token, [])).toEqual({ updated: 1 });
  expect(db.select().from(folders).get()).toMatchObject({
    id: 1,
    path: target,
    appearanceColor: "#aa6600",
  });
  expect(db.select().from(photos).get()).toMatchObject({
    path: path.join(target, "one.jpg"),
    contentRevision: 0,
    fileRevision: 1,
  });
  expect(state.invalidate).not.toHaveBeenCalled();
  expectRelationships();
});

it("moves an individual photo to an explicit folder without importing neighbours", async () => {
  const destination = path.join(target, "renamed.jpg");
  await fs.rename(path.join(source, "one.jpg"), destination);
  await fs.writeFile(path.join(target, "unselected.jpg"), "other");
  const preview = await inspectPhotoRelink(1, destination);
  await applyLibraryRelink(preview.token, []);
  expect(db.select().from(photos).all().length).toBe(1);
  const moved = db.select().from(photos).get();
  expect(moved?.path).toBe(destination);
  expect(
    db
      .select()
      .from(folders)
      .where(eq(folders.id, moved?.folderId ?? -1))
      .get()?.explicitOnly
  ).toBe(true);
  expectRelationships();
});

it("requires explicit confirmation for old records without trustworthy hashes", async () => {
  db.update(photos).set({ sourceHashVersion: null }).run();
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  expect(preview.unverifiedPhotoIds).toEqual([1]);
  await expect(applyLibraryRelink(preview.token, [])).rejects.toThrow(
    "CONFIRMATION"
  );
  await applyLibraryRelink(preview.token, [1]);
  expect(db.select().from(photos).get()).toMatchObject({
    contentRevision: 1,
    refreshStatus: "pending",
    isAiProcessed: false,
  });
  expect(state.invalidate).toHaveBeenCalledWith(expect.anything(), 1, 1, false);
  expectRelationships();
});

it("refuses a copy while the original still exists", async () => {
  await fs.copyFile(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  expect(preview.canApply).toBe(false);
  expect(preview.items[0].status).toBe("conflict");
  expectRelationships();
});

it("rejects stale previews after catalogue changes", async () => {
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  db.update(photos).set({ fileRevision: 1 }).run();
  await expect(applyLibraryRelink(preview.token, [])).rejects.toThrow("STALE");
  expect(db.select().from(folders).get()?.path).toBe(source);
  expectRelationships();
});

it("rejects a changed target without updating any paths", async () => {
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  await fs.writeFile(path.join(target, "one.jpg"), "replacement pixels");
  await expect(applyLibraryRelink(preview.token, [])).rejects.toThrow("STALE");
  expect(db.select().from(folders).get()?.path).toBe(source);
  expectRelationships();
});

it("preserves missing children when a partially available root is reassociated", async () => {
  db.insert(photos)
    .values({
      id: 2,
      path: path.join(source, "missing.jpg"),
      filename: "missing.jpg",
      folderId: 1,
    })
    .run();
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  expect(preview.counts.missing).toBe(1);
  await applyLibraryRelink(preview.token, []);
  expect(db.select().from(photos).where(eq(photos.id, 2)).get()).toMatchObject({
    path: path.join(target, "missing.jpg"),
    sourceStatus: "missing",
  });
});

it("rejects expired tokens and a switched database", async () => {
  await fs.rename(path.join(source, "one.jpg"), path.join(target, "one.jpg"));
  const preview = await inspectFolderRelink(1, target);
  const now = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 600_001);
  await expect(applyLibraryRelink(preview.token, [])).rejects.toThrow(
    "EXPIRED"
  );
  now.mockRestore();
  const second = await inspectFolderRelink(1, target);
  state.db = drizzle(sqlite);
  await expect(applyLibraryRelink(second.token, [])).rejects.toThrow("EXPIRED");
});
