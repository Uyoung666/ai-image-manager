/** @vitest-environment node */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase, getDbPath } from "@/db";
import {
  folders,
  photos,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import {
  createShootingProject,
  inspectShootingProjectSource,
  listShootingProjects,
  openShootingProject,
} from "@/services/shooting-projects";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ dataPath: "" }));
const PROJECT_ID_PATTERN = /^[a-f0-9-]{36}$/;
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));

// Loading any of these services would give project preparation a path back to
// the library's scanner, persistent import queue, or AI workers.
vi.mock("@/services/import-queue", () => {
  throw new Error("Shooting projects must not import the library queue");
});
vi.mock("@/services/indexer", () => {
  throw new Error("Shooting projects must not import the library indexer");
});
vi.mock("@/services/ai-embedder", () => {
  throw new Error("Shooting projects must not import AI embedding");
});

let runtime: TestRuntime;
let sourceRoot: string;

beforeEach(() => {
  runtime = new TestRuntime("shooting-projects-unit");
  state.dataPath = path.join(runtime.root, "profile");
  sourceRoot = path.join(runtime.root, "拍摄素材");
  fs.mkdirSync(sourceRoot, { recursive: true });
  fs.writeFileSync(path.join(sourceRoot, "照片.jpg"), "source bytes");
  vi.stubEnv("APPDATA", runtime.root);
});

afterEach(() => {
  vi.restoreAllMocks();
  closeDatabase();
  vi.unstubAllEnvs();
  const result = runtime.cleanup();
  expect(result.status).toBe("deleted");
});

function insertProjectPhoto(projectId: string) {
  const id = randomUUID();
  getDatabase()
    .insert(shootingProjectPhotos)
    .values({
      id,
      projectId,
      relativePath: "照片.jpg",
      filename: "照片.jpg",
      format: "jpg",
      fileSize: 12,
      modifiedAt: 1,
      createdAt: 1,
      status: "kept",
      previewRelativePath: `${id}.webp`,
      previewStatus: "ready",
    })
    .run();
  return id;
}

