/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  albumPhotos,
  albums,
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  libraryRefreshJobs,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  hash: vi.fn(),
  prepare: vi.fn(),
  publish: vi.fn(),
  retryAi: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/library-moves", () => ({ hashLibraryFile: state.hash }));
vi.mock("@/services/library-change", () => ({
  notifyLibraryChange: state.publish,
}));
vi.mock("@/services/indexer", () => ({ preparePhotoRecord: state.prepare }));
vi.mock("@/services/import-queue", () => ({ isImportQueueBusy: () => false }));
vi.mock("@/services/thumbnailer", () => ({ deleteDuelPreview: vi.fn() }));
vi.mock("@/services/advanced-exif", () => ({
  scheduleAdvancedExifEnrichment: vi.fn(),
}));
vi.mock("@/services/ai-index-scheduler", () => ({
  requestAutoIndex: vi.fn(),
  requestAutoIndexPhotoRetry: state.retryAi,
}));

import {
  currentLanceRows,
  photoWorkVersionMatch,
} from "@/services/ai/photo-version";
import { FULL_FILE_HASH_VERSION } from "@/services/file-hash";
import {
  observeLibraryPhoto,
  retryLibraryPhotoRefresh,
  startLibraryContentRefresh,
  stopLibraryContentRefresh,
} from "@/services/library-content-refresh";
import { reconcileLibrarySources } from "@/services/library-source";

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;

beforeEach(async () => {
  vi.clearAllMocks();
  runtime = new TestRuntime("library-content-refresh");
  source = path.join(runtime.root, "original.jpg");
  await fs.writeFile(source, "original");
  sqlite = new Database(":memory:");
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  const stat = await fs.stat(source);
  db.insert(photos)
    .values({
      id: 1,
      path: source,
      filename: "original.jpg",
      sourceStatus: "available",
      isAiProcessed: true,
      isFaceProcessed: true,
      isFavorite: true,
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
      sourceHash: "old-hash",
      sourceHashVersion: FULL_FILE_HASH_VERSION,
      sourceHashFileRevision: 0,
    })
    .run();
  state.hash.mockResolvedValue("new-hash");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await stopLibraryContentRefresh();
  sqlite.close();
  runtime.cleanup();
});

