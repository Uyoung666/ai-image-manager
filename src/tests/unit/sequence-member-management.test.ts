/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let sqlite: Database.Database;
let testDatabase: ReturnType<typeof drizzle>;

vi.mock("@/db", () => ({
  getDatabase: () => testDatabase,
}));

import { updateSequenceMembersInPlace } from "@/ipc/photos/handlers/sequences";

beforeEach(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      display_name TEXT NOT NULL
    );
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      folder_id INTEGER,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_indexed INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE exif_data (
      id INTEGER PRIMARY KEY,
      photo_id INTEGER UNIQUE,
      date_taken INTEGER
    );
    CREATE TABLE advanced_exif_data (
      id INTEGER PRIMARY KEY,
      photo_id INTEGER UNIQUE,
      normalized_json TEXT,
      vendor_raw_json TEXT
    );
    CREATE TABLE photo_sequences (
      id INTEGER PRIMARY KEY,
      folder_id INTEGER,
      type TEXT NOT NULL,
      source TEXT NOT NULL,
      representative_photo_id INTEGER,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      frame_count INTEGER NOT NULL,
      user_locked INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE photo_sequence_members (
      id INTEGER PRIMARY KEY,
      sequence_id INTEGER NOT NULL REFERENCES photo_sequences(id) ON DELETE CASCADE,
      photo_id INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
    INSERT INTO folders (id, path, display_name) VALUES
      (1, 'C:/photos', 'photos'),
      (2, 'D:/other', 'other');
    INSERT INTO photos (id, path, filename, folder_id) VALUES
      (1, 'C:/photos/1.jpg', '1.jpg', 1),
      (2, 'C:/photos/2.jpg', '2.jpg', 1),
      (3, 'C:/photos/3.jpg', '3.jpg', 1),
      (4, 'D:/other/4.jpg', '4.jpg', 2);
    INSERT INTO exif_data (photo_id, date_taken) VALUES
      (1, 100), (2, 200), (3, 300), (4, 400);
    INSERT INTO photo_sequences
      (id, folder_id, type, source, representative_photo_id, started_at, ended_at, frame_count, user_locked, created_at, updated_at)
    VALUES (10, 1, 'burst', 'auto', 1, 100, 300, 3, 0, 1, 1);
    INSERT INTO photo_sequence_members (sequence_id, photo_id, position) VALUES
      (10, 1, 0), (10, 2, 1), (10, 3, 2);
  `);
  testDatabase = drizzle(sqlite);
});

afterEach(() => {
  sqlite.close();
});

describe("sequence member management", () => {
  it("preserves the sequence id and the explicit manual order", () => {
    const result = testDatabase.transaction(() =>
      updateSequenceMembersInPlace(testDatabase, 10, [3, 1, 2])
    );

    expect(result).toEqual({ dissolved: false, id: 10 });
    expect(
      sqlite
        .prepare(
          "SELECT photo_id FROM photo_sequence_members WHERE sequence_id = 10 ORDER BY position"
        )
        .all()
        .map((row) => (row as { photo_id: number }).photo_id)
    ).toEqual([3, 1, 2]);
    expect(
      sqlite
        .prepare(
          "SELECT source, user_locked, frame_count FROM photo_sequences WHERE id = 10"
        )
        .get()
    ).toMatchObject({
      frame_count: 3,
      source: "manual",
      user_locked: 1,
    });
  });

  it("chooses a remaining representative and dissolves below two members", () => {
    testDatabase.transaction(() =>
      updateSequenceMembersInPlace(testDatabase, 10, [2, 3])
    );
    expect(
      sqlite
        .prepare(
          "SELECT representative_photo_id FROM photo_sequences WHERE id = 10"
        )
        .get()
    ).toEqual({ representative_photo_id: 2 });

    const result = testDatabase.transaction(() =>
      updateSequenceMembersInPlace(testDatabase, 10, [2])
    );
    expect(result).toEqual({ dissolved: true, id: 10 });
    expect(
      sqlite.prepare("SELECT id FROM photo_sequences WHERE id = 10").get()
    ).toBeUndefined();
  });

  it("rejects duplicates, deleted photos, and cross-folder members", () => {
    expect(() =>
      testDatabase.transaction(() =>
        updateSequenceMembersInPlace(testDatabase, 10, [1, 1])
      )
    ).toThrow("unique");

    sqlite.prepare("UPDATE photos SET deleted_at = 1 WHERE id = 2").run();
    expect(() =>
      testDatabase.transaction(() =>
        updateSequenceMembersInPlace(testDatabase, 10, [1, 2])
      )
    ).toThrow("active photos");

    expect(() =>
      testDatabase.transaction(() =>
        updateSequenceMembersInPlace(testDatabase, 10, [1, 4])
      )
    ).toThrow("one folder");
  });
});
