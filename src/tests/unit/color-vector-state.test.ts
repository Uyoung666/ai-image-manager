// @vitest-environment node
import type { Table } from "@lancedb/lancedb";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import { setColorTable } from "@/services/ai/state";
import {
  deleteColorVectors,
  searchByColorVector,
  upsertColorVector,
  upsertColorVectors,
} from "@/services/ai/vector-db";
import { getVectorSearchRevision } from "@/services/search-revision";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));

let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(photos)
    .values({ id: 1, path: "/photo.jpg", filename: "photo.jpg" })
    .run();
  state.db = db;
});
afterEach(() => {
  setColorTable(null);
  sqlite.close();
});

describe("color vector state", () => {
  it("serializes delete/add with searches and invalidates cached sessions", async () => {
    const events: string[] = [];
    let release: () => void = () => undefined;
    const pendingDelete = new Promise<void>((resolve) => {
      release = resolve;
    });
    const builder = {
      bypassVectorIndex: vi.fn().mockReturnThis(),
      distanceType: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      toArray: vi.fn(async () => {
        await Promise.resolve();
        events.push("query");
        return [{ photo_id: 1, _distance: 0, content_revision: 0 }];
      }),
      where: vi.fn().mockReturnThis(),
    };
    const table = {
      add: vi.fn(async () => {
        await Promise.resolve();
        events.push("add");
      }),
      delete: vi.fn(async () => {
        events.push("delete");
        await pendingDelete;
      }),
      vectorSearch: vi.fn(() => builder),
    };
    setColorTable(table as unknown as Table);
    const revision = getVectorSearchRevision();
    const writing = upsertColorVector(1, 255, 0, 0);
    await vi.waitFor(() => expect(table.delete).toHaveBeenCalledOnce());
    const searching = searchByColorVector(255, 0, 0, 1, [1], true);
    await Promise.resolve();
    expect(table.vectorSearch).not.toHaveBeenCalled();
    release();
    await writing;
    expect(await searching).toEqual([{ photoId: 1, distanceSquared: 0 }]);
    expect(events).toEqual(["delete", "add", "query"]);
    expect(getVectorSearchRevision()).not.toBe(revision);
  });

  it("invalidates after a partially failed replacement and after deletion", async () => {
    setColorTable({
      add: vi.fn().mockRejectedValue(new Error("failed after deletion")),
      delete: vi.fn().mockResolvedValue(undefined),
    } as unknown as Table);
    const before = getVectorSearchRevision();
    await expect(
      upsertColorVectors([{ photoId: 1, r: 255, g: 0, b: 0 }])
    ).rejects.toThrow("failed after deletion");
    const afterFailure = getVectorSearchRevision();
    expect(afterFailure).not.toBe(before);
    await deleteColorVectors([1]);
    expect(getVectorSearchRevision()).not.toBe(afterFailure);
  });
});
