/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  thumbnails: vi.fn(),
  vectors: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: state.vectors,
}));
vi.mock("@/services/thumbnailer", () => ({
  deletePhotoThumbnails: state.thumbnails,
  generateThumbnail: vi.fn(),
}));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: vi.fn(),
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: vi.fn(),
}));
vi.mock("@/services/folder-matcher", () => ({
  getFolderMatcher: vi.fn(),
  reloadFolderMatcher: vi.fn(),
}));
vi.mock("@/services/raw-preview", () => ({
  extractRawPreview: vi.fn(),
  isRawFile: () => false,
  readRawDimensions: vi.fn(),
}));

import { cleanupOrphanedRecordsAsync } from "@/services/indexer";

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;
const absent = () => Object.assign(new Error("missing"), { code: "ENOENT" });

beforeEach(() => {
  vi.clearAllMocks();
  state.thumbnails.mockResolvedValue(undefined);
  state.vectors.mockResolvedValue(undefined);
  runtime = new TestRuntime("orphan-maintenance");
  source = path.join(runtime.root, "source.png");
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({
      id: 1,
      path: runtime.root,
      displayName: "isolated",
      photoCount: 1,
    })
    .run();
  db.insert(photos)
    .values({ id: 1, folderId: 1, path: source, filename: "source.png" })
    .run();
});
afterEach(() => {
  sqlite.close();
  runtime.cleanup();
  vi.restoreAllMocks();
});

describe("asynchronous orphan maintenance", () => {
  it("removes only confirmed missing records and updates the folder count", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(absent());
    expect(await cleanupOrphanedRecordsAsync()).toEqual({
      checked: 1,
      removed: 1,
    });
    expect(db.select({ id: photos.id }).from(photos).all()).toEqual([]);
    expect(
      db.select({ count: folders.photoCount }).from(folders).get()?.count
    ).toBe(0);
    expect(state.thumbnails).toHaveBeenCalledWith(source);
    expect(state.vectors).toHaveBeenCalledWith([1]);
  });

  it("preserves a photo renamed while its old path is being checked", async () => {
    const renamed = path.join(runtime.root, "renamed.png");
    vi.spyOn(fs.promises, "access").mockImplementation(() => {
      db.update(photos).set({ path: renamed }).where(eq(photos.id, 1)).run();
      return Promise.reject(absent());
    });
    expect(await cleanupOrphanedRecordsAsync()).toEqual({
      checked: 1,
      removed: 0,
    });
    expect(db.select({ path: photos.path }).from(photos).get()?.path).toBe(
      renamed
    );
    expect(state.thumbnails).not.toHaveBeenCalled();
    expect(state.vectors).not.toHaveBeenCalled();
  });

  it("keeps records when the source cannot be accessed", async () => {
    vi.spyOn(fs.promises, "access").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );
    expect(await cleanupOrphanedRecordsAsync()).toEqual({
      checked: 1,
      removed: 0,
    });
    expect(db.select({ id: photos.id }).from(photos).get()?.id).toBe(1);
    expect(state.thumbnails).not.toHaveBeenCalled();
  });

  it("stops without deleting a record after cancellation during a probe", async () => {
    let release: (() => void) | undefined;
    vi.spyOn(fs.promises, "access").mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const controller = new AbortController();
    const task = cleanupOrphanedRecordsAsync(undefined, controller.signal);
    controller.abort();
    release?.();
    expect(await task).toEqual({ checked: 0, removed: 0 });
    expect(db.select({ id: photos.id }).from(photos).get()?.id).toBe(1);
    expect(state.thumbnails).not.toHaveBeenCalled();
  });
});
