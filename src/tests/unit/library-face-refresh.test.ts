/** @vitest-environment node */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import { notifyLibraryChange } from "@/services/library-change";
import { refreshChangedPhotoFaces } from "@/services/library-face-refresh";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  stopped: false,
  scope: [1],
  detecting: false,
  detect: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/settings-manager", () => ({
  getSetting: () => (state.stopped ? "true" : null),
}));
vi.mock("@/services/face-scan-scope", () => ({
  resolveFaceScanFolderIds: () => state.scope,
}));
vi.mock("@/services/face-detector", () => ({
  detectFaces: state.detect,
  cancelFaceDetection: state.cancel,
  isFaceDetectionRunning: () => state.detecting,
}));
vi.mock("@/services/library-change", () => ({ notifyLibraryChange: vi.fn() }));
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  vi.clearAllMocks();
  state.stopped = false;
  state.detecting = false;
  state.scope = [1];
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values([
      { id: 1, path: "fixture", displayName: "fixture" },
      { id: 2, path: "other", displayName: "other" },
    ])
    .run();
  db.insert(photos)
    .values([
      {
        id: 1,
        path: "one.jpg",
        filename: "one.jpg",
        folderId: 1,
        faceRefreshPending: true,
        sourceStatus: "available",
      },
      {
        id: 2,
        path: "two.jpg",
        filename: "two.jpg",
        folderId: 2,
        faceRefreshPending: true,
        sourceStatus: "available",
      },
      {
        id: 3,
        path: "three.jpg",
        filename: "three.jpg",
        folderId: 1,
        sourceStatus: "available",
      },
      {
        id: 4,
        path: "four.jpg",
        filename: "four.jpg",
        folderId: 1,
        faceRefreshPending: true,
        sourceStatus: "offline",
      },
    ])
    .run();
  state.detect.mockResolvedValue(0);
});
afterEach(() => {
  sqlite.close();
  vi.restoreAllMocks();
});

it("only queues previously processed changed photos inside the user's scope", async () => {
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.detect).toHaveBeenCalledExactlyOnceWith([1]);
});
it("retains markers and obeys manual stopping and missing scope", async () => {
  state.stopped = true;
  await refreshChangedPhotoFaces(new AbortController().signal);
  state.stopped = false;
  state.scope = [];
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.detect).not.toHaveBeenCalled();
  expect(
    db.select().from(photos).where(eq(photos.id, 1)).get()?.faceRefreshPending
  ).toBe(true);
});
it("cancels only its own active detection when the scheduler pauses", async () => {
  const controller = new AbortController();
  state.detect.mockImplementationOnce(() => {
    controller.abort();
    return Promise.resolve(0);
  });
  await refreshChangedPhotoFaces(controller.signal);
  expect(state.cancel).toHaveBeenCalledOnce();
  expect(db.select().from(photos).where(eq(photos.id, 1)).get()).toMatchObject({
    faceRefreshAttempts: 0,
    faceRefreshRetryAt: 0,
    faceProcessingError: null,
  });
  state.cancel.mockClear();
  state.detecting = true;
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.cancel).not.toHaveBeenCalled();
});
it("retains retry markers and records a failed detector without rejecting indexing", async () => {
  state.detect.mockRejectedValueOnce(new Error("detector unavailable"));
  await expect(
    refreshChangedPhotoFaces(new AbortController().signal)
  ).resolves.toBeGreaterThan(Date.now());
  expect(db.select().from(photos).where(eq(photos.id, 1)).get()).toMatchObject({
    faceRefreshPending: true,
    faceProcessingError: "detector unavailable",
    faceRefreshAttempts: 1,
  });
});
it("persists exponential deadlines and stops after four unsuccessful attempts including nonthrowing failures", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let attempt = 1; attempt <= 4; attempt++) {
    const deadline = await refreshChangedPhotoFaces(
      new AbortController().signal
    );
    const row = db.select().from(photos).where(eq(photos.id, 1)).get();
    expect(row).toMatchObject({
      faceRefreshAttempts: attempt,
      faceRefreshRetryAt: now + 1000 * 2 ** attempt,
      faceProcessingError: "FACE_REFRESH_FAILED",
      faceRefreshPending: true,
    });
    expect(deadline).toBe(attempt === 4 ? undefined : row?.faceRefreshRetryAt);
    await refreshChangedPhotoFaces(new AbortController().signal);
    expect(state.detect).toHaveBeenCalledTimes(attempt);
    now += 1000 * 2 ** attempt;
  }
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.detect).toHaveBeenCalledTimes(4);
});
it("retries only failed rows and never refreshes a successful photo again", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  db.insert(photos)
    .values({
      id: 5,
      path: "five.jpg",
      filename: "five.jpg",
      folderId: 1,
      faceRefreshPending: true,
      sourceStatus: "available",
    })
    .run();
  state.detect.mockImplementationOnce(() => {
    db.update(photos)
      .set({
        faceRefreshPending: false,
        isFaceProcessed: true,
        faceRefreshAttempts: 0,
        faceRefreshRetryAt: 0,
      })
      .where(eq(photos.id, 1))
      .run();
    return Promise.resolve(0);
  });
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.detect).toHaveBeenLastCalledWith([1, 5]);
  expect(notifyLibraryChange).toHaveBeenCalledExactlyOnceWith(null, "status");
  now += 2000;
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(state.detect).toHaveBeenLastCalledWith([5]);
});
it("starts exponential backoff after a long failed inference finishes", async () => {
  let now = 100_000;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  state.detect.mockImplementationOnce(() => {
    now += 30_000;
    return Promise.resolve(0);
  });
  expect(await refreshChangedPhotoFaces(new AbortController().signal)).toBe(
    132_000
  );
  expect(
    db.select().from(photos).where(eq(photos.id, 1)).get()?.faceRefreshRetryAt
  ).toBe(132_000);
});
it("does not count an obsolete attempt against a newer content version", async () => {
  state.detect.mockImplementationOnce(() => {
    db.update(photos)
      .set({
        contentRevision: 1,
        faceRefreshAttempts: 0,
        faceRefreshRetryAt: 0,
      })
      .where(eq(photos.id, 1))
      .run();
    return Promise.resolve(0);
  });
  await refreshChangedPhotoFaces(new AbortController().signal);
  expect(db.select().from(photos).where(eq(photos.id, 1)).get()).toMatchObject({
    contentRevision: 1,
    faceRefreshAttempts: 0,
    faceProcessingError: null,
  });
});
it("recovers an exhausted attempt interrupted before its failure was recorded", async () => {
  db.update(photos)
    .set({ faceRefreshAttempts: 4, faceProcessingError: null })
    .where(eq(photos.id, 1))
    .run();
  expect(
    await refreshChangedPhotoFaces(new AbortController().signal)
  ).toBeUndefined();
  expect(state.detect).not.toHaveBeenCalled();
  expect(db.select().from(photos).where(eq(photos.id, 1)).get()).toMatchObject({
    faceRefreshAttempts: 4,
    faceRefreshPending: true,
    faceProcessingError: "FACE_REFRESH_INTERRUPTED",
  });
  expect(notifyLibraryChange).toHaveBeenCalledExactlyOnceWith(null, "status");
});
