/** @vitest-environment node */
import type { Table } from "@lancedb/lancedb";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appSettings, photos } from "@/db/schema";
import { setColorTable } from "@/services/ai/state";
import {
  backfillColorVectors,
  withVectorDbOperation,
} from "@/services/ai/vector-db";

const fixture = vi.hoisted(() => ({
  db: undefined as ReturnType<typeof drizzle> | undefined,
}));
vi.mock("@/db", () => ({ getDatabase: () => fixture.db }));

interface ColorRow {
  photo_id: number;
  vector: number[];
}

function createColorTable(initialIds: number[] = []) {
  const rows = new Map(
    initialIds.map((id) => [id, { photo_id: id, vector: [10, 20, 30] }])
  );
  const table = {
    countRows: vi.fn(async () => rows.size),
    delete: vi.fn((filter: string) => {
      for (const id of filter.match(/\d+/g) ?? []) {
        rows.delete(Number(id));
      }
      return Promise.resolve();
    }),
    add: vi.fn((entries: ColorRow[]) => {
      for (const row of entries) {
        rows.set(row.photo_id, row);
      }
      return Promise.resolve();
    }),
  };
  return { rows, table, lanceTable: table as unknown as Table };
}

function getFixtureDb() {
  if (!fixture.db) {
    throw new Error("Fixture database is not initialized");
  }
  return fixture.db;
}

function seedPhotos(count: number) {
  getFixtureDb()
    .insert(photos)
    .values(
      Array.from({ length: count }, (_, index) => ({
        id: index + 1,
        filename: `photo-${index + 1}.jpg`,
        path: `/fixture/photo-${index + 1}.jpg`,
        dominantColors: JSON.stringify([{ r: 10, g: 20, b: 30, weight: 1 }]),
        // Hue buckets already exist after a vector store rebuild.
        colorBucket: 210,
        isAiProcessed: true,
      }))
    )
    .run();
}

function setCompletedMarker() {
  getFixtureDb()
    .insert(appSettings)
    .values({ key: "color_vectors_backfilled", value: "true" })
    .run();
}

function completionMarker() {
  return getFixtureDb()
    .select({ value: appSettings.value })
    .from(appSettings)
    .where(eq(appSettings.key, "color_vectors_backfilled"))
    .get()?.value;
}

let sqlite: Database.Database;
beforeEach(() => {
  sqlite = new Database(":memory:");
  fixture.db = drizzle(sqlite);
  migrate(fixture.db, { migrationsFolder: "drizzle" });
});

afterEach(async () => {
  await withVectorDbOperation(() => setColorTable(null));
  sqlite.close();
  fixture.db = undefined;
});

describe("color vector backfill after index rebuild", () => {
  it("refills an empty color table despite the old completion marker and existing hue buckets", async () => {
    seedPhotos(3);
    getFixtureDb()
      .update(photos)
      .set({ deletedAt: Date.now() })
      .where(eq(photos.id, 3))
      .run();
    setCompletedMarker();
    const store = createColorTable();
    setColorTable(store.lanceTable);

    expect(await backfillColorVectors()).toEqual({ total: 2, backfilled: 2 });
    expect([...store.rows.keys()]).toEqual([1, 2]);
    expect(store.rows.get(1)?.vector).toEqual([10, 20, 30]);
    expect(completionMarker()).toBe("true");
    expect(
      getFixtureDb().select().from(photos).where(eq(photos.id, 1)).get()
    ).toMatchObject({ colorBucket: 210, isAiProcessed: true });

    expect(await backfillColorVectors()).toEqual({ total: 0, backfilled: 0 });
    expect(store.table.add).toHaveBeenCalledOnce();
  });

  it("skips a completed nonempty color table without rewriting its rows", async () => {
    seedPhotos(2);
    setCompletedMarker();
    const store = createColorTable([1, 2]);
    setColorTable(store.lanceTable);

    expect(await backfillColorVectors()).toEqual({ total: 0, backfilled: 0 });
    expect(store.table.countRows).toHaveBeenCalledOnce();
    expect(store.table.delete).not.toHaveBeenCalled();
    expect(store.table.add).not.toHaveBeenCalled();
  });

  it("retries all eligible photos after a partial refill rather than trusting the stale marker", async () => {
    seedPhotos(101);
    setCompletedMarker();
    const store = createColorTable();
    setColorTable(store.lanceTable);
    store.table.add.mockImplementationOnce((entries) => {
      for (const row of entries) {
        store.rows.set(row.photo_id, row);
      }
      return Promise.resolve();
    });
    store.table.add.mockRejectedValueOnce(new Error("Simulated write failure"));

    expect(await backfillColorVectors()).toEqual({
      total: 101,
      backfilled: 100,
    });
    expect(store.rows.size).toBe(100);
    expect(completionMarker()).toBeUndefined();

    expect(await backfillColorVectors()).toEqual({
      total: 101,
      backfilled: 101,
    });
    expect(store.rows.size).toBe(101);
    expect(completionMarker()).toBe("true");
  });

  it("holds the count lease and abandons old refill work when the table is replaced", async () => {
    seedPhotos(2);
    setCompletedMarker();
    const oldStore = createColorTable();
    const newStore = createColorTable();
    const countStarted = Promise.withResolvers<void>();
    const releaseCount = Promise.withResolvers<number>();
    oldStore.table.countRows.mockImplementationOnce(() => {
      countStarted.resolve();
      return releaseCount.promise;
    });
    setColorTable(oldStore.lanceTable);
    const backfilling = backfillColorVectors();
    await countStarted.promise;
    let replaced = false;
    const replacing = withVectorDbOperation(() => {
      setColorTable(newStore.lanceTable);
      replaced = true;
    });
    await Promise.resolve();
    expect(replaced).toBe(false);
    releaseCount.resolve(0);
    await replacing;

    expect(await backfilling).toEqual({ total: 2, backfilled: 0 });
    expect(oldStore.table.add).not.toHaveBeenCalled();
    expect(newStore.table.add).not.toHaveBeenCalled();
    expect(completionMarker()).toBeUndefined();
  });
});
