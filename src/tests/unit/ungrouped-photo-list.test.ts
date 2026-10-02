/** @vitest-environment node */
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import {
  invalidateCountCache,
  listPhotos,
} from "@/ipc/photos/handlers/listing";
import {
  createSequence,
  dissolveSequence,
  removeSequenceMembers,
} from "@/ipc/photos/handlers/sequences";
import { notifySequencesChanged } from "@/services/photo-sequences";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: { getPath: () => ".test-runtime", getAppPath: () => process.cwd() },
  BrowserWindow: { getAllWindows: () => [] },
}));
let sqlite: Database.Database;

beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: "C:/fixture", displayName: "fixture" })
    .run();
  for (let id = 1; id <= 7; id++) {
    db.insert(photos)
      .values({
        id,
        filename: `${id}.jpg`,
        path: `C:/fixture/${id}.jpg`,
        folderId: 1,
        fileDate: id,
        isFavorite: id <= 4,
      })
      .run();
  }
  invalidateCountCache();
});
afterEach(() => sqlite.close());

const list = (offset = 0) =>
  call(listPhotos, {
    ungroupedOnly: true,
    sort: "date",
    order: "asc",
    offset,
    limit: 2,
  });

describe("ungrouped photo listing", () => {
  it("paginates only standalone photos while preserving the scoped total", async () => {
    await call(createSequence, { type: "burst", photoIds: [1, 2, 3] });
    const first = await list();
    const second = await list(2);
    expect(first.total).toBe(4);
    expect(first.totalAll).toBe(7);
    expect([...first.items, ...second.items].map((photo) => photo.id)).toEqual([
      4, 5, 6, 7,
    ]);
    const favorite = await call(listPhotos, {
      favoriteOnly: true,
      ungroupedOnly: true,
    });
    expect(favorite.total).toBe(1);
    expect(favorite.totalAll).toBe(4);
  });
  it("invalidates cached totals on creation, removal and dissolution", async () => {
    expect((await list()).total).toBe(7);
    const sequence = await call(createSequence, {
      type: "burst",
      photoIds: [1, 2, 3],
    });
    expect((await list()).total).toBe(4);
    await call(removeSequenceMembers, { id: sequence.id, photoIds: [3] });
    expect((await list()).total).toBe(5);
    await call(dissolveSequence, { id: sequence.id });
    expect((await list()).total).toBe(7);
  });
  it("keeps soft-deleted photos out of both totals and refreshes after restore", async () => {
    await list();
    sqlite.prepare("UPDATE photos SET deleted_at=1 WHERE id=7").run();
    notifySequencesChanged(1, "manual");
    expect((await list()).totalAll).toBe(6);
    sqlite.prepare("UPDATE photos SET deleted_at=NULL WHERE id=7").run();
    notifySequencesChanged(1, "manual");
    expect((await list()).totalAll).toBe(7);
  });
});
