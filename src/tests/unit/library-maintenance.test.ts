/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import Database from "better-sqlite3";
import { eq, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  cancelLibraryMaintenance,
  cancelLibraryTask,
  getLibraryHealth,
  getLibraryIssues,
  getLibraryTask,
  inspectMissingRecordRemoval,
  reconcileLibrary,
  removeMissingRecords,
} from "@/services/library-maintenance";
import { libraryStatusColumns } from "@/services/library-status-query";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  notify: vi.fn(),
  observe: vi.fn(),
}));

it("surfaces exhausted face refresh in health, filters and detail summaries", () => {
  db.update(photos)
    .set({ faceRefreshPending: true, faceRefreshAttempts: 3 })
    .where(eq(photos.id, 2))
    .run();
  expect(getLibraryHealth().pending).toBe(1);
  db.update(photos)
    .set({ faceRefreshAttempts: 4, faceProcessingError: null })
    .where(eq(photos.id, 2))
    .run();
  expect(getLibraryHealth().failed).toBe(0);
  const previousRevision = sqlite
    .prepare("SELECT revision FROM gallery_data_revision WHERE id = 4")
    .pluck()
    .get();
  db.update(photos)
    .set({ faceProcessingError: "Source decoder failed" })
    .where(eq(photos.id, 2))
    .run();
  expect(getLibraryHealth()).toMatchObject({ pending: 0, failed: 1 });
  expect(
    db.select(libraryStatusColumns).from(photos).where(eq(photos.id, 2)).get()
  ).toMatchObject({
    refreshStatus: "failed",
    refreshError: "Source decoder failed",
  });
  expect(
    sqlite
      .prepare("SELECT revision FROM gallery_data_revision WHERE id = 4")
      .pluck()
      .get()
  ).toBeGreaterThan(Number(previousRevision));
});
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/library-change", () => ({
  notifyLibraryChange: state.notify,
}));
vi.mock("@/services/library-content-refresh", () => ({
  observeLibraryPhoto: state.observe,
}));

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;
let missing: string;
let available: string;

beforeEach(async () => {
  vi.clearAllMocks();
  runtime = new TestRuntime("library-maintenance");
  source = path.join(runtime.root, "source");
  await fs.mkdir(source);
  missing = path.join(source, "missing.jpg");
  available = path.join(source, "available.jpg");
  await fs.writeFile(available, "untouched original bytes");
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: source, displayName: "source", photoCount: 2 })
    .run();
  db.insert(photos)
    .values([
      {
        id: 1,
        folderId: 1,
        path: missing,
        filename: "missing.jpg",
        sourceStatus: "missing",
        isFavorite: true,
      },
      {
        id: 2,
        folderId: 1,
        path: available,
        filename: "available.jpg",
        sourceStatus: "available",
      },
    ])
    .run();
  sqlite.exec(`
    INSERT INTO tags(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO photo_tags(photo_id, tag_id) VALUES (1, 1);
    INSERT INTO albums(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO album_photos(photo_id, album_id) VALUES (1, 1);
    INSERT INTO face_vectors(photo_id, bbox_x, bbox_y, bbox_width, bbox_height, created_at) VALUES (1, 0, 0, 1, 1, 0);
    INSERT INTO cull_sessions(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO cull_session_photos(session_id, photo_id) VALUES (1, 1);
  `);
});

