/**
 * @vitest-environment node
 *
 * Regression coverage for soft-deleted photos in manual albums.
 */

import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

vi.mock("@/db", () => ({
  getDatabase: () => mocks.db,
}));

vi.mock("@/services/smart-album-engine", () => ({
  evaluateSmartAlbum: vi.fn(),
  validateSmartRules: vi.fn(),
}));

import { albumPhotos, albums, photos } from "@/db/schema";
import { getAlbum } from "@/ipc/albums/handlers";
import { evaluateSmartAlbum } from "@/services/smart-album-engine";

describe("manual album visibility", () => {
  const sqlite = new Database(":memory:");

  beforeEach(() => {
    sqlite.exec(`
      DROP TABLE IF EXISTS album_photos;
      DROP TABLE IF EXISTS photos;
      DROP TABLE IF EXISTS albums;
      CREATE TABLE albums (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        cover_photo_id INTEGER,
        is_smart INTEGER NOT NULL DEFAULT 0,
        smart_rules TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE photos (
        id INTEGER PRIMARY KEY,
        path TEXT NOT NULL,
        filename TEXT NOT NULL,
        file_size INTEGER,
        file_date INTEGER,
        width INTEGER,
        height INTEGER,
        format TEXT,
        thumbnail_path TEXT,
        is_indexed INTEGER NOT NULL DEFAULT 0,
        is_favorite INTEGER NOT NULL DEFAULT 0,
        deleted_at INTEGER
      );
      CREATE TABLE album_photos (
        id INTEGER PRIMARY KEY,
        album_id INTEGER,
        photo_id INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO albums (id, name, created_at)
        VALUES (1, 'Test album', 1);
      INSERT INTO photos
        (id, path, filename, file_size, file_date, width, height, format, thumbnail_path, is_indexed, deleted_at)
        VALUES
        (1, '/photos/active.jpg', 'active.jpg', 10, 1, 100, 100, 'jpg', '/thumbs/active.webp', 1, NULL),
        (2, '/photos/deleted.jpg', 'deleted.jpg', 10, 2, 100, 100, 'jpg', '/thumbs/deleted.webp', 1, 123);
      INSERT INTO album_photos (id, album_id, photo_id, sort_order)
        VALUES (1, 1, 1, 0), (2, 1, 2, 1);
    `);
    mocks.db = drizzle(sqlite, { schema: { albumPhotos, albums, photos } });
  });

  afterAll(() => {
    sqlite.close();
  });

  it.each([
    false,
    true,
  ])("reloads current favorite flags for an album (smart=%s)", async (smart) => {
    sqlite.exec(`
      UPDATE photos SET is_favorite = 1 WHERE id = 1;
      INSERT INTO photos (id, path, filename, is_favorite) VALUES (3, '/photos/other.jpg', 'other.jpg', 0);
      INSERT INTO album_photos (id, album_id, photo_id, sort_order) VALUES (3, 1, 3, 2);
    `);
    if (smart) {
      sqlite
        .prepare("UPDATE albums SET is_smart = 1, smart_rules = ? WHERE id = 1")
        .run(JSON.stringify({ rules: [] }));
      vi.mocked(evaluateSmartAlbum).mockReturnValue([1, 2, 3]);
    }
    const loadFlags = async () =>
      (await call(getAlbum, { id: 1 })).photos
        .map((photo) => ({ id: photo.id, isFavorite: photo.isFavorite }))
        .sort((a, b) => a.id - b.id);
    expect(await loadFlags()).toEqual([
      { id: 1, isFavorite: true },
      { id: 3, isFavorite: false },
    ]);
    sqlite.exec(
      "UPDATE photos SET is_favorite = CASE id WHEN 1 THEN 0 WHEN 3 THEN 1 ELSE is_favorite END"
    );
    expect(await loadFlags()).toEqual([
      { id: 1, isFavorite: false },
      { id: 3, isFavorite: true },
    ]);
  });

  it("hides soft-deleted photos while keeping the album association", async () => {
    const loadAlbum = (
      getAlbum as typeof getAlbum & {
        callable: () => (input: { id: number }) => Promise<unknown>;
      }
    ).callable();
    const result = (await loadAlbum({ id: 1 })) as {
      photos: Array<{ id: number }>;
    };

    expect(result.photos.map((photo) => photo.id)).toEqual([1]);
    expect(
      sqlite
        .prepare(
          "SELECT COUNT(*) AS count FROM album_photos WHERE album_id = 1"
        )
        .get()
    ).toEqual({ count: 2 });
  });
});
