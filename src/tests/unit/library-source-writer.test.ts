/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { writeLibraryPhotoSource } from "@/services/library-source";

vi.mock("@/db", () => ({ getDatabase: vi.fn() }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
const photo = { id: 1, path: "original.jpg", fileRevision: 2 };

function createDatabase() {
  const connection = new Database(":memory:");
  connection.exec(`
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY, path TEXT, file_revision INTEGER, deleted_at INTEGER,
      source_status TEXT, source_checked_at INTEGER, source_error_code TEXT,
      source_available_at INTEGER, source_missing_at INTEGER
    );
    INSERT INTO photos VALUES (1, 'original.jpg', 2, NULL, 'available', 10, NULL, 10, NULL);
  `);
  return connection;
}

const row = () => sqlite.prepare("SELECT * FROM photos WHERE id = 1").get();

beforeEach(() => {
  sqlite = createDatabase();
  db = drizzle(sqlite);
});
afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

it("preserves missing and last-success timestamps across prepared source updates", () => {
  expect(writeLibraryPhotoSource(db, photo, { status: "missing" }, 20)).toBe(
    true
  );
  expect(writeLibraryPhotoSource(db, photo, { status: "missing" }, 30)).toBe(
    false
  );
  expect(row()).toMatchObject({
    source_status: "missing",
    source_checked_at: 30,
    source_available_at: 10,
    source_missing_at: 20,
  });
  expect(
    writeLibraryPhotoSource(
      db,
      photo,
      { status: "inaccessible", errorCode: "EACCES" },
      40
    )
  ).toBe(true);
  expect(row()).toMatchObject({
    source_error_code: "EACCES",
    source_available_at: 10,
    source_missing_at: 20,
  });
  expect(writeLibraryPhotoSource(db, photo, { status: "available" }, 50)).toBe(
    true
  );
  expect(row()).toMatchObject({
    source_status: "available",
    source_checked_at: 50,
    source_available_at: 50,
    source_missing_at: null,
    source_error_code: null,
  });
});

it("rejects stale observations, changed identities and soft-deleted records", () => {
  const original = row();
  for (const observation of [
    { photo, checkedAt: 9 },
    { photo: { ...photo, path: "moved.jpg" }, checkedAt: 20 },
    { photo: { ...photo, fileRevision: 1 }, checkedAt: 20 },
    { photo: { ...photo, id: 2 }, checkedAt: 20 },
  ]) {
    expect(
      writeLibraryPhotoSource(
        db,
        observation.photo,
        { status: "offline" },
        observation.checkedAt
      )
    ).toBe(false);
    expect(row()).toEqual(original);
  }
  sqlite.exec("UPDATE photos SET deleted_at = 15 WHERE id = 1");
  expect(writeLibraryPhotoSource(db, photo, { status: "offline" }, 20)).toBe(
    false
  );
  expect(row()).toMatchObject({ source_status: "available", deleted_at: 15 });
});

it("compiles once per connection and keeps reopened databases independent", () => {
  const prepare = vi.spyOn(sqlite, "prepare");
  writeLibraryPhotoSource(db, photo, { status: "missing" }, 20);
  expect(prepare).toHaveBeenCalledTimes(2);
  writeLibraryPhotoSource(db, photo, { status: "available" }, 30);
  expect(prepare).toHaveBeenCalledTimes(2);

  const other = createDatabase();
  try {
    const otherDb = drizzle(other);
    expect(
      writeLibraryPhotoSource(otherDb, photo, { status: "offline" }, 25)
    ).toBe(true);
    expect(other.prepare("SELECT source_status FROM photos").get()).toEqual({
      source_status: "offline",
    });
    expect(row()).toMatchObject({ source_status: "available" });
  } finally {
    other.close();
  }
});
