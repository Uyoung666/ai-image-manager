import fs from "node:fs/promises";
import path from "node:path";
import { type Connection, connect, type Table } from "@lancedb/lancedb";
import { Field, FixedSizeList, Float32, Int32, Schema } from "apache-arrow";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildPhotoIdFilter } from "@/services/ai/vector-db";

vi.mock("electron", () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.cwd(),
    isPackaged: false,
  },
}));

vi.mock("@/db", () => ({
  getDatabase: () => {
    throw new Error("This filter integration test does not access SQLite");
  },
}));

const INT32_MAX = 2_147_483_647;
const fixtureRoot = path.join(
  process.cwd(),
  "reports/photo-id-filter-integration"
);
const range = (start: number, size: number) =>
  Array.from({ length: size }, (_, index) => start + index);
const sorted = (ids: number[]) => [...ids].sort((left, right) => left - right);
const legacyFilter = (ids: number[]) => `photo_id IN (${ids.join(", ")})`;
let directory: string;
let connection: Connection | undefined;
let table: Table | undefined;
let fixtureIds: number[];

function requireTable(): Table {
  if (!table) {
    throw new Error("Expected an initialized native LanceDB table");
  }
  return table;
}

async function queryIds(filter?: string): Promise<number[]> {
  let query = requireTable().query().select(["photo_id"]);
  if (filter) {
    query = query.where(filter);
  }
  const rows = await query.toArray();
  return sorted(rows.map((row) => row.photo_id as number));
}

async function vectorIds(filter: string): Promise<number[]> {
  const rows = await requireTable()
    .vectorSearch([1, 0, 0])
    .distanceType("cosine")
    .where(filter)
    .bypassVectorIndex()
    .limit(fixtureIds.length)
    .select(["photo_id"])
    .toArray();
  return sorted(rows.map((row) => row.photo_id as number));
}

describe.sequential("native LanceDB photo ID interval equivalence", () => {
  beforeEach(async () => {
    await fs.mkdir(fixtureRoot, { recursive: true });
    directory = await fs.mkdtemp(path.join(fixtureRoot, "filter-"));
    connection = await connect(directory);
    table = await connection.createEmptyTable(
      "photo_embeddings",
      new Schema([
        new Field("photo_id", new Int32()),
        new Field(
          "vector",
          new FixedSizeList(3, new Field("item", new Float32()))
        ),
      ])
    );
    fixtureIds = [0, ...range(1, 66), ...range(INT32_MAX - 32, 33)];
    await table.add(
      fixtureIds.map((photoId) => ({ photo_id: photoId, vector: [1, 0, 0] }))
    );
  });

  afterEach(async () => {
    table = undefined;
    await connection?.close();
    connection = undefined;
    if (directory && path.dirname(path.resolve(directory)) === fixtureRoot) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });

  it("returns and deletes exactly the contiguous range with no neighboring IDs", async () => {
    const ids = range(17, 32);
    const filter = buildPhotoIdFilter([...ids].reverse());
    expect(filter).toBe("photo_id BETWEEN 17 AND 48");
    expect(await queryIds(filter)).toEqual(ids);
    expect(await vectorIds(filter)).toEqual(await vectorIds(legacyFilter(ids)));
    await requireTable().delete(filter);
    const deletedIds = new Set(ids);
    expect(await queryIds()).toEqual(
      fixtureIds.filter((id) => !deletedIds.has(id))
    );
  });

  it("does not admit or delete a soft-deletion hole whose vector still exists", async () => {
    const ids = range(1, 65).filter((id) => id !== 33);
    const filter = buildPhotoIdFilter(ids);
    expect(filter).toBe(legacyFilter(ids));
    expect(await queryIds(filter)).toEqual(ids);
    expect(await vectorIds(filter)).toEqual(ids);
    await requireTable().delete(filter);
    expect(await queryIds()).toEqual([0, 33, 66, ...range(INT32_MAX - 32, 33)]);
  });

  it("keeps the excluded Int32 maximum through upper-range reads and deletion", async () => {
    const ids = range(INT32_MAX - 32, 32);
    const filter = buildPhotoIdFilter([
      ...ids.reverse(),
      INT32_MAX,
      INT32_MAX + 1,
      Number.NaN,
    ]);
    expect(await queryIds(filter)).toEqual(sorted(ids));
    expect(await vectorIds(filter)).toEqual(sorted(ids));
    await requireTable().delete(filter);
    expect(await queryIds()).toEqual([0, ...range(1, 66), INT32_MAX]);
  });
});
