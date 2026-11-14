/** @vitest-environment node */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import type { VectorCompatibility } from "@/services/ai/model-fingerprint";

const fixture = vi.hoisted(() => {
  const active = {
    adapterId: "test-siglip",
    dimensions: 768,
    fingerprint: "a".repeat(64),
  };
  return {
    active,
    runtime: {
      ...active,
      vectorCompatibility: "matching" as string,
      vectorBuildState: "ready" as string,
    },
    init: vi.fn(),
    load: vi.fn(),
    count: vi.fn(),
    db: undefined as unknown,
  };
});
vi.mock("@/db", () => ({ getDatabase: () => fixture.db }));
vi.mock("@/services/ai/model-config", () => ({
  getActiveEmbeddingRuntimeInfo: () => fixture.active,
}));
vi.mock("@/services/ai/model-loader", () => ({ loadModel: fixture.load }));
vi.mock("@/services/ai/vector-db", () => ({
  initVectorDB: fixture.init,
  withVectorDbOperation: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/services/ai/translation-worker-client", () => ({
  getTranslationState: () => "ready",
}));
vi.mock("@/services/ai/state", () => ({
  currentProgress: { phase: "idle", processed: 0, total: 8 },
  embeddingModel: null,
  getActiveEmbeddingRuntime: () => fixture.runtime,
  isEmbedding: false,
  isModelLoaded: false,
  photoTable: { countRows: fixture.count, listIndices: async () => [] },
  setPhotoTable: vi.fn(),
  setVectordb: vi.fn(),
  vectordb: null,
}));

import { getAiReadiness } from "@/services/ai/health";

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  vi.clearAllMocks();
  fixture.runtime = {
    ...fixture.active,
    vectorCompatibility: "matching",
    vectorBuildState: "ready",
  };
  fixture.init.mockResolvedValue(undefined);
  fixture.count.mockResolvedValue(8);
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  fixture.db = db;
  db.insert(photos)
    .values(
      Array.from({ length: 8 }, (_, index) => ({
        id: index + 1,
        path: `${index}.jpg`,
        filename: `${index}.jpg`,
        isAiProcessed: true,
      }))
    )
    .run();
});
afterEach(() => sqlite.close());

describe("AI readiness for index migration", () => {
  it.each<VectorCompatibility>([
    "fingerprint-mismatch",
    "missing-fingerprint",
    "invalid-fingerprint",
    "dimension-mismatch",
  ])("preserves the incompatibility error and requires rebuilding: %s", async (compatibility) => {
    fixture.runtime.vectorCompatibility = compatibility;
    fixture.init.mockRejectedValue(
      new Error(`Vector store incompatible: ${compatibility}`)
    );
    const readiness = await getAiReadiness({ loadModel: false });
    expect(readiness).toMatchObject({
      coverageState: "error",
      lastError: `Vector store incompatible: ${compatibility}`,
      rebuildRequired: true,
      vectorCompatibility: compatibility,
      vectorDB: "error",
    });
    expect(fixture.load).not.toHaveBeenCalled();
  });

  it("keeps a same-fingerprint build resumable and partial without requesting reset", async () => {
    fixture.runtime.vectorBuildState = "building";
    const readiness = await getAiReadiness({ loadModel: false });
    expect(readiness).toMatchObject({
      coverageState: "partial",
      indexedPhotos: 8,
      rebuildRequired: false,
      vectorBuildState: "building",
      vectorCompatibility: "matching",
    });
  });

  it("does not request reset for compatible partial coverage", async () => {
    fixture.count.mockResolvedValue(3);
    expect(await getAiReadiness({ loadModel: false })).toMatchObject({
      coverageState: "partial",
      indexedPhotos: 3,
      rebuildRequired: false,
    });
  });

  it("preserves a general database failure without incorrectly requiring a rebuild", async () => {
    fixture.init.mockRejectedValue(new Error("Permission denied"));
    expect(await getAiReadiness({ loadModel: false })).toMatchObject({
      lastError: "Permission denied",
      rebuildRequired: false,
      vectorDB: "error",
    });
  });
});

it("counts current committed vectors across SQLite and LanceDB, including offline legacy photos", async () => {
  // Exercise the generated Lance predicate over scalar fixture rows.
  sqlite.exec(`CREATE TABLE vectors (photo_id INTEGER, content_revision INTEGER);
    INSERT INTO vectors VALUES (1, 0), (2, 0), (3, 0);`);
  fixture.count.mockImplementation(
    async (filter?: string) =>
      (
        sqlite
          .prepare(
            `SELECT count(*) AS count FROM vectors WHERE ${filter ?? "true"}`
          )
          .get() as { count: number }
      ).count
  );
  db.delete(photos).run();
  db.insert(photos)
    .values([
      {
        id: 1,
        path: "offline.jpg",
        filename: "offline.jpg",
        sourceStatus: "offline",
        isAiProcessed: true,
      },
      {
        id: 2,
        path: "changed.jpg",
        filename: "changed.jpg",
        contentRevision: 1,
      },
      {
        id: 3,
        path: "trashed.jpg",
        filename: "trashed.jpg",
        deletedAt: 123,
        isAiProcessed: true,
      },
      {
        id: 4,
        path: "missing-vector.jpg",
        filename: "missing-vector.jpg",
        isAiProcessed: true,
      },
    ])
    .run();
  const readiness = () => getAiReadiness({ loadModel: false });
  expect(await readiness()).toMatchObject({
    coverageState: "partial",
    totalPhotos: 3,
    indexedPhotos: 1,
    pendingPhotos: 2,
  });
  sqlite.exec("INSERT INTO vectors VALUES (2, 1)");
  expect(await readiness()).toMatchObject({
    indexedPhotos: 1,
    pendingPhotos: 2,
  });
  db.update(photos)
    .set({ isAiProcessed: true, embeddingRevision: 1 })
    .where(eq(photos.id, 2))
    .run();
  expect(await readiness()).toMatchObject({
    indexedPhotos: 2,
    pendingPhotos: 1,
  });
  sqlite.exec("INSERT INTO vectors VALUES (4, 0)");
  expect(await readiness()).toMatchObject({
    coverageState: "ready",
    indexedPhotos: 3,
    pendingPhotos: 0,
  });
  db.update(photos).set({ contentRevision: 2 }).where(eq(photos.id, 2)).run();
  db.update(photos).set({ contentRevision: 1 }).where(eq(photos.id, 1)).run();
  db.update(photos).set({ contentRevision: 1 }).where(eq(photos.id, 4)).run();
  expect(await readiness()).toMatchObject({
    coverageState: "unavailable",
    indexedPhotos: 0,
    pendingPhotos: 3,
    hasVectors: false,
    indexReady: false,
  });
});
