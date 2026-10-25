/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyBatchTags,
  getBatchTagOptions,
  getBatchTagSummary,
  undoBatchTags,
} from "@/services/batch-photo-tags";
import { invalidateTagSearch } from "@/services/tag-search-revision";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/smart-album-engine", () => ({
  invalidateSmartAlbumCache: vi.fn(),
}));
let sqlite: Database.Database;
const operationId = "cbd27849-44ce-4eca-a592-561a0bfecad8";
beforeEach(() => {
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  sqlite.exec(
    "INSERT INTO photos(id,path,filename,created_at) VALUES(1,'a','a',1),(2,'b','b',1),(3,'c','c',1); UPDATE photos SET deleted_at=1 WHERE id=3; INSERT INTO tags(id,name,created_at) VALUES(1,'Travel',1),(2,'Work',1); INSERT INTO photo_tags(photo_id,tag_id,confidence,origin,is_confirmed,user_confirmed) VALUES(1,1,0.8,'auto',1,0)"
  );
});
afterEach(() => sqlite.close());
describe("batch tag transactions and conditional undo", () => {
  it("rejects oversized relation batches without applying partial changes", () => {
    expect(() =>
      applyBatchTags({
        ids: Array.from({ length: 501 }, (_, index) => index + 1),
        addTagIds: [1, 2],
        removeTagIds: [],
        operationId,
      })
    ).toThrow("relation budget");
    expect(getBatchTagSummary([1, 2]).counts).toEqual([{ id: 1, count: 1 }]);
  });
  it("loads only tag definitions for the picker without reading library membership", () => {
    // A catalog read must not depend on a full photo_tags scan.
    sqlite.exec("ALTER TABLE photo_tags RENAME TO unavailable_photo_tags");
    expect(getBatchTagOptions().map(({ name }) => name)).toEqual([
      "Travel",
      "Work",
    ]);
  });
  it("counts direct ownership only among active selected photos", () => {
    expect(getBatchTagSummary([1, 2, 3, 999])).toEqual({
      total: 2,
      counts: [{ id: 1, count: 1 }],
    });
  });
  it("adds only missing associations and preserves existing AI provenance", () => {
    expect(
      applyBatchTags({
        ids: [1, 2, 3],
        addTagIds: [1],
        removeTagIds: [],
        operationId,
      }).changed
    ).toBe(1);
    expect(
      sqlite
        .prepare(
          "SELECT origin, confidence, user_confirmed FROM photo_tags WHERE photo_id=1"
        )
        .get()
    ).toEqual({ origin: "auto", confidence: 0.8, user_confirmed: 0 });
    expect(
      sqlite
        .prepare(
          "SELECT origin,user_confirmed FROM photo_tags WHERE photo_id=2"
        )
        .get()
    ).toEqual({ origin: "manual", user_confirmed: 1 });
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 1,
      skipped: 0,
      done: true,
    });
    expect(
      sqlite.prepare("SELECT COUNT(*) AS count FROM photo_tags").get()
    ).toEqual({ count: 1 });
  });
  it("restores the original provenance after a removal", () => {
    applyBatchTags({ ids: [1], addTagIds: [], removeTagIds: [1], operationId });
    expect(undoBatchTags(operationId).restored).toBe(1);
    expect(
      sqlite
        .prepare(
          "SELECT origin,confidence,is_confirmed,user_confirmed FROM photo_tags"
        )
        .get()
    ).toEqual({
      origin: "auto",
      confidence: 0.8,
      is_confirmed: 1,
      user_confirmed: 0,
    });
  });
  it("keeps later edits to newly added tags", () => {
    applyBatchTags({
      ids: [1, 2],
      addTagIds: [2],
      removeTagIds: [],
      operationId,
    });
    sqlite.exec(
      "UPDATE photo_tags SET confidence=0.7,origin='auto' WHERE photo_id=1 AND tag_id=2"
    );
    invalidateTagSearch();
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 1,
      skipped: 1,
    });
    expect(
      sqlite
        .prepare(
          "SELECT confidence FROM photo_tags WHERE photo_id=1 AND tag_id=2"
        )
        .get()
    ).toEqual({ confidence: 0.7 });
  });
  it("does not resurrect a removed tag after intervening tag edits", () => {
    applyBatchTags({ ids: [1], addTagIds: [], removeTagIds: [1], operationId });
    invalidateTagSearch();
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 0,
      skipped: 1,
    });
  });
  it("supports multiple chunks and undo pages under one operation", () => {
    applyBatchTags({ ids: [1], addTagIds: [2], removeTagIds: [], operationId });
    applyBatchTags({ ids: [2], addTagIds: [2], removeTagIds: [], operationId });
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 2,
      skipped: 0,
      done: true,
    });
    expect(undoBatchTags(operationId).expired).toBe(true);
  });
  it("pages large undo receipts without dropping changes at the boundary", () => {
    const insert = sqlite.prepare(
      "INSERT INTO photos(id,path,filename,created_at) VALUES(?,?,?,1)"
    );
    sqlite.transaction(() => {
      for (let id = 4; id <= 1003; id++) {
        insert.run(id, `photo-${id}`, `photo-${id}`);
      }
    })();
    const ids = Array.from({ length: 1003 }, (_, index) => index + 1);
    applyBatchTags({
      ids: ids.slice(0, 1000),
      addTagIds: [2],
      removeTagIds: [],
      operationId,
    });
    applyBatchTags({
      ids: ids.slice(1000),
      addTagIds: [2],
      removeTagIds: [],
      operationId,
    });
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 1000,
      skipped: 0,
      done: false,
    });
    expect(undoBatchTags(operationId)).toMatchObject({
      restored: 2,
      skipped: 0,
      done: true,
    });
  });
  it("rejects stale tag targets before writing and isolates library receipts", () => {
    expect(() =>
      applyBatchTags({
        ids: [1],
        addTagIds: [999],
        removeTagIds: [1],
        operationId,
      })
    ).toThrow();
    expect(getBatchTagSummary([1]).counts).toEqual([{ id: 1, count: 1 }]);
    applyBatchTags({ ids: [1], addTagIds: [2], removeTagIds: [], operationId });
    const other = new Database(":memory:");
    expect(
      undoBatchTags(
        operationId,
        drizzle(other) as Parameters<typeof undoBatchTags>[1]
      ).expired
    ).toBe(true);
    other.close();
  });
});
