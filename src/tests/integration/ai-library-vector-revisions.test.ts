/** @vitest-environment node */
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema } from "apache-arrow";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ db: undefined as unknown, dataPath: "" }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => state.dataPath,
    isPackaged: false,
  },
}));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));

import {
  currentLanceRows,
  lancePhotoRevisionFilter,
} from "@/services/ai/photo-version";
import { ensureContentRevisionColumn } from "@/services/ai/vector-db";

let runtime: TestRuntime;
let sqlite: Database.Database;
let connection: Connection;
let tables: Table[];
let db: ReturnType<typeof drizzle>;

beforeEach(async () => {
  tables = [];
  runtime = new TestRuntime("library-vector-revisions");
  state.dataPath = runtime.root;
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(photos)
    .values([
      { id: 1, path: "/old.jpg", filename: "old.jpg", sourceStatus: "offline" },
      {
        id: 2,
        path: "/changed.jpg",
        filename: "changed.jpg",
        contentRevision: 1,
      },
      {
        id: 3,
        path: "/new.jpg",
        filename: "new.jpg",
        contentRevision: 2,
        embeddingRevision: 2,
      },
    ])
    .run();
  connection = await connect(runtime.root);
});

afterEach(async () => {
  for (const table of tables) {
    table.close();
  }
  await connection.close();
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("upgrades a legacy Lance table idempotently without deleting its vectors", async () => {
  const table = await connection.createTable("legacy", [
    { photo_id: 1, vector: [1, 0] },
  ]);
  tables.push(table);
  await ensureContentRevisionColumn(table);
  await ensureContentRevisionColumn(table);
  expect(await table.countRows()).toBe(1);
  expect((await table.query().toArray())[0].content_revision).toBe(0);
});

it("filters stale revisions before top-k while retaining valid offline results", async () => {
  const schema = new Schema([
    new Field("photo_id", new Int32()),
    new Field("vector", new FixedSizeList(2, new Field("item", new Float32()))),
    new Field("content_revision", new Int32()),
  ]);
  const table = await connection.createEmptyTable("versions", schema);
  tables.push(table);
  await table.add([
    { photo_id: 1, vector: [0.5, 0.5], content_revision: 0 },
    { photo_id: 2, vector: [1, 0], content_revision: 0 },
    { photo_id: 3, vector: [0.9, 0.1], content_revision: 2 },
  ]);
  const filter = lancePhotoRevisionFilter("embedding");
  if (!filter) {
    throw new Error("Missing expected revision filter");
  }
  const rows = await table
    .vectorSearch([1, 0])
    .distanceType("cosine")
    .where(filter)
    .limit(2)
    .toArray();
  expect(
    currentLanceRows(rows, "embedding").map((row) => row.photo_id)
  ).toEqual([3, 1]);
  db.update(photos).set({ deletedAt: 1 }).where(eq(photos.id, 3)).run();
  expect(
    currentLanceRows(rows, "embedding").map((row) => row.photo_id)
  ).toEqual([1]);
});