afterEach(async () => {
  cancelLibraryMaintenance();
  await tick();
  vi.restoreAllMocks();
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("previews relationship loss and removes only confirmed missing catalogue records", async () => {
  const preview = await inspectMissingRecordRemoval([1, 2]);
  expect(preview).toMatchObject({
    photoIds: [1],
    links: { tags: 1, albums: 1, faces: 1, cull: 1 },
  });
  const remove = vi.fn((ids: number[]) =>
    db.delete(photos).where(inArray(photos.id, ids)).run()
  );
  expect(await removeMissingRecords(preview.token, remove)).toEqual({
    removed: 1,
  });
  expect(remove).toHaveBeenCalledExactlyOnceWith([1]);
  expect(db.select({ id: photos.id }).from(photos).all()).toEqual([{ id: 2 }]);
  expect(await fs.readFile(available, "utf8")).toBe("untouched original bytes");
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  expect(sqlite.prepare("SELECT count(*) n FROM photo_tags").get()).toEqual({
    n: 0,
  });
});

it("rejects removal when the file returns after the preview", async () => {
  const preview = await inspectMissingRecordRemoval([1]);
  await fs.writeFile(missing, "returned source bytes");
  const remove = vi.fn();
  await expect(removeMissingRecords(preview.token, remove)).rejects.toThrow(
    "LIBRARY_REMOVAL_STALE"
  );
  expect(remove).not.toHaveBeenCalled();
  expect(db.select({ id: photos.id }).from(photos).all()).toHaveLength(2);
  expect(await fs.readFile(missing, "utf8")).toBe("returned source bytes");
});

it("expires previews and rejects changed catalogue versions", async () => {
  const preview = await inspectMissingRecordRemoval([1]);
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now + 600_001);
  await expect(removeMissingRecords(preview.token, vi.fn())).rejects.toThrow(
    "LIBRARY_REMOVAL_EXPIRED"
  );
  vi.restoreAllMocks();
  const latest = await inspectMissingRecordRemoval([1]);
  db.update(photos).set({ fileRevision: 1 }).where(eq(photos.id, 1)).run();
  await expect(removeMissingRecords(latest.token, vi.fn())).rejects.toThrow(
    "LIBRARY_REMOVAL_STALE"
  );
});

it("preserves missing records when the source root is offline", async () => {
  const preview = await inspectMissingRecordRemoval([1]);
  await fs.rename(source, path.join(runtime.root, "detached"));
  const remove = vi.fn();
  await expect(removeMissingRecords(preview.token, remove)).rejects.toThrow(
    "LIBRARY_REMOVAL_STALE"
  );
  expect(remove).not.toHaveBeenCalled();
  expect(db.select().from(photos).get()).toMatchObject({
    id: 1,
    isFavorite: true,
  });
  expect(sqlite.prepare("SELECT count(*) n FROM photo_tags").get()).toEqual({
    n: 1,
  });
});

it("cancels a queued check before filesystem work and retains its task result", async () => {
  const access = vi.spyOn(fs, "access");
  const task = reconcileLibrary({ folderId: 1 });
  expect(cancelLibraryTask(task.taskId).status).toBe("cancelled");
  await tick();
  expect(getLibraryTask(task.taskId, 0)).toMatchObject({
    status: "cancelled",
    processed: 0,
  });
  expect(access).not.toHaveBeenCalled();
  expect(state.observe).not.toHaveBeenCalled();
});

it("checks sources with progress and reports catalogue health without probing files", async () => {
  db.update(photos).set({ sourceStatus: "unverified" }).run();
  const task = reconcileLibrary({ folderId: 1 });
  await vi.waitFor(() =>
    expect(getLibraryTask(task.taskId, 0).status).toBe("done")
  );
  expect(getLibraryTask(task.taskId, 0)).toMatchObject({
    total: 2,
    processed: 2,
    errors: [],
  });
  expect(state.observe).toHaveBeenCalledWith(2, available);
  const access = vi.spyOn(fs, "access");
  expect(getLibraryHealth(1)).toMatchObject({
    total: 2,
    unavailable: 1,
    counts: { missing: 1, available: 1 },
  });
  expect(access).not.toHaveBeenCalled();
});

it("counts each affected photo once and excludes ordinary pending or unverified states", () => {
  db.update(photos)
    .set({ sourceStatus: "missing", refreshStatus: "failed" })
    .where(eq(photos.id, 1))
    .run();
  db.update(photos)
    .set({ sourceStatus: "unverified", refreshStatus: "pending" })
    .where(eq(photos.id, 2))
    .run();
  expect(getLibraryHealth(1)).toMatchObject({
    attentionCount: 1,
    unavailable: 1,
    failed: 1,
  });
  db.update(photos)
    .set({ sourceStatus: "available", refreshStatus: "ready" })
    .where(eq(photos.id, 1))
    .run();
  expect(getLibraryHealth(1).attentionCount).toBe(0);
});

it("pages only real issues and keeps scopes, soft deletion and double faults correct", () => {
  db.update(photos)
    .set({ sourceStatus: "missing", refreshStatus: "failed" })
    .where(eq(photos.id, 1))
    .run();
  db.update(photos)
    .set({ sourceStatus: "unverified", refreshStatus: "pending" })
    .where(eq(photos.id, 2))
    .run();
  for (let id = 3; id <= 25; id++) {
    db.insert(photos)
      .values({
        id,
        path: path.join(source, `issue-${id}.jpg`),
        filename: `issue-${id}.jpg`,
        folderId: 1,
        sourceStatus: "missing",
      })
      .run();
  }
  db.update(photos)
    .set({ deletedAt: Date.now() })
    .where(eq(photos.id, 25))
    .run();
  const first = getLibraryIssues({ folderId: 1 });
  expect(first.total).toBe(23);
  expect(first.items).toHaveLength(20);
  expect(first.items.map((row) => row.id)).not.toContain(2);
  expect(getLibraryIssues({ folderId: 1, offset: 20 }).items).toHaveLength(3);
  expect(
    getLibraryIssues({ folderId: 1, status: "failed" }).items.map(
      (row) => row.id
    )
  ).toEqual([1]);
  expect(getLibraryIssues({ status: "offline" }).total).toBe(0);
});
