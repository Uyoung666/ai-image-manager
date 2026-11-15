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
  dismissLibraryTask,
  getActiveLibraryTask,
  getLibraryAttention,
  getLibraryHealth,
  getLibraryIssues,
  getLibraryPhotos,
  getLibraryTask,
  inspectMissingRecordRemoval,
  reconcileLibrary,
  removeMissingRecords,
  retryLibrarySourceUpdates,
} from "@/services/library-maintenance";
import { libraryStatusColumns } from "@/services/library-status-query";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  notify: vi.fn(),
  observe: vi.fn(),
  retry: vi.fn(),
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
  retryLibraryPhotoRefresh: state.retry,
}));

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;
let missing: string;
let available: string;

beforeEach(async () => {
  vi.clearAllMocks();
  state.observe.mockReset();
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

it("summarizes descendants once per root and supports direct photo and literal path lookup", () => {
  const child = path.join(source, "child");
  db.insert(folders)
    .values({ id: 3, path: child, displayName: "child", parentId: 1 })
    .run();
  db.update(photos)
    .set({ folderId: 3, path: path.join(child, "available.jpg") })
    .where(eq(photos.id, 2))
    .run();
  const health = getLibraryHealth();
  expect(health.folders.find((folder) => folder.id === 1)).toMatchObject({
    total: 2,
    unavailable: 1,
    rootId: 1,
  });
  expect(health.folders.find((folder) => folder.id === 3)).toMatchObject({
    total: 1,
    parentId: 1,
    rootId: 1,
  });
  expect(getLibraryAttention()).toEqual({ attentionCount: 1, offlineCount: 0 });
  expect(
    getLibraryPhotos({ status: "available" }).items.map((photo) => photo.id)
  ).toEqual([2]);
  expect(
    getLibraryPhotos({ photoId: 2 }).items.map((photo) => photo.id)
  ).toEqual([2]);
  expect(
    getLibraryPhotos({ status: "all", query: "AVAILABLE.JPG" }).total
  ).toBe(1);
  expect(getLibraryPhotos({ status: "all", query: "%" }).total).toBe(0);
});

it("discovers active checks after navigation and keeps cancellation exclusive until settled", async () => {
  const task = reconcileLibrary({ photoIds: [2] });
  expect(getActiveLibraryTask()).toMatchObject({
    taskId: task.taskId,
    kind: "check",
    cancellable: true,
    scope: { photoIds: [2] },
  });
  cancelLibraryTask(task.taskId);
  expect(() => reconcileLibrary({})).toThrow("LIBRARY_TASK_BUSY");
  await tick();
  expect(getActiveLibraryTask()).toMatchObject({ status: "cancelled" });
  dismissLibraryTask(task.taskId);
  expect(getActiveLibraryTask()).toBeNull();
  expect(getLibraryTask(task.taskId, 0)).toMatchObject({
    status: "cancelled",
    errorCount: 0,
  });
});

it("continues after per-photo failures and pages all 101 error records", async () => {
  const added = Array.from({ length: 101 }, (_, index) => {
    const id = index + 3;
    return {
      id,
      folderId: 1,
      path: path.join(source, `photo-${id}.jpg`),
      filename: `photo-${id}.jpg`,
      sourceStatus: "available" as const,
    };
  });
  await Promise.all(
    added.map((photo) => fs.writeFile(photo.path, "photo bytes"))
  );
  db.insert(photos).values(added).run();
  state.observe.mockImplementation((id: number) => {
    if (id < 103) {
      throw Object.assign(new Error("Access denied"), { code: "EACCES" });
    }
  });
  const task = reconcileLibrary({ folderId: 1 });
  await vi.waitFor(() =>
    expect(getLibraryTask(task.taskId, 0).status).toBe("done")
  );
  const first = getLibraryTask(task.taskId, 0);
  const last = getLibraryTask(task.taskId, 100);
  expect(first).toMatchObject({
    processed: 103,
    total: 103,
    errorCount: 101,
    storedErrorCount: 101,
    hasMoreErrors: true,
  });
  expect(first.errorDetails).toHaveLength(100);
  expect(first.errorDetails[0]).toMatchObject({
    code: "EACCES",
    photoId: 2,
    path: available,
  });
  expect(last).toMatchObject({
    errorOffset: 100,
    errorCount: 101,
    hasMoreErrors: false,
  });
  expect(last.errorDetails).toHaveLength(1);
  expect(state.observe).toHaveBeenCalledWith(
    103,
    path.join(source, "photo-103.jpg")
  );
});

it("separates routine offline records from attention while keeping them recoverable", () => {
  db.update(photos)
    .set({ sourceStatus: "offline", refreshStatus: "ready" })
    .where(eq(photos.id, 1))
    .run();
  expect(getLibraryAttention()).toEqual({ attentionCount: 0, offlineCount: 1 });
  expect(getLibraryHealth()).toMatchObject({
    attentionCount: 0,
    offlineCount: 1,
  });
  expect(
    getLibraryPhotos({ status: "attention" }).items.map((item) => item.id)
  ).toContain(1);
});
it("retains completed results until dismissed and never resurrects older results", async () => {
  const first = reconcileLibrary({ photoIds: [2] });
  await tick();
  await expect
    .poll(() => getActiveLibraryTask())
    .toMatchObject({ taskId: first.taskId, status: "done" });
  const second = reconcileLibrary({ photoIds: [2] });
  await tick();
  await expect.poll(() => getLibraryTask(second.taskId, 0).status).toBe("done");
  dismissLibraryTask(second.taskId);
  expect(getActiveLibraryTask()).toBeNull();
});

it("retries failed updates within a source and excludes offline originals", async () => {
  db.update(photos).set({ refreshStatus: "failed" }).run();
  state.retry.mockResolvedValue(true);
  const task = retryLibrarySourceUpdates(1);
  await expect.poll(() => getLibraryTask(task.taskId, 0).status).toBe("done");
  expect(state.retry).toHaveBeenCalledExactlyOnceWith(2);
  expect(getLibraryTask(task.taskId, 0)).toMatchObject({
    total: 1,
    processed: 1,
    errorCount: 0,
  });
});

it("keeps legacy photos outside imported sources recoverable without duplicating in-folder rows", () => {
  db.update(photos)
    .set({ folderId: null, sourceStatus: "missing" })
    .where(eq(photos.id, 1))
    .run();
  db.insert(photos)
    .values({
      id: 3,
      path: path.join(path.dirname(source), "loose.jpg"),
      filename: "loose.jpg",
      sourceStatus: "missing",
    })
    .run();
  expect(getLibraryHealth().unassignedCount).toBe(1);
  expect(
    getLibraryPhotos({ unassigned: true }).items.map((item) => item.id)
  ).toEqual([3]);
});
