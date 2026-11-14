/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import {
  embedAllPhotos,
  ignoreActiveEmbeddingFailure,
} from "@/services/ai/embedder";
import { resetEmbeddingRefreshRetry } from "@/services/ai/embedding-refresh-retries";
import {
  currentProgress,
  setAiControlState,
  setLocalModelPath,
  setPhotoTable,
} from "@/services/ai/state";
import type { embedWithPool } from "@/services/embed-worker-pool";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const fixture = vi.hoisted(() => ({
  db: undefined as unknown,
  embed: vi.fn<typeof embedWithPool>(),
  table: {
    add: vi.fn().mockResolvedValue(undefined),
    countRows: vi.fn().mockResolvedValue(0),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/db", () => ({ getDatabase: () => fixture.db }));
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateStatsCache: vi.fn(),
}));
vi.mock("@/services/ai-failure-diagnostics", () => ({
  recordAiFailure: vi.fn(),
}));
vi.mock("@/services/ai/model-loader", () => ({
  ensureLocalModel: async () => "mock-model",
}));
vi.mock("@/services/ai/tag-suggester", () => ({
  batchSuggestTags: async () => ({ tagged: 0 }),
}));
vi.mock("@/services/ai/vector-db", () => ({
  buildPhotoIdFilter: () => "mock vector filter",
  deletePhotoVectors: vi.fn().mockResolvedValue(undefined),
  ensureVectorIndex: vi.fn().mockResolvedValue(true),
  initVectorDB: vi.fn().mockResolvedValue(undefined),
  persistActiveVectorFingerprint: vi.fn().mockResolvedValue(undefined),
  withVectorDbOperation: <T>(operation: () => Promise<T>) => operation(),
}));
vi.mock("@/services/embed-worker-pool", () => ({
  embedWithPool: fixture.embed,
  getPoolInitProgress: () => 100,
  initWorkerPool: vi.fn().mockResolvedValue(undefined),
  isEmbeddingProviderError: () => false,
  shutdownPool: vi.fn(),
}));
vi.mock("@/services/library-change", () => ({ notifyLibraryChange: vi.fn() }));
vi.mock("@/services/search-revision", () => ({
  invalidateVectorSearch: vi.fn(),
}));
vi.mock("@/services/settings-manager", () => ({ getSetting: () => null }));

let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let runtime: TestRuntime;

beforeEach(async () => {
  vi.clearAllMocks();
  fixture.embed.mockReset();
  setAiControlState("idle");
  setPhotoTable(
    fixture.table as unknown as Parameters<typeof setPhotoTable>[0]
  );
  runtime = new TestRuntime("ai-embedding-refresh-outcome");
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  fixture.db = db;
  const rows = await Promise.all(
    [1, 2, 3, 4].map(async (id) => {
      const filename = `${id}.jpg`;
      const source = path.join(runtime.root, filename);
      await fs.writeFile(source, "simulated worker input");
      return { id, path: source, filename };
    })
  );
  db.insert(photos).values(rows).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  setPhotoTable(null);
  setLocalModelPath(null);
  sqlite.close();
  runtime.cleanup();
});

function photo(id: number) {
  return db.select().from(photos).where(eq(photos.id, id)).get();
}

function reportBatch(
  results: Awaited<ReturnType<typeof embedWithPool>>,
  duringRun?: () => void
) {
  fixture.embed.mockImplementationOnce(
    async (inputs, _progress, _stop, persist) => {
      duringRun?.();
      await persist?.(results, inputs);
      return results;
    }
  );
}

const decodeFailure = {
  id: 1,
  error: "decode",
  errorCode: "IMAGE_DECODE_FAILED",
};
const inferenceFailure = {
  id: 2,
  error: "inference",
  errorCode: "IMAGE_INFERENCE_FAILED",
};

it("records typed photo failures without spending the budget on pool or model errors", async () => {
  vi.spyOn(Date, "now").mockReturnValue(10_000);
  reportBatch([
    decodeFailure,
    inferenceFailure,
    { id: 3, error: "model unavailable", errorCode: "MODEL_NOT_INITIALIZED" },
    { id: 4, error: "worker disconnected" },
  ]);
  const onCompleted = vi.fn();
  await expect(embedAllPhotos(undefined, { onCompleted })).resolves.toBe(0);
  for (const id of [1, 2]) {
    expect(photo(id)).toMatchObject({
      embeddingRefreshAttempts: 1,
      embeddingRefreshFileRevision: 0,
      embeddingRefreshRetryAt: 12_000,
      isAiProcessed: false,
    });
  }
  for (const id of [3, 4]) {
    expect(photo(id)).toMatchObject(resetEmbeddingRefreshRetry);
  }
  expect(onCompleted).toHaveBeenCalledExactlyOnceWith(12_000);
});

it("does not refill the failure budget when a same-version retry overtakes the active run", async () => {
  reportBatch([decodeFailure, inferenceFailure], () => {
    db.update(photos)
      .set(resetEmbeddingRefreshRetry)
      .where(eq(photos.id, 1))
      .run();
    ignoreActiveEmbeddingFailure(1);
  });
  await embedAllPhotos();
  expect(photo(1)).toMatchObject(resetEmbeddingRefreshRetry);
  expect(photo(2)?.embeddingRefreshAttempts).toBe(1);

  reportBatch([decodeFailure]);
  await embedAllPhotos();
  expect(photo(1)?.embeddingRefreshAttempts).toBe(1);
});

it("does not spend a failure attempt when the run pauses before settling", async () => {
  reportBatch([decodeFailure], () => setAiControlState("pausing"));
  await embedAllPhotos();
  expect(photo(1)).toMatchObject(resetEmbeddingRefreshRetry);
});

it("discards superseded results without marking the run as a global failure", async () => {
  reportBatch([{ id: 1, vector: [1, 0] }], () => {
    db.update(photos).set({ fileRevision: 1 }).where(eq(photos.id, 1)).run();
  });
  const onCompleted = vi.fn();
  await expect(
    embedAllPhotos(undefined, {
      excludePhotoIds: new Set([2, 3, 4]),
      onCompleted,
    })
  ).resolves.toBe(0);
  expect(photo(1)?.isAiProcessed).toBe(false);
  expect(fixture.table.add).not.toHaveBeenCalled();
  expect(onCompleted).toHaveBeenCalledOnce();
  expect(currentProgress.phase).toBe("idle");
});

it("clears a previous failure when the current content vector is committed", async () => {
  db.update(photos)
    .set({
      contentRevision: 5,
      fileRevision: 7,
      metadataRevision: 5,
      embeddingRefreshAttempts: 4,
      embeddingRefreshFileRevision: 7,
    })
    .where(eq(photos.id, 1))
    .run();
  reportBatch([{ id: 1, vector: [1, 0] }]);
  await expect(
    embedAllPhotos(undefined, { excludePhotoIds: new Set([2, 3, 4]) })
  ).resolves.toBe(1);
  expect(fixture.table.add).toHaveBeenCalledWith([
    expect.objectContaining({ photo_id: 1, content_revision: 5 }),
  ]);
  expect(photo(1)).toMatchObject({
    ...resetEmbeddingRefreshRetry,
    embeddingRevision: 5,
    isAiProcessed: true,
  });
});
