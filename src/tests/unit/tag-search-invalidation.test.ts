// @vitest-environment node
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos, photoTags, tags } from "@/db/schema";

const state = vi.hoisted(() => ({ db: undefined as unknown, search: vi.fn() }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/ai-embedder", () => ({
  isAiSearchReady: () => true,
  searchByTextWithPlan: state.search,
}));
vi.mock("@/services/ai/health", () => ({
  getAiReadiness: async () => ({
    coverageState: "ready",
    totalPhotos: 4,
    indexedPhotos: 0,
  }),
}));
vi.mock("@/services/ai/search-sensitivity", () => ({
  getActiveSearchSensitivity: () => "standard",
  getSensitivityMultiplier: () => 1,
}));
vi.mock("@/services/image-search-preview", () => ({}));

let sqlite: Database.Database;
beforeEach(() => {
  vi.resetModules();
  state.search.mockReset().mockResolvedValue({
    results: [],
    plan: {
      translationMode: "none",
      language: "en",
      prompts: [],
      intent: "unknown",
    },
  });
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(tags).values({ id: 1, name: "FSevenMarker" }).run();
  for (let id = 1; id <= 4; id++) {
    db.insert(photos)
      .values({
        id,
        filename: `photo-${id}.jpg`,
        path: `/fixture/${id}.jpg`,
        fileDate: id,
      })
      .run();
    if (id < 4) {
      db.insert(photoTags)
        .values({
          photoId: id,
          tagId: 1,
          origin: "manual",
          userConfirmed: true,
          isConfirmed: true,
        })
        .run();
    }
  }
});
afterEach(() => sqlite.close());

it("expires cursors created by an in-flight request after a tag deletion", async () => {
  let release!: (value: unknown) => void;
  state.search.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  const { searchCompound } = await import("@/ipc/photos/handlers/search");
  const { deleteTag } = await import("@/ipc/photos/handlers/tags");
  const pending = call(searchCompound, { query: "FSevenMarker", limit: 1 });
  await vi.waitFor(() => expect(state.search).toHaveBeenCalledTimes(1));
  await call(deleteTag, { id: 1 });
  release({
    results: [],
    plan: {
      translationMode: "none",
      language: "en",
      prompts: [],
      intent: "unknown",
    },
  });
  const old = await pending;
  const cursor = "nextCursor" in old ? old.nextCursor : null;
  expect(cursor).toBeTruthy();
  expect(
    await call(searchCompound, {
      query: "FSevenMarker",
      limit: 1,
      cursor: cursor as string,
    })
  ).toMatchObject({ cursorExpired: true, results: [] });
  expect(
    (await call(searchCompound, { query: "FSevenMarker" })).results
  ).toEqual([]);
});

it("rejects pre-mutation cursors and returns only the current tag members", async () => {
  const { searchCompound } = await import("@/ipc/photos/handlers/search");
  const { removePhotoTag } = await import("@/ipc/photos/handlers/tags");
  const first = await call(searchCompound, { query: "FSevenMarker", limit: 1 });
  expect(first.results).toHaveLength(1);
  const cursor = "nextCursor" in first ? first.nextCursor : null;
  expect(cursor).toBeTruthy();
  const emitted = (first.results[0] as { id: number }).id;
  const removed = [1, 2, 3].find((id) => id !== emitted) as number;
  await call(removePhotoTag, { photoId: removed, tagId: 1 });
  expect(
    sqlite.prepare("select * from photo_tags where photo_id=?").all(removed)
  ).toEqual([]);
  const stale = await call(searchCompound, {
    query: "FSevenMarker",
    limit: 1,
    cursor: cursor as string,
  });
  expect(stale).toMatchObject({ cursorExpired: true, results: [] });
  const fresh = await call(searchCompound, {
    query: "FSevenMarker",
    limit: 100,
  });
  expect(fresh.results.map((row) => (row as { id: number }).id).sort()).toEqual(
    [1, 2, 3].filter((id) => id !== removed)
  );
  vi.resetModules();
  const restarted = await import("@/ipc/photos/handlers/search");
  const afterRestart = await call(restarted.searchCompound, {
    query: "FSevenMarker",
    limit: 100,
  });
  expect(
    afterRestart.results.map((row) => (row as { id: number }).id).sort()
  ).toEqual([1, 2, 3].filter((id) => id !== removed));
});
