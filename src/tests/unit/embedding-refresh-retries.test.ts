/** @vitest-environment node */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import {
  embeddingRefreshFailed,
  embeddingRetryStateColumns,
  planEmbeddingRetries,
  recordEmbeddingFailures,
  resetEmbeddingRefreshRetry,
} from "@/services/ai/embedding-refresh-retries";
import { libraryStatusColumns } from "@/services/library-status-query";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(photos)
    .values([
      { id: 1, path: "one.jpg", filename: "one.jpg" },
      { id: 2, path: "two.jpg", filename: "two.jpg" },
    ])
    .run();
});

afterEach(() => {
  sqlite.close();
});

function failureSnapshot() {
  return db
    .select(embeddingRetryStateColumns)
    .from(photos)
    .where(eq(photos.id, 1))
    .all();
}

function reportFailure(now: number) {
  return recordEmbeddingFailures(db, failureSnapshot(), now);
}

it("backs off real failures and preserves the exhausted result for a new scheduler", () => {
  expect(reportFailure(100)).toEqual({ newlyExhausted: 0, retryAt: 2100 });
  expect(planEmbeddingRetries(db, 2099)).toMatchObject({
    excludePhotoIds: new Set([1]),
    hasWork: true,
    retryAt: 2100,
  });
  expect(reportFailure(2100)).toEqual({ newlyExhausted: 0, retryAt: 6100 });
  expect(reportFailure(6100)).toEqual({ newlyExhausted: 0, retryAt: 14_100 });
  expect(reportFailure(14_100)).toEqual({
    newlyExhausted: 1,
    retryAt: undefined,
  });

  const reopened = drizzle(sqlite);
  expect(planEmbeddingRetries(reopened, 100_000)).toMatchObject({
    excludePhotoIds: new Set([1]),
    failedPhotoCount: 1,
    hasWork: true,
    retryAt: undefined,
  });
  expect(
    reopened
      .select({ id: photos.id })
      .from(photos)
      .where(embeddingRefreshFailed)
      .all()
  ).toEqual([{ id: 1 }]);
});

it("makes only the explicitly reset photo eligible again", () => {
  db.update(photos)
    .set({ embeddingRefreshAttempts: 4, embeddingRefreshFileRevision: 0 })
    .run();
  db.update(photos)
    .set(resetEmbeddingRefreshRetry)
    .where(eq(photos.id, 1))
    .run();
  expect(planEmbeddingRetries(db, 100)).toMatchObject({
    excludePhotoIds: new Set([2]),
    failedPhotoCount: 1,
    hasWork: true,
  });
});

it("ignores a stale failure after the source moves or changes", () => {
  reportFailure(100);
  const failedRows = failureSnapshot();
  db.update(photos).set({ fileRevision: 1 }).where(eq(photos.id, 1)).run();
  expect(recordEmbeddingFailures(db, failedRows, 2100)).toEqual({
    newlyExhausted: 0,
    retryAt: undefined,
  });
  expect(planEmbeddingRetries(db, 101)).toMatchObject({
    excludePhotoIds: new Set(),
    hasWork: true,
  });
});

it("rejects writes after reset, concurrent completion, source loss or database switch", () => {
  reportFailure(100);
  const failedRows = failureSnapshot();
  db.update(photos)
    .set(resetEmbeddingRefreshRetry)
    .where(eq(photos.id, 1))
    .run();
  const fresh = failureSnapshot();
  expect(recordEmbeddingFailures(db, failedRows, 2100).retryAt).toBeUndefined();
  db.update(photos).set({ isAiProcessed: true }).where(eq(photos.id, 1)).run();
  expect(recordEmbeddingFailures(db, fresh, 2100).retryAt).toBeUndefined();
  db.update(photos)
    .set({ isAiProcessed: false, sourceStatus: "offline" })
    .where(eq(photos.id, 1))
    .run();
  expect(recordEmbeddingFailures(db, fresh, 2100).retryAt).toBeUndefined();
  db.update(photos)
    .set({ sourceStatus: "available" })
    .where(eq(photos.id, 1))
    .run();
  state.db = drizzle(sqlite);
  expect(recordEmbeddingFailures(db, fresh, 2100).retryAt).toBeUndefined();
});

it("keeps offline failures visible without starting new work for them", () => {
  db.update(photos)
    .set({
      embeddingRefreshAttempts: 4,
      embeddingRefreshFileRevision: 0,
      sourceStatus: "offline",
    })
    .where(eq(photos.id, 1))
    .run();
  expect(planEmbeddingRetries(db, 100)).toMatchObject({
    failedPhotoCount: 0,
    hasWork: true,
    retryAt: undefined,
  });
  expect(
    db
      .select({ id: photos.id })
      .from(photos)
      .where(embeddingRefreshFailed)
      .all()
  ).toEqual([{ id: 1 }]);
});

it("invalidates catalogue queries only when exhausted status changes", () => {
  const revisions = () =>
    sqlite
      .prepare(
        "SELECT (SELECT revision FROM gallery_data_revision WHERE id = 4) AS gallery, (SELECT revision FROM search_data_revision WHERE id = 1) AS search"
      )
      .get() as { gallery: number; search: number };
  const status = () =>
    db.select(libraryStatusColumns).from(photos).where(eq(photos.id, 1)).get();
  const before = revisions();
  reportFailure(100);
  reportFailure(2100);
  reportFailure(6100);
  expect(revisions()).toEqual(before);
  reportFailure(14_100);
  expect(revisions()).toEqual({
    gallery: before.gallery + 1,
    search: before.search + 1,
  });
  expect(status()).toMatchObject({
    refreshStatus: "failed",
    refreshError: "EMBEDDING_REFRESH_FAILED",
  });
  db.update(photos).set({ fileRevision: 1 }).where(eq(photos.id, 1)).run();
  expect(revisions()).toEqual({
    gallery: before.gallery + 2,
    search: before.search + 2,
  });
  expect(status()).toMatchObject({
    refreshStatus: "ready",
    refreshError: null,
  });
});
