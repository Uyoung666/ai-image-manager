/** @vitest-environment node */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { albumPhotos, albums, photos, photoTags, tags } from "@/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({ suggestTags: vi.fn() }));

import { getAlbum, listAlbums } from "@/ipc/albums/handlers";
import {
  deleteTag,
  removePhotoTag,
  setPhotoTag,
} from "@/ipc/photos/handlers/tags";
import {
  invalidateSmartAlbumCache,
  type SmartAlbumRules,
} from "@/services/smart-album-engine";

let sqlite: Database.Database;
beforeEach(() => {
  invalidateSmartAlbumCache();
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(tags)
    .values([
      { id: 1, name: "Primary" },
      { id: 2, name: "Secondary" },
    ])
    .run();
  for (let id = 1; id <= 3; id++) {
    db.insert(photos)
      .values({ id, filename: `${id}.jpg`, path: `/${id}.jpg`, fileDate: id })
      .run();
    db.insert(photoTags).values({ photoId: id, tagId: 1 }).run();
  }
  db.insert(albums)
    .values({
      id: 1,
      name: "Smart",
      isSmart: true,
      smartRules: JSON.stringify({
        rules: [{ type: "tags", operator: "包含任一", value: ["Primary"] }],
      } satisfies SmartAlbumRules),
    })
    .run();
  db.insert(albums).values({ id: 2, name: "Manual", coverPhotoId: 3 }).run();
  db.insert(albumPhotos)
    .values([1, 2, 3].map((photoId) => ({ albumId: 2, photoId })))
    .run();
});

afterEach(() => {
  invalidateSmartAlbumCache();
  sqlite.close();
});

async function expectSmart(ids: number[], cover: number | null) {
  const album = await call(getAlbum, { id: 1 });
  expect(album.photos.map((photo) => photo.id)).toEqual(ids);
  expect(album.coverPhotoId).toBe(cover);
  expect("matchCount" in album && album.matchCount).toBe(ids.length);
  const list = await call(listAlbums, {});
  expect(list.find((item) => item.id === 1)?.coverPhotoId).toBe(cover);
}

describe("smart album tag refresh", () => {
  it("removes the cover immediately and keeps manual album membership", async () => {
    await expectSmart([3, 2, 1], 3);
    await call(removePhotoTag, { photoId: 3, tagId: 1 });
    await expectSmart([2, 1], 2);
    expect(
      (await call(getAlbum, { id: 2 })).photos.map((photo) => photo.id)
    ).toEqual([3, 2, 1]);
  });

  it("removes a non-cover and clears the cover after the last member leaves", async () => {
    await expectSmart([3, 2, 1], 3);
    await call(removePhotoTag, { photoId: 1, tagId: 1 });
    await expectSmart([3, 2], 3);
    await call(removePhotoTag, { photoId: 3, tagId: 1 });
    await expectSmart([2], 2);
    await call(removePhotoTag, { photoId: 2, tagId: 1 });
    await expectSmart([], null);
  });

  it("adds matching photos back before a warm cache expires", async () => {
    await call(removePhotoTag, { photoId: 3, tagId: 1 });
    await expectSmart([2, 1], 2);
    await call(setPhotoTag, { photoId: 3, tagId: 1 });
    await expectSmart([3, 2, 1], 3);
  });

  it("refreshes cached albums when the entire tag is deleted", async () => {
    await expectSmart([3, 2, 1], 3);
    await call(deleteTag, { id: 1 });
    await expectSmart([], null);
  });

  it.each([
    "包含任一",
    "包含全部",
  ] as const)("reevaluates %s rules instead of blindly removing a photo", async (operator) => {
    sqlite.prepare("INSERT INTO photo_tags(photo_id,tag_id) VALUES(3,2)").run();
    sqlite.prepare("UPDATE albums SET smart_rules = ? WHERE id = 1").run(
      JSON.stringify({
        rules: [{ type: "tags", operator, value: ["Primary", "Secondary"] }],
      })
    );
    await expectSmart(operator === "包含任一" ? [3, 2, 1] : [3], 3);
    await call(removePhotoTag, { photoId: 3, tagId: 1 });
    await expectSmart(
      operator === "包含任一" ? [3, 2, 1] : [],
      operator === "包含任一" ? 3 : null
    );
  });

  it("preserves members and cover when the tag write fails", async () => {
    await expectSmart([3, 2, 1], 3);
    sqlite.exec(`CREATE TRIGGER fail_remove BEFORE DELETE ON photo_tags
      BEGIN SELECT RAISE(ABORT, 'fixture failure'); END;`);
    await expect(
      call(removePhotoTag, { photoId: 3, tagId: 1 })
    ).rejects.toThrow("fixture failure");
    await expectSmart([3, 2, 1], 3);
  });
});
