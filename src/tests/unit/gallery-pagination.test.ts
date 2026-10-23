/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  getGalleryLayoutPrefix,
  getGalleryRevision,
  listGalleryPhotos,
} from "@/services/gallery-listing";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: "C:/fixture", displayName: "fixture" })
    .run();
  for (let id = 1; id <= 25; id++) {
    db.insert(photos)
      .values({
        id,
        path: `C:/fixture/${id}.jpg`,
        filename: `same-${id % 3}.jpg`,
        fileSize: id % 4 === 0 ? null : id % 3,
        fileDate: id % 4 === 0 ? null : id % 3,
        folderId: 1,
        width: 100,
        height: 150,
      })
      .run();
  }
});
afterEach(() => sqlite.close());

describe("gallery keyset pagination", () => {
  for (const sort of ["date", "name", "size"] as const) {
    for (const order of ["asc", "desc"] as const) {
      it(`${sort}/${order} has stable null and equal-key boundaries in both directions`, () => {
        const input = { sort, order, limit: 4 };
        const ids: number[] = [];
        let cursor: string | null = null;
        do {
          const page = listGalleryPhotos({ ...input, cursor });
          ids.push(...page.items.map((photo) => photo.id));
          cursor = page.nextCursor;
        } while (cursor);
        const column = {
          date: "file_date",
          name: "filename",
          size: "file_size",
        }[sort];
        const expected = sqlite
          .prepare(
            `SELECT id FROM photos WHERE deleted_at IS NULL ORDER BY ${column} ${order}, id ${order}`
          )
          .all()
          .map((row) => (row as { id: number }).id);
        expect(ids).toEqual(expected);
        const first = listGalleryPhotos(input);
        const second = listGalleryPhotos({
          ...input,
          cursor: first.nextCursor,
        });
        const previous = listGalleryPhotos({
          ...input,
          cursor: second.previousCursor,
          direction: "previous",
        });
        expect(previous.items.map((photo) => photo.id)).toEqual(
          first.items.map((photo) => photo.id)
        );
        const prefix = getGalleryLayoutPrefix(input, ids[16]);
        expect(prefix?.items.map((photo) => photo.id)).toEqual(
          ids.slice(0, 17)
        );
      });
    }
  }
  it("rejects crossed filters and expired cursors but ignores thumbnail/AI status writes", () => {
    const input = { sort: "date" as const, order: "desc" as const, limit: 5 };
    const first = listGalleryPhotos(input);
    expect(() =>
      listGalleryPhotos({
        ...input,
        favoriteOnly: true,
        cursor: first.nextCursor,
      })
    ).toThrow("Invalid gallery cursor");
    const revision = getGalleryRevision();
    sqlite
      .prepare(
        "UPDATE photos SET thumbnail_path='one.webp', is_ai_processed=1 WHERE id=1"
      )
      .run();
    expect(getGalleryRevision()).toBe(revision);
    sqlite.prepare("UPDATE photos SET is_favorite=1 WHERE id=1").run();
    expect(() =>
      listGalleryPhotos({ ...input, cursor: first.nextCursor })
    ).not.toThrow();
    sqlite.prepare("UPDATE photos SET file_date=99 WHERE id=1").run();
    expect(() =>
      listGalleryPhotos({ ...input, cursor: first.nextCursor })
    ).toThrow("GALLERY_CURSOR_EXPIRED");
  });
  it("expires favorite-filter cursors when favorite membership changes", () => {
    sqlite.prepare("UPDATE photos SET is_favorite=1 WHERE id<=15").run();
    const input = {
      sort: "date" as const,
      order: "desc" as const,
      limit: 5,
      favoriteOnly: true,
    };
    const first = listGalleryPhotos(input);
    expect(first.nextCursor).toBeTruthy();
    sqlite.prepare("UPDATE photos SET is_favorite=1 WHERE id=20").run();
    expect(() =>
      listGalleryPhotos({ ...input, cursor: first.nextCursor })
    ).toThrow("GALLERY_CURSOR_EXPIRED");
  });
  it("uses the filtered total and excludes removed photos", () => {
    sqlite.prepare("UPDATE photos SET deleted_at=1 WHERE id=1").run();
    const page = listGalleryPhotos({
      sort: "date",
      order: "desc",
      limit: 100,
      folderId: 1,
    });
    expect(page.total).toBe(24);
    expect(page.items.some((photo) => photo.id === 1)).toBe(false);
  });
});
