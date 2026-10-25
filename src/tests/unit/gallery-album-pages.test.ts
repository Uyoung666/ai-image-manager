/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearGalleryAlbumSnapshots,
  getGalleryAlbumLayout,
  getGalleryAlbumPage,
} from "@/services/gallery-albums";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  ids: [] as number[],
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/smart-album-engine", () => ({
  evaluateSmartAlbum: () => state.ids,
}));
let sqlite: Database.Database;
beforeEach(() => {
  clearGalleryAlbumSnapshots();
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  sqlite.exec(
    "INSERT INTO albums(id,name,created_at) VALUES(1,'ordinary',1); INSERT INTO albums(id,name,is_smart,smart_rules,created_at) VALUES(2,'smart',1,'{}',1)"
  );
  const insert = sqlite.prepare(
    "INSERT INTO photos(id,path,filename,file_size,file_date,width,height,created_at) VALUES(?,?,?,?,?,100,150,1)"
  );
  const member = sqlite.prepare(
    "INSERT INTO album_photos(album_id,photo_id) VALUES(1,?)"
  );
  sqlite.transaction(() => {
    for (let id = 1; id <= 5200; id++) {
      insert.run(
        id,
        `C:/fixture/${id}.jpg`,
        `照片-${id % 23}.jpg`,
        id % 7,
        5200 - id
      );
      member.run(id);
    }
  })();
  state.ids = Array.from({ length: 5200 }, (_, index) => index + 1);
});
afterEach(() => {
  clearGalleryAlbumSnapshots();
  sqlite.close();
});
describe("windowed album snapshots", () => {
  it("preserves localized name and size ordering and uses file dates in the worker", async () => {
    const rows = sqlite
      .prepare(
        "SELECT id,filename,file_size AS fileSize,file_date AS fileDate FROM photos"
      )
      .all() as Array<{
      id: number;
      filename: string;
      fileSize: number;
      fileDate: number;
    }>;
    for (const sort of ["date", "name", "size"] as const) {
      const snapshot = await getGalleryAlbumLayout({
        id: 1,
        sort,
        order: "desc",
        locale: "zh-CN",
      });
      const expected = rows.slice().sort((a, b) => {
        let difference = 0;
        if (sort === "name") {
          difference = a.filename.localeCompare(b.filename, "zh-CN");
        }
        if (sort === "size") {
          difference = a.fileSize - b.fileSize;
        }
        if (sort === "date") {
          difference = a.fileDate - b.fileDate;
        }
        return -(difference || a.id - b.id);
      });
      expect(snapshot.items.map((item) => item.id)).toEqual(
        expected.map((item) => item.id)
      );
      expect(snapshot.items[0]).not.toHaveProperty("path");
      const page = getGalleryAlbumPage({
        snapshotId: snapshot.id,
        offset: 5100,
        limit: 100,
      });
      expect(page.items.map((item) => item.id)).toEqual(
        snapshot.items.slice(5100).map((item) => item.id)
      );
    }
  });
  it.each([
    1, 2,
  ])("matches SQLite date ordering for album %i below and above the worker threshold", async (id) => {
    sqlite.exec(
      "UPDATE photos SET file_date=NULL WHERE id IN (1,2); UPDATE photos SET file_date=-10 WHERE id=3; UPDATE photos SET file_date=0 WHERE id IN (4,5)"
    );
    for (const size of [5, 5200]) {
      state.ids = Array.from({ length: size }, (_, index) => index + 1);
      sqlite.exec(
        `DELETE FROM album_photos WHERE album_id=1; INSERT INTO album_photos(album_id,photo_id) SELECT 1,id FROM photos WHERE id<=${size}`
      );
      clearGalleryAlbumSnapshots();
      for (const order of ["asc", "desc"] as const) {
        const layout = await getGalleryAlbumLayout({ id, sort: "date", order });
        const expected = sqlite
          .prepare(
            `SELECT id FROM photos WHERE id<=? ORDER BY file_date ${order}, id ${order}`
          )
          .all(size) as Array<{ id: number }>;
        expect(layout.items.map((photo) => photo.id)).toEqual(
          expected.map((photo) => photo.id)
        );
      }
    }
  });
  it("chunks smart membership and rebuilds after membership changes", async () => {
    const first = await getGalleryAlbumLayout({
      id: 2,
      sort: "date",
      order: "asc",
    });
    expect(first.items).toHaveLength(5200);
    expect(
      (await getGalleryAlbumLayout({ id: 2, sort: "date", order: "asc" })).id
    ).toBe(first.id);
    sqlite.exec("UPDATE photos SET deleted_at=1 WHERE id=5200");
    const changed = await getGalleryAlbumLayout({
      id: 2,
      sort: "date",
      order: "asc",
    });
    expect(changed.id).not.toBe(first.id);
    expect(changed.items).toHaveLength(5199);
  });
});
