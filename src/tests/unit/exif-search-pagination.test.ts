// @vitest-environment node
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exifData, photos } from "@/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({}));
vi.mock("@/services/ai/health", () => ({}));
vi.mock("@/services/ai/search-sensitivity", () => ({
  getActiveSearchSensitivity: () => "balanced",
}));
vi.mock("@/services/image-search-preview", () => ({}));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;

beforeEach(() => {
  vi.resetModules();
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
});
afterEach(() => sqlite.close());

function seed(count: number) {
  db.transaction(() => {
    for (let i = 1; i <= count; i++) {
      const row = db
        .insert(photos)
        .values({
          filename: `test-${i}.jpg`,
          path: `/fixture/test-${i}.jpg`,
          fileDate: 1,
        })
        .returning({ id: photos.id })
        .get();
      db.insert(exifData).values({ photoId: row.id, iso: 200 }).run();
    }
  });
}

describe("EXIF SQL pagination", () => {
  it.each([
    99, 100, 101, 150,
  ])("makes all %i matching records reachable in bounded pages", async (count) => {
    seed(count);
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const ids: number[] = [];
    let offset = 0;
    for (;;) {
      const response = await call(searchCompound, {
        isoMin: 200,
        isoMax: 200,
        limit: 100,
        offset,
      });
      expect(response.total).toBe(count);
      expect(response.results.length).toBeLessThanOrEqual(100);
      ids.push(...response.results.map((row) => (row as { id: number }).id));
      if (!("hasMore" in response && response.hasMore)) {
        break;
      }
      const nextOffset = "nextOffset" in response ? response.nextOffset : null;
      expect(nextOffset).toBeGreaterThan(offset);
      offset = nextOffset as number;
    }
    expect(ids).toHaveLength(count);
    expect(new Set(ids).size).toBe(count);
    expect(ids.at(-1)).toBe(1);
  });

  it("keeps different page sizes separate and excludes deleted photos", async () => {
    seed(150);
    sqlite.prepare("UPDATE photos SET deleted_at=1 WHERE id=150").run();
    const { searchCompound } = await import("@/ipc/photos/handlers/search");
    const small = await call(searchCompound, { isoMin: 200, limit: 1 });
    const large = await call(searchCompound, { isoMin: 200, limit: 100 });
    expect(small.total).toBe(149);
    expect(small.results).toHaveLength(1);
    expect(large.results).toHaveLength(100);
    expect(
      large.results.some((row) => (row as { id: number }).id === 150)
    ).toBe(false);
    const empty = await call(searchCompound, { isoMin: 400 });
    expect(empty.results).toEqual([]);
    expect(empty.total).toBe(0);
  });
});
