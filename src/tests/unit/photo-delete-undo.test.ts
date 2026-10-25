/** @vitest-environment node */
import path from "node:path";
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { deletePhotos, restorePhotos } from "@/ipc/photos/handlers/mutations";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateStatsCache: vi.fn(),
  invalidateIndexStatsCache: vi.fn(),
}));
vi.mock("@/services/ai-embedder", () => ({ deletePhotoVectors: vi.fn() }));
vi.mock("@/services/photo-sequences", () => ({
  cleanupDeletedPhotoSequenceMembers: vi.fn(),
  notifySequencesChanged: vi.fn(),
}));
vi.mock("@/services/smart-album-engine", () => ({
  invalidateSmartAlbumCache: vi.fn(),
}));
vi.mock("@/services/thumbnailer", () => ({}));
let sqlite: Database.Database;
const operationId = "cbd27849-44ce-4eca-a592-561a0bfecad8";
beforeEach(() => {
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  sqlite.exec(
    "INSERT INTO folders(id,path,display_name,photo_count,created_at) VALUES(1,'fixture','fixture',2,1)"
  );
  const insert = sqlite.prepare(
    "INSERT INTO photos(id,path,filename,folder_id,created_at) VALUES(?,?,?,1,1)"
  );
  insert.run(1, path.resolve("package.json"), "a");
  insert.run(2, path.resolve("tsconfig.json"), "b");
});
afterEach(() => sqlite.close());
it("returns exact deleted IDs and restores their folder counts once", async () => {
  const result = await call(deletePhotos, { ids: [1, 2, 999], operationId });
  expect(result).toEqual({
    deleted: 2,
    succeededIds: [1, 2],
    deletionBatchId: operationId,
  });
  expect((await call(deletePhotos, { ids: [1], operationId })).deleted).toBe(0);
  expect(sqlite.prepare("SELECT photo_count FROM folders").get()).toEqual({
    photo_count: 0,
  });
  expect(
    (
      await call(restorePhotos, {
        ids: result.succeededIds,
        expectedDeletionBatchId: operationId,
      })
    ).succeededIds
  ).toEqual([1, 2]);
  expect(sqlite.prepare("SELECT photo_count FROM folders").get()).toEqual({
    photo_count: 2,
  });
});
it("does not restore a photo deleted by a later operation", async () => {
  await call(deletePhotos, { ids: [1], operationId });
  await call(restorePhotos, { ids: [1] });
  await call(deletePhotos, {
    ids: [1],
    operationId: "faf9321d-22c2-49d9-b464-d4c4c283b1f3",
  });
  const restored = await call(restorePhotos, {
    ids: [1],
    expectedDeletionBatchId: operationId,
  });
  expect(restored.succeededIds).toEqual([]);
  expect(restored.failed).toHaveLength(1);
  expect(sqlite.prepare("SELECT photo_count FROM folders").get()).toEqual({
    photo_count: 1,
  });
});
it("keeps the existing missing-original failure path", async () => {
  sqlite.exec(
    "UPDATE photos SET path='X:/missing-original-undo-fixture.jpg' WHERE id=2"
  );
  await call(deletePhotos, { ids: [2], operationId });
  const restored = await call(restorePhotos, {
    ids: [2],
    expectedDeletionBatchId: operationId,
  });
  expect(restored.succeededIds).toEqual([]);
  expect(restored.failed[0].code).toBe("SOURCE_MISSING");
});
