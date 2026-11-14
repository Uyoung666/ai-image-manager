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
  deleteColorVectors: vi.fn(),
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
  fs.writeFileSync(source, "library source fixture");
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
  it("keeps all records when the registered root is offline", async () => {
    vi.spyOn(fs.promises, "opendir").mockRejectedValue(absent());
    const access = vi.spyOn(fs.promises, "access");
    expect(await cleanupOrphanedRecordsAsync()).toEqual({
      checked: 1,
      removed: 0,
    });
    expect(db.select({ id: photos.id }).from(photos).get()?.id).toBe(1);
    expect(
      db.select({ status: photos.sourceStatus }).from(photos).get()?.status
    ).toBe("offline");
    expect(access).not.toHaveBeenCalled();
    expect(state.vectors).not.toHaveBeenCalled();
  });
  it("marks a confirmed missing file and preserves its catalogue relationships", async () => {
    sqlite.exec(`
      UPDATE photos SET is_favorite = 1 WHERE id = 1;
      INSERT INTO tags(id, name, created_at) VALUES (1, 'kept', 0);
      INSERT INTO photo_tags(photo_id, tag_id) VALUES (1, 1);
      INSERT INTO albums(id, name, created_at) VALUES (1, 'kept', 0);
      INSERT INTO album_photos(photo_id, album_id) VALUES (1, 1);
      INSERT INTO face_vectors(photo_id, bbox_x, bbox_y, bbox_width, bbox_height, created_at) VALUES (1, 0, 0, 1, 1, 0);
      INSERT INTO face_identities(id, name, representative_photo_id, is_confirmed, created_at) VALUES (1, 'kept', 1, 1, 0);
      INSERT INTO face_identity_members(identity_id, face_vector_id) VALUES (1, 1);
      INSERT INTO cull_sessions(id, name, created_at) VALUES (1, 'kept', 0);
      INSERT INTO cull_session_photos(session_id, photo_id) VALUES (1, 1);
    `);
    fs.unlinkSync(source);
    expect(await cleanupOrphanedRecordsAsync()).toEqual({
      checked: 1,
      removed: 0,
    });
    expect(db.select().from(photos).get()).toMatchObject({
      id: 1,
      sourceStatus: "missing",
      deletedAt: null,
      isFavorite: true,
    });
    expect(
      db.select({ count: folders.photoCount }).from(folders).get()?.count
    ).toBe(1);
    expect(
      sqlite
        .prepare(`SELECT
      (SELECT photo_id FROM photo_tags) AS tag,
      (SELECT photo_id FROM album_photos) AS album,
      (SELECT photo_id FROM face_vectors JOIN face_identity_members ON face_vectors.id = face_vector_id) AS face,
      (SELECT photo_id FROM cull_session_photos) AS cull
    `)
        .get()
    ).toEqual({ tag: 1, album: 1, face: 1, cull: 1 });
    expect(state.thumbnails).not.toHaveBeenCalled();
    expect(state.vectors).not.toHaveBeenCalled();
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
    expect(
      db.select({ status: photos.sourceStatus }).from(photos).get()?.status
    ).toBe("inaccessible");
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
