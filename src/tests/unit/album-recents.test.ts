/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getRecentAlbums, rememberAlbum } from "@/services/album-recents";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  const insert = sqlite.prepare(
    "INSERT INTO albums(id,name,created_at) VALUES(?,?,1)"
  );
  for (let id = 1; id <= 7; id++) {
    insert.run(id, `Album ${id}`);
  }
});
afterEach(() => sqlite.close());
it("remembers five targets in most-recent order without duplicates", () => {
  for (let id = 1; id <= 7; id++) {
    rememberAlbum(id);
  }
  rememberAlbum(4);
  expect(getRecentAlbums().map((album) => album.id)).toEqual([4, 7, 6, 5, 3]);
});
it("ignores deleted and smart targets and uses the current album name", () => {
  rememberAlbum(1);
  rememberAlbum(2);
  rememberAlbum(3);
  sqlite.exec(
    "DELETE FROM albums WHERE id=2; UPDATE albums SET is_smart=1 WHERE id=3; UPDATE albums SET name='Renamed' WHERE id=1"
  );
  expect(getRecentAlbums().map(({ id, name }) => ({ id, name }))).toEqual([
    { id: 1, name: "Renamed" },
  ]);
});
it("does not carry IDs into another library and tolerates corrupted settings", () => {
  rememberAlbum(1);
  const other = new Database(":memory:");
  const otherDb = drizzle(other);
  migrate(otherDb, { migrationsFolder: "drizzle" });
  expect(
    getRecentAlbums(otherDb as Parameters<typeof getRecentAlbums>[0])
  ).toEqual([]);
  other.close();
  sqlite.exec("UPDATE app_settings SET value='oops'");
  expect(getRecentAlbums()).toEqual([]);
});
