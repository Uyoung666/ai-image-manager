/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  getGalleryGeometryRevision,
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
  it("upgrades existing tag associations without resetting layout revisions", () => {
    const upgrading = new Database(":memory:");
    try {
      const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
      const tagRevisionIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes(
            "INSERT INTO gallery_data_revision (id, revision) VALUES (3, 0)"
          )
        )
      );
      expect(tagRevisionIndex).toBeGreaterThanOrEqual(0);
      for (const migration of migrations.slice(0, tagRevisionIndex)) {
        for (const statement of migration.sql) {
          upgrading.exec(statement);
        }
      }
      upgrading.exec(
        "INSERT INTO photos(id,path,filename,created_at) VALUES(1,'/existing.jpg','existing.jpg',1); INSERT INTO tags(id,name,created_at) VALUES(1,'existing',1); INSERT INTO photo_tags(photo_id,tag_id) VALUES(1,1)"
      );
      const before = upgrading
        .prepare("SELECT * FROM gallery_data_revision ORDER BY id")
        .all();
      for (const statement of migrations[tagRevisionIndex].sql) {
        upgrading.exec(statement);
      }
      expect(
        upgrading
          .prepare(
            "SELECT * FROM gallery_data_revision WHERE id IN (1,2) ORDER BY id"
          )
          .all()
      ).toEqual(before);
      expect(
        upgrading.prepare("SELECT photo_id,tag_id FROM photo_tags").all()
      ).toEqual([{ photo_id: 1, tag_id: 1 }]);
      upgrading.exec("DELETE FROM photo_tags WHERE photo_id=1 AND tag_id=1");
      expect(
        upgrading
          .prepare(
            "SELECT * FROM gallery_data_revision WHERE id IN (1,2) ORDER BY id"
          )
          .all()
      ).toEqual(before);
      expect(
        upgrading
          .prepare("SELECT revision FROM gallery_data_revision WHERE id=3")
          .get()
      ).toEqual({ revision: 1 });
    } finally {
      upgrading.close();
    }
  });
  for (const mutation of [
    "DELETE FROM photo_tags WHERE photo_id=1 AND tag_id=1",
    "UPDATE photo_tags SET origin='manual',user_confirmed=1 WHERE photo_id=1",
    "INSERT INTO photo_tags(photo_id,tag_id) VALUES(25,1)",
    "UPDATE tags SET name='renamed' WHERE id=1",
    "UPDATE tags SET parent_id=2 WHERE id=1",
    "DELETE FROM tags WHERE id=1",
  ]) {
    it(`isolates tag revisions from ordinary/favorite pagination: ${mutation}`, () => {
      sqlite.exec(
        "INSERT INTO tags(id,name,created_at) VALUES(1,'tag',1),(2,'parent',1); INSERT INTO photo_tags(photo_id,tag_id) SELECT id,1 FROM photos WHERE id<=20; UPDATE photos SET is_favorite=1"
      );
      const base = { sort: "date" as const, order: "desc" as const, limit: 4 };
      const ordinary = listGalleryPhotos(base);
      const favorite = listGalleryPhotos({ ...base, favoriteOnly: true });
      const tagged = listGalleryPhotos({ ...base, tagId: 1 });
      const before = [getGalleryRevision(), getGalleryGeometryRevision()];
      sqlite.exec(mutation);
      expect([getGalleryRevision(), getGalleryGeometryRevision()]).toEqual(
        before
      );
      expect(() =>
        listGalleryPhotos({ ...base, cursor: ordinary.nextCursor })
      ).not.toThrow();
      expect(() =>
        listGalleryPhotos({
          ...base,
          favoriteOnly: true,
          cursor: favorite.nextCursor,
        })
      ).not.toThrow();
      expect(() =>
        listGalleryPhotos({ ...base, tagId: 1, cursor: tagged.nextCursor })
      ).toThrow("GALLERY_CURSOR_EXPIRED");
      const fresh = listGalleryPhotos({ ...base, tagId: 1 });
      expect(fresh.geometryRevision).toBe(fresh.revision);
    });
  }

  it("refreshes descendant AND/OR counts and sources after removing a tag", () => {
    sqlite.exec(
      "INSERT INTO tags(id,name,parent_id,created_at) VALUES(1,'parent',NULL,1),(2,'child',1,1),(3,'other',NULL,1); INSERT INTO photo_tags(photo_id,tag_id) VALUES(1,2),(1,3),(2,2),(3,3)"
    );
    const base = {
      sort: "date" as const,
      order: "desc" as const,
      limit: 100,
      tagIds: [1, 3],
    };
    expect(listGalleryPhotos({ ...base, tagMode: "and" }).total).toBe(1);
    expect(listGalleryPhotos({ ...base, tagMode: "or" }).total).toBe(3);
    const revision = listGalleryPhotos(base).geometryRevision;
    sqlite.exec("DELETE FROM photo_tags WHERE photo_id=1 AND tag_id=2");
    expect(listGalleryPhotos({ ...base, tagMode: "and" }).total).toBe(0);
    expect(listGalleryPhotos({ ...base, tagMode: "or" }).total).toBe(3);
    expect(listGalleryPhotos(base).geometryRevision).not.toBe(revision);
  });

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
