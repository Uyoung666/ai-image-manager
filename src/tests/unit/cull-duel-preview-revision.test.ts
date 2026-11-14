/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { call } from "@orpc/server";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";
import { ensureDuelPreview } from "@/ipc/cull/handlers";
import { thumbnailSourceIdentity } from "@/services/thumbnail-identity";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  generate: vi.fn(),
  strategy: vi.fn(),
  previewPath: vi.fn(
    (source: string, identity?: string) => `${source}-${identity ?? "v2"}.jpg`
  ),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/thumbnailer", () => ({
  generateDuelPreview: state.generate,
  getDuelPreviewStrategy: state.strategy,
  getDuelPreviewPath: state.previewPath,
}));

let runtime: TestRuntime;
let connections: Database.Database[];
let db: ReturnType<typeof drizzle>;
let source: string;
let generatedPath: string;

function createDatabase() {
  const sqlite = new Database(":memory:");
  connections.push(sqlite);
  const next = drizzle(sqlite);
  migrate(next, { migrationsFolder: "drizzle" });
  return next;
}

function seedPhoto(target = db) {
  const stat = fs.statSync(source);
  target
    .insert(photos)
    .values({
      id: 1,
      path: source,
      filename: "source.tif",
      format: "tiff",
      width: 4000,
      height: 3000,
      sourceStatus: "available",
      sourceSize: stat.size,
      sourceMtimeMs: stat.mtimeMs,
      sourceCtimeMs: stat.ctimeMs,
    })
    .run();
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime = new TestRuntime("cull-duel-preview-revision");
  connections = [];
  source = path.join(runtime.root, "source.tif");
  fs.writeFileSync(source, "initial source bytes");
  generatedPath = path.join(runtime.root, "generated.jpg");
  db = createDatabase();
  state.db = db;
  state.strategy.mockReturnValue("generate");
  state.generate.mockResolvedValue({
    previewPath: generatedPath,
    width: 2560,
    height: 1920,
  });
  seedPhoto();
});

afterEach(() => {
  for (const sqlite of connections) {
    sqlite.close();
  }
  expect(runtime.cleanup().status).toBe("deleted");
});

describe("cull duel preview commit protection", () => {
  it("commits a preview only for the accepted source identity", async () => {
    const identity = thumbnailSourceIdentity(fs.statSync(source));
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: generatedPath,
    });
    expect(state.generate).toHaveBeenCalledWith(source, identity);
    expect(db.select().from(photos).get()?.duelPreviewPath).toBe(generatedPath);
  });

  it.each([
    "revision",
    "path",
    "deleted",
    "source",
    "database",
  ] as const)("rejects a delayed preview after its %s changes", async (change) => {
    let finish!: (result: {
      previewPath: string;
      width: number;
      height: number;
    }) => void;
    state.generate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const pending = call(ensureDuelPreview, { photoId: 1 });
    await vi.waitFor(() => expect(state.generate).toHaveBeenCalledOnce());
    if (change === "revision") {
      db.update(photos)
        .set({ contentRevision: 1, fileRevision: 1 })
        .where(eq(photos.id, 1))
        .run();
    }
    if (change === "path") {
      db.update(photos)
        .set({ path: path.join(runtime.root, "moved.tif"), fileRevision: 1 })
        .where(eq(photos.id, 1))
        .run();
    }
    if (change === "deleted") {
      db.update(photos).set({ deletedAt: 1 }).where(eq(photos.id, 1)).run();
    }
    if (change === "source") {
      fs.writeFileSync(source, "new bytes before the watcher observes them");
    }
    if (change === "database") {
      const replacement = createDatabase();
      seedPhoto(replacement);
      state.db = replacement;
    }
    finish({ previewPath: generatedPath, width: 2560, height: 1920 });
    await expect(pending).resolves.toEqual({ duelPreviewPath: null });
    expect(db.select().from(photos).get()?.duelPreviewPath).toBeNull();
    expect(
      (state.db as typeof db).select().from(photos).get()?.duelPreviewPath
    ).toBeNull();
  });

  it("refuses an existing preview when an accepted source changed before observation", async () => {
    db.update(photos).set({ duelPreviewPath: generatedPath }).run();
    fs.writeFileSync(source, "new bytes before the watcher observes them");
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: null,
    });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("regenerates an unverified legacy preview after a source change", async () => {
    const legacy = state.previewPath(source);
    db.update(photos)
      .set({
        sourceSize: null,
        sourceMtimeMs: null,
        sourceCtimeMs: null,
        sourceStatus: "unverified",
        duelPreviewPath: legacy,
      })
      .run();
    fs.writeFileSync(
      source,
      "replacement bytes with no previous accepted fingerprint"
    );
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: generatedPath,
    });
    expect(state.generate).toHaveBeenCalledOnce();
    expect(db.select().from(photos).get()?.duelPreviewPath).toBe(generatedPath);
  });

  it("regenerates a legacy preview even after the source baseline was accepted", async () => {
    const legacy = state.previewPath(source);
    db.update(photos).set({ duelPreviewPath: legacy }).run();
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: generatedPath,
    });
    expect(state.generate).toHaveBeenCalledWith(
      source,
      thumbnailSourceIdentity(fs.statSync(source))
    );
    expect(db.select().from(photos).get()?.duelPreviewPath).toBe(generatedPath);
  });

  it("does not treat a newly accepted source baseline as proof of a legacy preview", async () => {
    db.update(photos)
      .set({ duelPreviewPath: state.previewPath(source) })
      .run();
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: generatedPath,
    });
    expect(state.generate).toHaveBeenCalledOnce();
  });

  it("keeps the historical preview available offline only while its content version remains valid", async () => {
    db.update(photos)
      .set({ sourceStatus: "offline", duelPreviewPath: generatedPath })
      .run();
    fs.unlinkSync(source);
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: generatedPath,
    });
    db.update(photos).set({ contentRevision: 1 }).run();
    await expect(call(ensureDuelPreview, { photoId: 1 })).resolves.toEqual({
      duelPreviewPath: null,
    });
    expect(state.generate).not.toHaveBeenCalled();
  });
});