describe("library content revisions", () => {
  it("compiles one live photo reader per database without caching photo state", async () => {
    const prepare = vi.spyOn(sqlite, "prepare");
    const observation = await fs.stat(source);
    for (let index = 0; index < 20; index++) {
      await observeLibraryPhoto(1, source, {
        verifiedObservation: observation,
      });
    }
    db.update(photos)
      .set({ sourceStatus: "missing" })
      .where(eq(photos.id, 1))
      .run();
    await observeLibraryPhoto(1, source, { force: true });
    expect(state.hash).not.toHaveBeenCalled();
    db.update(photos)
      .set({ sourceStatus: "available" })
      .where(eq(photos.id, 1))
      .run();
    expect(await observeLibraryPhoto(1, source, { force: true })).toBe(true);
    expect(state.hash).toHaveBeenCalledOnce();
    const photoReads = prepare.mock.calls.filter(
      ([query]) =>
        query.startsWith("select ") &&
        query.includes('from "photos"') &&
        query.includes('"source_hash_version"')
    );
    expect(photoReads).toHaveLength(1);
    expect(
      sqlite.prepare("SELECT content_revision FROM photos WHERE id=1").get()
    ).toEqual({ content_revision: 1 });
  });

  it("binds prepared photo reads to the current database when IDs overlap", async () => {
    await observeLibraryPhoto(1, source);
    const initial = db.select().from(photos).where(eq(photos.id, 1)).get();
    if (!initial) {
      throw new Error("Missing source fixture");
    }
    const secondSqlite = new Database(":memory:");
    const second = drizzle(secondSqlite);
    try {
      migrate(second, { migrationsFolder: "drizzle" });
      second
        .insert(photos)
        .values({ ...initial, sourceStatus: "missing" })
        .run();
      state.db = second;
      await observeLibraryPhoto(1, source, { force: true });
      expect(state.hash).not.toHaveBeenCalled();
      second
        .update(photos)
        .set({ sourceStatus: "available" })
        .where(eq(photos.id, 1))
        .run();
      expect(await observeLibraryPhoto(1, source, { force: true })).toBe(true);
      expect(
        secondSqlite
          .prepare("SELECT content_revision FROM photos WHERE id=1")
          .get()
      ).toEqual({ content_revision: 1 });
      expect(
        sqlite.prepare("SELECT content_revision FROM photos WHERE id=1").get()
      ).toEqual({ content_revision: 0 });
    } finally {
      state.db = db;
      secondSqlite.close();
    }
  });

  it("reuses the verified scan stat for an unchanged photo only", async () => {
    const stat = vi.spyOn(fs, "stat");
    const sourceStatCount = () =>
      stat.mock.calls.filter(([filePath]) => filePath === source).length;
    const reconcile = (force = false) =>
      reconcileLibrarySources({
        photoIds: [1],
        onAvailable: ({ id, path: filePath }, verifiedObservation) =>
          observeLibraryPhoto(id, filePath, { force, verifiedObservation }),
      });

    expect(await reconcile()).toMatchObject({ available: 1 });
    expect(sourceStatCount()).toBe(1);
    expect(state.hash).not.toHaveBeenCalled();

    stat.mockClear();
    state.hash.mockResolvedValueOnce("old-hash");
    await reconcile(true);
    expect(sourceStatCount()).toBe(3);
    expect(state.hash).toHaveBeenCalledExactlyOnceWith(source);

    stat.mockClear();
    state.hash.mockClear();
    await fs.writeFile(source, "replacement bytes");
    await reconcile();
    expect(sourceStatCount()).toBe(3);
    expect(state.hash).toHaveBeenCalledExactlyOnceWith(source);
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 1,
    });

    stat.mockClear();
    state.hash.mockClear();
    db.update(photos).set({ sourceSize: null }).run();
    await reconcile();
    expect(sourceStatCount()).toBe(2);
    expect(state.hash).not.toHaveBeenCalled();
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 1,
      sourceSize: Buffer.byteLength("replacement bytes"),
    });
  });

  it("persists face refresh for previously processed photos including zero-face scans", async () => {
    db.update(photos)
      .set({ faceRefreshAttempts: 4, faceRefreshRetryAt: 12_345 })
      .run();
    await fs.writeFile(source, "replacement");
    await observeLibraryPhoto(1, source);
    expect(db.select().from(photos).get()).toMatchObject({
      faceRefreshPending: true,
      isFaceProcessed: false,
      faceRefreshAttempts: 0,
      faceRefreshRetryAt: 0,
    });
  });
  it("resets exhausted face and embedding retries when the user retries unchanged content", async () => {
    state.hash.mockResolvedValue("old-hash");
    db.update(photos)
      .set({
        faceRefreshPending: true,
        isFaceProcessed: false,
        faceRefreshAttempts: 4,
        faceRefreshRetryAt: 12_345,
        faceProcessingError: "failed",
        isAiProcessed: false,
        embeddingRefreshAttempts: 4,
        embeddingRefreshRetryAt: 12_345,
        embeddingRefreshFileRevision: 0,
      })
      .run();
    expect(await retryLibraryPhotoRefresh(1)).toBe(true);
    expect(state.retryAi).toHaveBeenCalledWith(1);
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 0,
      faceRefreshPending: true,
      faceRefreshAttempts: 0,
      faceRefreshRetryAt: 0,
      faceProcessingError: null,
      embeddingRefreshAttempts: 0,
      embeddingRefreshRetryAt: 0,
      embeddingRefreshFileRevision: null,
    });
  });
  it("keeps pending face history eligible after another content replacement", async () => {
    db.update(photos)
      .set({
        isFaceProcessed: false,
        faceRefreshPending: true,
        faceRefreshAttempts: 4,
        faceRefreshRetryAt: 12_345,
      })
      .run();
    await fs.writeFile(source, "another replacement");
    expect(await observeLibraryPhoto(1, source)).toBe(true);
    expect(db.select().from(photos).get()).toMatchObject({
      fileRevision: 1,
      contentRevision: 1,
      isFaceProcessed: false,
      faceRefreshPending: true,
      faceRefreshAttempts: 0,
      faceRefreshRetryAt: 0,
    });
  });
  it("preserves human relationships and invalidates stale vectors when bytes change", async () => {
    db.update(photos)
      .set({ thumbnailPath: "previous.webp", thumbnailSize: "42x42" })
      .run();
    const inserted = db
      .insert(tags)
      .values([
        { name: "manual" },
        { name: "automatic" },
        { name: "confirmed" },
      ])
      .returning()
      .all();
    db.insert(photoTags)
      .values(
        inserted.map((tag, index) => ({
          photoId: 1,
          tagId: tag.id,
          origin: index === 0 ? ("manual" as const) : ("auto" as const),
          userConfirmed: index === 2,
        }))
      )
      .run();
    const album = db.insert(albums).values({ name: "kept" }).returning().get();
    if (!album) {
      throw new Error("Album fixture not created");
    }
    db.insert(albumPhotos).values({ albumId: album.id, photoId: 1 }).run();
    const face = db
      .insert(faceVectors)
      .values({
        photoId: 1,
        bboxX: 0,
        bboxY: 0,
        bboxWidth: 1,
        bboxHeight: 1,
      })
      .returning()
      .get();
    const identity = db
      .insert(faceIdentities)
      .values({ name: "person", isConfirmed: true })
      .returning()
      .get();
    if (!(identity && face)) {
      throw new Error("Face fixture not created");
    }
    db.insert(faceIdentityMembers)
      .values({ identityId: identity.id, faceVectorId: face.id })
      .run();
    await fs.writeFile(source, "changed-image");

    expect(await observeLibraryPhoto(1, source)).toBe(true);
    expect(db.select().from(photos).get()).toMatchObject({
      id: 1,
      isFavorite: true,
      contentRevision: 1,
      fileRevision: 1,
      isAiProcessed: false,
      isFaceProcessed: false,
      refreshStatus: "pending",
      thumbnailPath: null,
      thumbnailSize: null,
    });
    expect(
      db
        .select()
        .from(photoTags)
        .all()
        .map((row) => row.tagId)
    ).toEqual([inserted[0].id, inserted[2].id]);
    expect(db.select().from(albumPhotos).all()).toHaveLength(1);
    expect(db.select().from(faceIdentityMembers).all()).toHaveLength(1);
    expect(db.select().from(libraryRefreshJobs).get()).toMatchObject({
      photoId: 1,
      contentRevision: 1,
    });
    expect(
      currentLanceRows([{ photo_id: 1, content_revision: 0 }], "embedding")
    ).toEqual([]);
  });

  it("preserves accepted content revision when timestamps change but full hash matches", async () => {
    state.hash.mockResolvedValue("old-hash");
    await fs.utimes(source, new Date(), new Date(Date.now() + 5000));
    expect(await observeLibraryPhoto(1, source)).toBe(false);
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 0,
      fileRevision: 1,
      isAiProcessed: true,
      sourceHashFileRevision: 1,
    });
    expect(db.select().from(libraryRefreshJobs).all()).toEqual([]);
  });

  it("discards an observation when the path changes while hashing", async () => {
    await fs.writeFile(source, "changed");
    state.hash.mockImplementation(() => {
      db.update(photos)
        .set({
          path: path.join(runtime.root, "relocated.jpg"),
          fileRevision: 1,
        })
        .where(eq(photos.id, 1))
        .run();
      return Promise.resolve("new-hash");
    });
    expect(await observeLibraryPhoto(1, source)).toBe(false);
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 0,
      isAiProcessed: true,
    });
    expect(db.select().from(libraryRefreshJobs).all()).toEqual([]);
  });

  it("rejects an old worker version while allowing valid offline vectors", () => {
    const snapshot = {
      id: 1,
      path: source,
      fileRevision: 0,
      contentRevision: 0,
    };
    db.update(photos)
      .set({ sourceStatus: "offline" })
      .where(eq(photos.id, 1))
      .run();
    expect(
      db.select().from(photos).where(photoWorkVersionMatch(snapshot)).get()
    ).toBeUndefined();
    expect(
      currentLanceRows([{ photo_id: 1, content_revision: 0 }], "embedding")
    ).toHaveLength(1);
    db.update(photos).set({ contentRevision: 1 }).where(eq(photos.id, 1)).run();
    expect(
      currentLanceRows([{ photo_id: 1, content_revision: 0 }], "embedding")
    ).toEqual([]);
  });

  it("does not commit delayed metadata after the source version changes", async () => {
    await fs.writeFile(source, "changed");
    await observeLibraryPhoto(1, source);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    state.prepare.mockImplementation(async () => {
      await pending;
      return {
        photoRecord: { filename: "original.jpg", width: 999, height: 999 },
        exifRecord: null,
      };
    });
    startLibraryContentRefresh();
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalled());
    db.update(photos)
      .set({ fileRevision: 2, contentRevision: 2 })
      .where(eq(photos.id, 1))
      .run();
    release();
    await vi.waitFor(() => expect(state.publish).toHaveBeenCalled());
    await stopLibraryContentRefresh();
    expect(db.select().from(photos).get()).toMatchObject({
      contentRevision: 2,
      metadataRevision: 0,
      refreshStatus: "pending",
    });
    expect(db.select().from(photos).get()?.width).not.toBe(999);
  });
});