describe("shooting project storage", () => {
  it("counts only completed previews instead of staging or failed preview paths", async () => {
    const created = await createShootingProject({ sourceRoot });
    const id = insertProjectPhoto(created.id);
    const db = getDatabase();
    for (const status of ["pending", "failed"] as const) {
      db.update(shootingProjectPhotos)
        .set({
          previewStatus: status,
          previewRelativePath: `${id}.jpg.pending`,
        })
        .where(eq(shootingProjectPhotos.id, id))
        .run();
      expect((await listShootingProjects({}))[0].previewReadyCount).toBe(0);
    }
    db.update(shootingProjectPhotos)
      .set({ previewStatus: "ready", previewRelativePath: `${id}.jpg` })
      .where(eq(shootingProjectPhotos.id, id))
      .run();
    expect((await listShootingProjects({}))[0].previewReadyCount).toBe(1);
  });
  it("creates an independent project without importing photos or starting AI", async () => {
    const db = getDatabase();
    db.insert(photos)
      .values({
        path: path.join(runtime.root, "library.jpg"),
        filename: "library.jpg",
        isFavorite: true,
      })
      .run();
    const beforePhotos = db.select().from(photos).all();
    const beforeFolders = db.select().from(folders).all();

    const result = await createShootingProject({ sourceRoot });

    expect(result).toMatchObject({
      name: "拍摄素材",
      sourceRoot,
      sourceStatus: "online",
      pkMode: "standard",
      sourceInLibrary: false,
      photoCount: 0,
      keptCount: 0,
      previewReadyCount: 0,
    });
    expect(result.id).toMatch(PROJECT_ID_PATTERN);
    expect(db.select().from(photos).all()).toEqual(beforePhotos);
    expect(db.select().from(folders).all()).toEqual(beforeFolders);
    expect(fs.readFileSync(path.join(sourceRoot, "照片.jpg"), "utf8")).toBe(
      "source bytes"
    );
  });

  it("preserves project records, photo identities and selections across an offline database reopen", async () => {
    const created = await createShootingProject({
      sourceRoot,
      name: "  周末拍摄  ",
    });
    const photoId = insertProjectPhoto(created.id);
    fs.renameSync(sourceRoot, path.join(runtime.root, "移走的储存卡"));
    closeDatabase();

    const reopened = await openShootingProject(created.id);

    expect(reopened).toMatchObject({
      id: created.id,
      name: "周末拍摄",
      sourceRoot,
      sourceStatus: "offline",
      photoCount: 1,
      keptCount: 1,
      previewReadyCount: 1,
    });
    expect(
      getDatabase().select().from(shootingProjectPhotos).get()
    ).toMatchObject({
      id: photoId,
      status: "kept",
      sourceStatus: "unverified",
    });
    const listed = await listShootingProjects({});
    expect(listed).toEqual([
      { ...reopened, sourceCheckedAt: expect.any(Number) },
    ]);
    expect(listed[0].sourceCheckedAt).toBeGreaterThanOrEqual(
      reopened.sourceCheckedAt
    );
  });

  it("checks root availability without declaring existing files verified", async () => {
    const created = await createShootingProject({ sourceRoot });
    const photoId = insertProjectPhoto(created.id);
    const moved = path.join(runtime.root, "移走的储存卡");
    fs.renameSync(sourceRoot, moved);
    expect((await openShootingProject(created.id)).sourceStatus).toBe(
      "offline"
    );
    fs.renameSync(moved, sourceRoot);

    expect((await openShootingProject(created.id)).sourceStatus).toBe("online");
    expect(
      getDatabase()
        .select()
        .from(shootingProjectPhotos)
        .where(eq(shootingProjectPhotos.id, photoId))
        .get()?.sourceStatus
    ).toBe("unverified");
  });

  it("keeps project photos after the corresponding library photo and folder are deleted", async () => {
    const db = getDatabase();
    const created = await createShootingProject({ sourceRoot });
    const photoId = insertProjectPhoto(created.id);
    const folder = db
      .insert(folders)
      .values({ path: sourceRoot, displayName: "图库" })
      .returning()
      .get();
    db.insert(photos)
      .values({
        path: path.join(sourceRoot, "照片.jpg"),
        filename: "照片.jpg",
        folderId: folder.id,
      })
      .run();

    db.delete(photos).run();
    db.delete(folders).run();

    expect(db.select().from(shootingProjects).get()?.id).toBe(created.id);
    expect(db.select().from(shootingProjectPhotos).get()?.id).toBe(photoId);
    expect((await openShootingProject(created.id)).keptCount).toBe(1);
  });

  it("upgrades an existing 0055 database without changing library data", async () => {
    const migrationsRoot = path.join(runtime.root, "old-migrations");
    fs.mkdirSync(path.join(migrationsRoot, "meta"), { recursive: true });
    const journal = JSON.parse(
      fs.readFileSync("drizzle/meta/_journal.json", "utf8")
    );
    const currentMigrationCount = journal.entries.length;
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx <= 55
    );
    fs.writeFileSync(
      path.join(migrationsRoot, "meta", "_journal.json"),
      JSON.stringify(journal)
    );
    for (const entry of journal.entries) {
      fs.copyFileSync(
        path.join("drizzle", `${entry.tag}.sql`),
        path.join(migrationsRoot, `${entry.tag}.sql`)
      );
    }
    const sqlite = new Database(getDbPath());
    try {
      migrate(drizzle(sqlite), { migrationsFolder: migrationsRoot });
      sqlite.exec(
        "INSERT INTO photos(id,path,filename,is_favorite,created_at) VALUES(1,'original.jpg','original.jpg',1,1)"
      );
      expect(
        sqlite
          .prepare(
            "select name from sqlite_master where name='shooting_projects'"
          )
          .get()
      ).toBeUndefined();
    } finally {
      sqlite.close();
    }

    const created = await createShootingProject({ sourceRoot });

    expect(created.sourceStatus).toBe("online");
    expect(getDatabase().select().from(photos).get()).toMatchObject({
      id: 1,
      filename: "original.jpg",
      isFavorite: true,
    });
    expect(
      getDatabase().all(sql`select count(*) as count from __drizzle_migrations`)
    ).toEqual([{ count: currentMigrationCount }]);
  });
});

