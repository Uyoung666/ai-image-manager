/** @vitest-environment node */
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photos, photoTags, tags } from "@/db/schema";

const state = vi.hoisted(() => ({
  db: undefined as ReturnType<typeof drizzle> | undefined,
  vectors: new Map<number, number[]>(),
}));

vi.mock("@/db", () => ({
  getDatabase: () => state.db,
}));
vi.mock("@/services/ai/model-loader", () => ({
  ensureLocalModel: vi.fn(async () => "memory-model"),
  loadModel: vi.fn(async () => undefined),
}));
vi.mock("@/services/ai/search", () => ({
  embedImageInWorker: vi.fn(),
}));
vi.mock("@/services/ai/vector-db", () => ({
  getPhotoVectors: vi.fn(async () => state.vectors),
  initVectorDB: vi.fn(async () => undefined),
}));

import { setEmbeddingModel, setLocalModelPath } from "@/services/ai/state";
import {
  _resetTagEmbeddingCacheForTest,
  batchSuggestTags,
} from "@/services/ai/tag-suggester";
import { getTagSearchRevision } from "@/services/tag-search-revision";

let sqlite: Database.Database;

function oneHot(index: number): number[] {
  const vector = Array.from({ length: 768 }, () => 0);
  vector[index] = 1;
  return vector;
}

beforeEach(() => {
  sqlite = new Database(":memory:");
  const db = drizzle(sqlite);
  state.db = db;
  migrate(db, { migrationsFolder: "drizzle" });
  db.insert(photos)
    .values({ id: 1, filename: "photo.jpg", path: "/photo.jpg" })
    .run();
  state.vectors = new Map([[1, oneHot(0)]]);
  setEmbeddingModel({
    embedImage: async () => oneHot(0),
    embedText: async () => oneHot(1),
    embedTexts: (prompts) => {
      const vectors = prompts.map((prompt) =>
        prompt.includes("an indoor room") ? oneHot(0) : oneHot(1)
      );
      return Promise.resolve(vectors);
    },
  });
  setLocalModelPath("memory-model");
  _resetTagEmbeddingCacheForTest();
});

afterEach(() => {
  setEmbeddingModel(null);
  setLocalModelPath(null);
  sqlite.close();
});

describe("batch tag refresh", () => {
  it("replaces only unconfirmed automatic tags and keeps protected tags", async () => {
    const db = state.db;
    if (!db) {
      throw new Error("Database is not initialized");
    }
    const oldAuto = db
      .insert(tags)
      .values({ name: "旧自动" })
      .returning({ id: tags.id })
      .get();
    const manual = db
      .insert(tags)
      .values({ name: "手动" })
      .returning({ id: tags.id })
      .get();
    const confirmedAuto = db
      .insert(tags)
      .values({ name: "已确认自动" })
      .returning({ id: tags.id })
      .get();
    if (!(oldAuto && manual && confirmedAuto)) {
      throw new Error("Failed to create fixture tags");
    }
    db.insert(photoTags)
      .values([
        {
          photoId: 1,
          tagId: oldAuto.id,
          confidence: 0.6,
          isConfirmed: false,
          origin: "auto",
          userConfirmed: false,
        },
        {
          photoId: 1,
          tagId: manual.id,
          confidence: null,
          isConfirmed: true,
          origin: "manual",
          userConfirmed: true,
        },
        {
          photoId: 1,
          tagId: confirmedAuto.id,
          confidence: 0.92,
          isConfirmed: true,
          origin: "auto",
          userConfirmed: true,
        },
      ])
      .run();
    const revisionBefore = getTagSearchRevision();

    await batchSuggestTags([1], undefined, "refresh");

    const rows = db
      .select({
        name: tags.name,
        origin: photoTags.origin,
        userConfirmed: photoTags.userConfirmed,
      })
      .from(photoTags)
      .innerJoin(tags, eq(photoTags.tagId, tags.id))
      .where(eq(photoTags.photoId, 1))
      .all();
    expect(rows.map((row) => row.name)).toEqual(
      expect.arrayContaining(["手动", "已确认自动", "室内"])
    );
    expect(rows.map((row) => row.name)).not.toContain("旧自动");
    expect(rows.find((row) => row.name === "室内")).toMatchObject({
      origin: "auto",
      userConfirmed: false,
    });
    expect(getTagSearchRevision()).toBeGreaterThan(revisionBefore);
  });

  it("keeps old automatic tags when the vector is missing or invalid", async () => {
    const db = state.db;
    if (!db) {
      throw new Error("Database is not initialized");
    }
    const oldAuto = db
      .insert(tags)
      .values({ name: "待保留自动" })
      .returning({ id: tags.id })
      .get();
    if (!oldAuto) {
      throw new Error("Failed to create fixture tag");
    }
    db.insert(photoTags)
      .values({
        photoId: 1,
        tagId: oldAuto.id,
        confidence: 0.6,
        isConfirmed: false,
        origin: "auto",
        userConfirmed: false,
      })
      .run();

    state.vectors = new Map();
    await batchSuggestTags([1], undefined, "refresh");
    expect(
      db
        .select({ name: tags.name })
        .from(photoTags)
        .innerJoin(tags, eq(photoTags.tagId, tags.id))
        .where(eq(photoTags.photoId, 1))
        .all()
    ).toEqual([{ name: "待保留自动" }]);

    state.vectors = new Map([[1, [1, 2]]]);
    await batchSuggestTags([1], undefined, "refresh");
    expect(
      db
        .select({ name: tags.name })
        .from(photoTags)
        .innerJoin(tags, eq(photoTags.tagId, tags.id))
        .where(eq(photoTags.photoId, 1))
        .all()
    ).toEqual([{ name: "待保留自动" }]);
  });

  it("rolls back a failed association write and keeps old automatic tags", async () => {
    const db = state.db;
    if (!db) {
      throw new Error("Database is not initialized");
    }
    const oldAuto = db
      .insert(tags)
      .values({ name: "写入失败旧自动" })
      .returning({ id: tags.id })
      .get();
    if (!oldAuto) {
      throw new Error("Failed to create fixture tag");
    }
    db.insert(photoTags)
      .values({
        photoId: 1,
        tagId: oldAuto.id,
        confidence: 0.6,
        isConfirmed: false,
        origin: "auto",
        userConfirmed: false,
      })
      .run();
    const transactionSpy = vi
      .spyOn(db, "transaction")
      .mockImplementation(() => {
        throw new Error("simulated association write failure");
      });

    const result = await batchSuggestTags([1], undefined, "refresh");

    transactionSpy.mockRestore();
    expect(result).toEqual({ tagged: 0, skipped: 1 });
    expect(
      db
        .select({ name: tags.name })
        .from(photoTags)
        .innerJoin(tags, eq(photoTags.tagId, tags.id))
        .where(eq(photoTags.photoId, 1))
        .all()
    ).toEqual([{ name: "写入失败旧自动" }]);
  });
});
