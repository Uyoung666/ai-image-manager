/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let sqlite: Database.Database;
let testDatabase: ReturnType<typeof drizzle>;

vi.mock("@/db", () => ({
  getDatabase: () => testDatabase,
}));

import { querySequences } from "@/ipc/photos/handlers/sequences";

function insertPhoto(
  id: number,
  folderId: number,
  options: {
    deletedAt?: number;
    favorite?: boolean;
  } = {}
) {
  sqlite
    .prepare(
      `INSERT INTO photos
        (id, path, filename, folder_id, is_favorite, is_indexed, deleted_at)
       VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
    .run(
      id,
      `C:/photos/${id}.jpg`,
      `${id}.jpg`,
      folderId,
      options.favorite ? 1 : 0,
      options.deletedAt ?? null
    );
}

beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.exec(`
    CREATE TABLE folders (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      parent_id INTEGER
    );
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      filename TEXT NOT NULL,
      folder_id INTEGER,
      file_size INTEGER,
      file_date INTEGER,
      width INTEGER,
      height INTEGER,
      thumbnail_path TEXT,
      dominant_colors TEXT,
      is_favorite INTEGER NOT NULL DEFAULT 0,
      is_indexed INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
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
      user_locked INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE photo_sequence_members (
      id INTEGER PRIMARY KEY,
      sequence_id INTEGER NOT NULL,
      photo_id INTEGER NOT NULL,
      position INTEGER NOT NULL
    );
    CREATE TABLE photo_tags (
      id INTEGER PRIMARY KEY,
      photo_id INTEGER,
      tag_id INTEGER
    );
  `);
  testDatabase = drizzle(sqlite);

  sqlite.exec(`
    INSERT INTO folders (id, path, display_name, parent_id) VALUES
      (1, 'C:/photos', 'root', NULL),
      (2, 'C:/photos/child', 'child', 1),
      (3, 'D:/other', 'other', NULL);
  `);

  insertPhoto(1, 2);
  insertPhoto(2, 2, { favorite: true });
  insertPhoto(3, 2, { favorite: true });
  insertPhoto(4, 2, { deletedAt: 123, favorite: true });
  insertPhoto(5, 3, { favorite: true });
  insertPhoto(6, 3, { favorite: true });

  sqlite.exec(`
    INSERT INTO photo_sequences
      (id, folder_id, type, source, representative_photo_id, started_at, ended_at, frame_count)
    VALUES
      (10, 2, 'burst', 'auto', 1, 100, 300, 4),
      (20, 3, 'burst', 'auto', 5, 500, 600, 2);
    INSERT INTO photo_sequence_members
      (id, sequence_id, photo_id, position)
    VALUES
      (1, 10, 3, 2),
      (2, 10, 1, 0),
      (3, 10, 4, 3),
      (4, 10, 2, 1),
      (5, 20, 6, 1),
      (6, 20, 5, 0);
    INSERT INTO photo_tags (id, photo_id, tag_id) VALUES
      (1, 1, 10),
      (2, 2, 10),
      (3, 2, 20),
      (4, 3, 20),
      (5, 4, 10);
  `);
});

afterAll(() => {
  sqlite.close();
});

describe("listSequences query", () => {
  it("returns full and matched member ids in sequence position order", () => {
    const [sequence] = querySequences({
      photoIds: [3, 2],
      scope: "members",
    });

    expect(sequence.memberPhotoIds).toEqual([1, 2, 3]);
    expect(sequence.frameCount).toBe(3);
    expect(sequence.matchedPhotoIds).toEqual([2, 3]);
    expect(sequence.matchedCount).toBe(2);
  });

  it("keeps the global representative while matching a members scope without it", () => {
    const [sequence] = querySequences({
      photoIds: [2, 3],
      scope: "members",
    });

    expect(sequence.representativePhotoId).toBe(1);
    expect(sequence.photo.id).toBe(1);
    expect(sequence.matchedPhotoIds).toEqual([2, 3]);
  });

  it("applies folder descendants, favorite, and AND tag gallery filters", () => {
    const result = querySequences({
      favoriteOnly: true,
      folderId: 1,
      scope: "gallery",
      tagIds: [10, 20],
      tagMode: "and",
    });

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(10);
    expect(result[0].matchedPhotoIds).toEqual([2]);
    expect(result[0].matchedCount).toBe(1);
  });

  it("applies OR tags and excludes deleted photos from gallery matches", () => {
    const [sequence] = querySequences({
      folderId: 1,
      scope: "gallery",
      tagIds: [10, 20],
      tagMode: "or",
    });

    expect(sequence.matchedPhotoIds).toEqual([1, 2, 3]);
    expect(sequence.matchedPhotoIds).not.toContain(4);
  });

  it("omits sequences with no member in the requested scope", () => {
    expect(querySequences({ photoIds: [999], scope: "members" })).toEqual([]);
  });
});