describe("shooting project source validation", () => {
  it("distinguishes permission failures from missing roots without deleting records", async () => {
    const created = await createShootingProject({ sourceRoot });
    vi.spyOn(fsp, "opendir").mockRejectedValue(
      Object.assign(new Error("denied"), { code: "EACCES" })
    );

    expect(await openShootingProject(created.id)).toMatchObject({
      id: created.id,
      sourceStatus: "inaccessible",
    });
    await expect(createShootingProject({ sourceRoot })).rejects.toMatchObject({
      code: "SOURCE_UNAVAILABLE",
    });
    expect(getDatabase().select().from(shootingProjects).all()).toHaveLength(1);
  });

  it("rejects nonexistent and file sources, invalid paths and invalid names", async () => {
    for (const source of ["", "relative/source", `${sourceRoot}\0`]) {
      await expect(
        createShootingProject({ sourceRoot: source })
      ).rejects.toMatchObject({ code: "INVALID_SOURCE" });
    }
    for (const source of [
      path.join(sourceRoot, "missing"),
      path.join(sourceRoot, "照片.jpg"),
    ]) {
      await expect(
        createShootingProject({ sourceRoot: source })
      ).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
    }
    for (const name of ["x".repeat(201), "bad\nname"]) {
      await expect(
        createShootingProject({ sourceRoot, name })
      ).rejects.toMatchObject({ code: "INVALID_NAME" });
    }
    await expect(openShootingProject(randomUUID())).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(getDatabase().select().from(shootingProjects).all()).toHaveLength(0);
  });

  it("requires explicit confirmation for managed sources and keeps existing watching unchanged", async () => {
    const db = getDatabase();
    db.insert(folders)
      .values({ path: sourceRoot, displayName: "图库", isWatching: true })
      .run();
    const before = db.select().from(folders).all();

    expect(await inspectShootingProjectSource(sourceRoot)).toMatchObject({
      sourceInLibrary: true,
    });
    await expect(createShootingProject({ sourceRoot })).rejects.toMatchObject({
      code: "LIBRARY_CONFIRMATION_REQUIRED",
    });
    expect(
      await createShootingProject({
        sourceRoot,
        acknowledgeLibrarySource: true,
      })
    ).toMatchObject({ sourceInLibrary: true });
    expect(db.select().from(folders).all()).toEqual(before);
  });

  it("matches nested library roots on directory boundaries and not shared prefixes", async () => {
    const nested = path.join(sourceRoot, "图库子目录");
    const sibling = `${sourceRoot}-other`;
    fs.mkdirSync(nested);
    fs.mkdirSync(sibling);
    getDatabase()
      .insert(folders)
      .values({ path: nested, displayName: "图库" })
      .run();

    expect(
      (await inspectShootingProjectSource(sourceRoot)).sourceInLibrary
    ).toBe(true);
    expect((await inspectShootingProjectSource(nested)).sourceInLibrary).toBe(
      true
    );
    expect(
      (await inspectShootingProjectSource(path.join(nested, "child")))
        .sourceInLibrary
    ).toBe(true);
    expect((await inspectShootingProjectSource(sibling)).sourceInLibrary).toBe(
      false
    );
  });
});

describe("shooting project listing", () => {
  it("sorts by last opening and searches literal names without SQL wildcards", async () => {
    const first = await createShootingProject({
      sourceRoot,
      name: "100%_自然",
    });
    const second = await createShootingProject({ sourceRoot, name: "other" });
    const db = getDatabase();
    db.update(shootingProjects)
      .set({ lastOpenedAt: 1 })
      .where(eq(shootingProjects.id, first.id))
      .run();
    db.update(shootingProjects)
      .set({ lastOpenedAt: 2 })
      .where(eq(shootingProjects.id, second.id))
      .run();

    expect((await listShootingProjects({})).map(({ id }) => id)).toEqual([
      second.id,
      first.id,
    ]);
    expect(
      (await listShootingProjects({ search: "%_" })).map(({ id }) => id)
    ).toEqual([first.id]);
    await openShootingProject(first.id);
    expect((await listShootingProjects({})).map(({ id }) => id)).toEqual([
      first.id,
      second.id,
    ]);
    db.update(shootingProjects)
      .set({ archivedAt: 1 })
      .where(eq(shootingProjects.id, first.id))
      .run();
    expect((await listShootingProjects({})).map(({ id }) => id)).toEqual([
      second.id,
    ]);
    expect(
      (await listShootingProjects({ archived: true })).map(({ id }) => id)
    ).toEqual([first.id]);
  });
});
