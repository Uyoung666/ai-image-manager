/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  deletePhotos,
  permanentlyDeletePhotos,
  restorePhotos,
} from "@/ipc/photos/handlers/mutations";
import {
  computeFullFileHash,
  FULL_FILE_HASH_VERSION,
} from "@/services/file-hash";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  trash: vi.fn(),
  deleteVectors: vi.fn().mockResolvedValue(undefined),
  deleteColors: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  shell: { trashItem: state.trash },
  BrowserWindow: { getAllWindows: () => [] },
}));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateStatsCache: vi.fn(),
  invalidateIndexStatsCache: vi.fn(),
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: state.deleteVectors,
  deleteColorVectors: state.deleteColors,
}));
vi.mock("@/services/photo-sequences", () => ({
  cleanupDeletedPhotoSequenceMembers: vi.fn(),
  notifySequencesChanged: vi.fn(),
}));
vi.mock("@/services/smart-album-engine", () => ({
  invalidateSmartAlbumCache: vi.fn(),
}));
vi.mock("@/services/thumbnailer", () => ({
  deletePhotoThumbnails: vi.fn(),
  deleteUnreferencedThumbnail: vi.fn(),
}));
vi.mock("@/services/indexer", () => ({
  isIndexing: () => false,
  unwatchFolder: vi.fn(),
  watchFolder: vi.fn(),
}));
vi.mock("@/services/import-queue", () => ({ isImportQueueBusy: () => false }));
vi.mock("@/services/library-content-refresh", () => ({
  invalidateLibraryPhotoContent: vi.fn(),
  wakeLibraryContentRefresh: vi.fn(),
}));
vi.mock("@/services/library-change", () => ({ notifyLibraryChange: vi.fn() }));
vi.mock("@/services/folder-matcher", () => ({ reloadFolderMatcher: vi.fn() }));

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;
let original: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state.deleteVectors.mockResolvedValue(undefined);
  runtime = new TestRuntime("library-trash-identity");
  source = path.join(runtime.root, "source");
  await fs.mkdir(source);
  original = path.join(source, "one.jpg");
  await fs.writeFile(original, "the original photo bytes");
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: source, displayName: "source", photoCount: 1 })
    .run();
  const stat = await fs.stat(original);
  db.insert(photos)
    .values({
      id: 1,
      folderId: 1,
      path: original,
      filename: "one.jpg",
      isFavorite: true,
      sourceStatus: "available",
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
      sourceHash: await computeFullFileHash(original),
      sourceHashVersion: FULL_FILE_HASH_VERSION,
      sourceHashFileRevision: 0,
    })
    .run();
  state.trash.mockImplementation((file: string) => fs.unlink(file));
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("snapshots verified identity at soft deletion and recycles the same bytes", async () => {
  const hash = db.select().from(photos).get()?.sourceHash;
  await call(deletePhotos, { ids: [1] });
  expect(db.select().from(photos).get()?.deletionSourceHash).toBe(hash);
  const result = await call(permanentlyDeletePhotos, { ids: [1] });
  expect(result).toEqual({ failed: [], succeededIds: [1] });
  expect(state.trash).toHaveBeenCalledExactlyOnceWith(original);
  expect(db.select().from(photos).all()).toEqual([]);
  expect(state.deleteVectors).toHaveBeenCalledExactlyOnceWith([1]);
  expect(state.deleteColors).toHaveBeenCalledExactlyOnceWith([1]);
});

it("keeps an offline source and its recycle request without invoking the system trash", async () => {
  await call(deletePhotos, { ids: [1] });
  await fs.rename(source, path.join(runtime.root, "detached"));
  const result = await call(permanentlyDeletePhotos, { ids: [1] });
  expect(result.succeededIds).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(state.trash).not.toHaveBeenCalled();
  expect(db.select().from(photos).get()?.deletedAt).not.toBeNull();
});

it("refuses to recycle replacement bytes at the same path", async () => {
  await call(deletePhotos, { ids: [1] });
  await fs.writeFile(original, "replacement photo bytes");
  const result = await call(permanentlyDeletePhotos, { ids: [1] });
  expect(result.succeededIds).toEqual([]);
  expect(result.failed).toHaveLength(1);
  expect(state.trash).not.toHaveBeenCalled();
  expect(await fs.readFile(original, "utf8")).toBe("replacement photo bytes");
  expect(db.select().from(photos).all()).toHaveLength(1);
});

it("keeps legacy deletion requests when no verified identity was captured", async () => {
  db.update(photos)
    .set({ sourceHashFileRevision: null })
    .where(eq(photos.id, 1))
    .run();
  await call(deletePhotos, { ids: [1] });
  const result = await call(permanentlyDeletePhotos, { ids: [1] });
  expect(result.succeededIds).toEqual([]);
  expect(state.trash).not.toHaveBeenCalled();
  expect(db.select().from(photos).get()?.deletionSourceHash).toBeNull();
});

it("restores catalogue state and favourite information while the source stays offline", async () => {
  await call(deletePhotos, { ids: [1] });
  await fs.rename(source, path.join(runtime.root, "detached"));
  const result = await call(restorePhotos, { ids: [1] });
  expect(result.succeededIds).toEqual([1]);
  expect(db.select().from(photos).get()).toMatchObject({
    id: 1,
    sourceStatus: "offline",
    isFavorite: true,
    deletedAt: null,
    deletionSourceHash: null,
  });
  expect(db.select().from(folders).get()?.photoCount).toBe(1);
});

it("keeps a failed system recycle operation retryable", async () => {
  await call(deletePhotos, { ids: [1] });
  state.trash.mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" })
  );
  const result = await call(permanentlyDeletePhotos, { ids: [1] });
  expect(result.succeededIds).toEqual([]);
  expect(db.select().from(photos).all()).toHaveLength(1);
  expect(
    (await call(permanentlyDeletePhotos, { ids: [1] })).succeededIds
  ).toEqual([1]);
});
