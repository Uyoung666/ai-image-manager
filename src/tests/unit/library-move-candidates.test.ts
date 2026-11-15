/** @vitest-environment node */
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import { libraryMoveCandidates, photos } from "@/db/schema";
import {
  forgetLibraryMoveTarget,
  getLibraryMoveCandidates,
  rememberLibraryMoveCandidates,
} from "@/services/library-move-candidates";
import { importPathKey } from "@/utils/import-path";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
const original = path.resolve(".test-runtime/candidate-original.jpg");
const target = path.resolve(".test-runtime/candidate-target.jpg");
beforeEach(() => {
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(photos)
    .values({
      id: 1,
      path: original,
      filename: "original.jpg",
      sourceStatus: "missing",
      fileRevision: 2,
      sourceMissingAt: 100,
    })
    .run();
  rememberLibraryMoveCandidates(
    db,
    { id: 1, path: original, fileRevision: 2 },
    [{ targetPath: target, reason: "ambiguous" }],
    101
  );
});
afterEach(() => sqlite.close());

it("keeps only current missing-period candidates visible", () => {
  expect(getLibraryMoveCandidates(db, 1)).toEqual([
    { targetPath: target, reason: "ambiguous" },
  ]);
  db.update(photos).set({ sourceMissingAt: 200 }).where(eq(photos.id, 1)).run();
  expect(getLibraryMoveCandidates(db, 1)).toEqual([]);
  expect(forgetLibraryMoveTarget(db, target)).toBe(false);
});

it("does not publish obsolete records when an old target is removed after relinking", () => {
  db.update(photos)
    .set({ path: target, sourceStatus: "available", fileRevision: 3 })
    .where(eq(photos.id, 1))
    .run();
  // Model residual data from an interrupted earlier version.
  db.insert(libraryMoveCandidates)
    .values({
      photoId: 1,
      fileRevision: 2,
      sourceMissingAt: 100,
      targetPath: target,
      targetPathKey: importPathKey(target),
      reason: "ambiguous",
    })
    .onConflictDoNothing()
    .run();
  expect(getLibraryMoveCandidates(db, 1)).toEqual([]);
  expect(forgetLibraryMoveTarget(db, target)).toBe(false);
  expect(db.select().from(libraryMoveCandidates).all()).toEqual([]);
});

it("removes current target candidates and reports the visible change", () => {
  expect(forgetLibraryMoveTarget(db, target)).toBe(true);
  expect(getLibraryMoveCandidates(db, 1)).toEqual([]);
});

it("suppresses candidates when another catalogue record already owns the target", () => {
  db.insert(photos)
    .values({ id: 2, path: target, filename: "target.jpg" })
    .run();
  expect(getLibraryMoveCandidates(db, 1)).toEqual([]);
  expect(forgetLibraryMoveTarget(db, target)).toBe(false);
});

it.each([
  { sourceStatus: "available" as const },
  { fileRevision: 3 },
  { sourceMissingAt: 200 },
  { deletedAt: 500 },
])("cleans persisted candidate edges when their recorded source identity becomes stale (%j)", (change) => {
  expect(db.select().from(libraryMoveCandidates).all()).toHaveLength(1);
  db.update(photos).set(change).where(eq(photos.id, 1)).run();
  expect(db.select().from(libraryMoveCandidates).all()).toEqual([]);
});

it("keeps current candidates through status checks within the same missing period", () => {
  db.update(photos)
    .set({
      sourceCheckedAt: 500,
      sourceStatus: "missing",
      sourceMissingAt: 100,
    })
    .where(eq(photos.id, 1))
    .run();
  expect(getLibraryMoveCandidates(db, 1)).toHaveLength(1);
});
