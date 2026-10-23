/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  getGalleryLayoutPrefix,
  listGalleryPhotos,
} from "@/services/gallery-listing";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
let sqlite: Database.Database;
beforeAll(() => {
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  const insert = sqlite.prepare(
    "INSERT INTO photos(id,path,filename,file_date,file_size,width,height,created_at) VALUES(?,?,?,?,?,100,150,1)"
  );
  sqlite.transaction(() => {
    for (let id = 1; id <= 100_000; id++) {
      insert.run(
        id,
        `C:/fixture/${id}.webp`,
        `${String(id).padStart(6, "0")}.webp`,
        id,
        id
      );
    }
  })();
});
afterAll(() => sqlite.close());
describe("100k gallery queries", () => {
  it("uses indexed tuple seeks at deep date, name and size boundaries", () => {
    for (const column of ["file_date", "filename", "file_size"]) {
      const value = column === "filename" ? "090000.webp" : 90_000;
      const plan = sqlite
        .prepare(
          `EXPLAIN QUERY PLAN SELECT id FROM photos WHERE deleted_at IS NULL AND (${column},id)>(?,?) ORDER BY ${column},id LIMIT 100`
        )
        .all(value, 90_000) as Array<{ detail: string }>;
      expect(
        plan.some(
          (step) =>
            step.detail.includes("SEARCH") && step.detail.includes(column)
        )
      ).toBe(true);
      expect(plan.some((step) => step.detail.includes("TEMP B-TREE"))).toBe(
        false
      );
    }
    const prefix = getGalleryLayoutPrefix(
      { sort: "date", order: "asc", limit: 100 },
      90_000
    );
    const page = listGalleryPhotos({
      sort: "date",
      order: "asc",
      limit: 100,
      cursor: prefix?.nextCursor,
    });
    expect(page.items[0].id).toBe(90_101);
    expect(page.items).toHaveLength(100);
  });
  it("restores next or previous neighbors after anchor deletion without hydrating the prefix", () => {
    sqlite.exec("UPDATE photos SET deleted_at=1 WHERE id=80000");
    const result = getGalleryLayoutPrefix(
      { sort: "date", order: "asc", limit: 100 },
      80_000,
      [80_001, 79_999],
      79_999
    );
    expect(result?.anchorId).toBe(80_001);
    expect(result?.tailItems).toHaveLength(100);
    expect(result?.items[0]).not.toHaveProperty("path");
  });
});
