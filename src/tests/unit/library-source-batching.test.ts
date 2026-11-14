/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  albumPhotos,
  albums,
  folders,
  photos,
  photoTags,
  tags,
} from "@/db/schema";
import {
  type LibraryFileObservation,
  reconcileLibrarySources,
  withLibrarySourcesPaused,
} from "@/services/library-source";
import { TestRuntime } from "@/tests/helpers/test-runtime";
import { GALLERY_CONFIG } from "@/utils/gallery-config";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
const BEGIN_TRANSACTION = /^begin\b/i;
const COMMIT_TRANSACTION = /^commit\b/i;

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let source: string;
let trace: string[];

const photoPath = (id: number) => path.join(source, `${id}.jpg`);
const row = (id: number) =>
  db.select().from(photos).where(eq(photos.id, id)).get();
const sourceWrites = () =>
  trace.filter((statement) => statement.startsWith('update "photos" set'));

async function addPhotos(first: number, last: number) {
  await Promise.all(
    Array.from({ length: last - first + 1 }, (_, offset) => {
      const id = first + offset;
      return fs.promises.writeFile(photoPath(id), `original bytes ${id}`);
    })
  );
  db.insert(photos)
    .values(
      Array.from({ length: last - first + 1 }, (_, offset) => {
        const id = first + offset;
        return {
          id,
          path: photoPath(id),
          filename: `${id}.jpg`,
          folderId: 1,
          sourceStatus: "offline" as const,
          isFavorite: true,
        };
      })
    )
    .run();
}

beforeEach(async () => {
  runtime = new TestRuntime("library-source-batching");
  source = path.join(runtime.root, "source");
  await fs.promises.mkdir(source);
  trace = [];
  sqlite = new Database(path.join(runtime.root, "library.db"), {
    verbose: (statement) => trace.push(String(statement)),
  });
  sqlite.pragma("foreign_keys = ON");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values({ id: 1, path: source, displayName: "source" })
    .run();
  await addPhotos(1, 3);
  db.insert(albums).values({ id: 1, name: "preserved album" }).run();
  db.insert(albumPhotos).values({ albumId: 1, photoId: 1 }).run();
  db.insert(tags).values({ id: 1, name: "preserved tag" }).run();
  db.insert(photoTags).values({ tagId: 1, photoId: 1 }).run();
  trace.length = 0;
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("commits each bounded page in one transaction before bounded content callbacks", async () => {
  await addPhotos(4, 205);
  trace.length = 0;
  const transactions: boolean[] = [];
  sqlite.function("source_write_sentry", () => {
    transactions.push(sqlite.inTransaction);
    return 0;
  });
  sqlite.exec(`CREATE TRIGGER source_write_sentry AFTER UPDATE OF source_status ON photos
    BEGIN SELECT source_write_sentry(); END`);
  const opendir = vi.spyOn(fs.promises, "opendir");
  let active = 0;
  let maximum = 0;
  const callbackIds: number[] = [];
  const onAvailable = vi.fn(
    async (photo: { id: number }, observation?: LibraryFileObservation) => {
      expect(sqlite.inTransaction).toBe(false);
      expect(row(photo.id)).toMatchObject({ sourceStatus: "available" });
      expect(observation).toMatchObject({
        size: Buffer.byteLength(`original bytes ${photo.id}`),
        mtimeMs: expect.any(Number),
        ctimeMs: expect.any(Number),
      });
      if (!callbackIds.length) {
        expect(
          db
            .select()
            .from(photos)
            .all()
            .filter((p) => p.sourceStatus === "available")
        ).toHaveLength(200);
      }
      callbackIds.push(photo.id);
      maximum = Math.max(maximum, ++active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active--;
    }
  );
  expect(await reconcileLibrarySources({ onAvailable })).toMatchObject({
    checked: 205,
    changed: 205,
    available: 205,
  });
  expect(
    trace.filter((statement) => BEGIN_TRANSACTION.test(statement))
  ).toHaveLength(2);
  expect(
    trace.filter((statement) => COMMIT_TRANSACTION.test(statement))
  ).toHaveLength(2);
  expect(transactions).toHaveLength(205);
  expect(transactions.every(Boolean)).toBe(true);
  expect(new Set(callbackIds).size).toBe(205);
  expect(maximum).toBe(GALLERY_CONFIG.sourceCheckConcurrency);
  expect(opendir.mock.calls.filter(([root]) => root === source)).toHaveLength(
    1
  );
});

it.each([
  "cancel",
  "switch",
  "obsolete",
])("discards the uncommitted page when its scan becomes %s", async (mode) => {
  const controller = new AbortController();
  let isCurrent = true;
  const originalStat = fs.promises.stat;
  vi.spyOn(fs.promises, "stat").mockImplementation(async (file, options) => {
    const stat = await originalStat(file, options);
    if (file === photoPath(3)) {
      if (mode === "cancel") {
        controller.abort();
      } else if (mode === "switch") {
        state.db = undefined;
      } else {
        isCurrent = false;
      }
    }
    return stat;
  });
  const onAvailable = vi.fn();
  expect(
    await reconcileLibrarySources({
      signal: controller.signal,
      isCurrent: () => isCurrent,
      onAvailable,
    })
  ).toMatchObject({ checked: 0, changed: 0 });
  expect(sourceWrites()).toHaveLength(0);
  expect(
    db
      .select()
      .from(photos)
      .all()
      .every((p) => p.sourceCheckedAt === null)
  ).toBe(true);
  expect(onAvailable).not.toHaveBeenCalled();
});

it("does not commit observations paused before their page is written", async () => {
  const originalStat = fs.promises.stat;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let paused: Promise<void> | undefined;
  vi.spyOn(fs.promises, "stat").mockImplementation(async (file, options) => {
    const stat = await originalStat(file, options);
    if (file === photoPath(3)) {
      paused = withLibrarySourcesPaused([source], () => gate);
    }
    return stat;
  });
  const onAvailable = vi.fn();
  try {
    expect(await reconcileLibrarySources({ onAvailable })).toMatchObject({
      checked: 0,
    });
    expect(sourceWrites()).toHaveLength(0);
    expect(onAvailable).not.toHaveBeenCalled();
  } finally {
    release?.();
    await paused;
  }
});

it("keeps path, file revision and newer checked-at CAS guards when committing a page", async () => {
  const originalStat = fs.promises.stat;
  vi.spyOn(fs.promises, "stat").mockImplementation(async (file, options) => {
    const stat = await originalStat(file, options);
    if (file === photoPath(3)) {
      db.update(photos).set({ fileRevision: 1 }).where(eq(photos.id, 1)).run();
      db.update(photos)
        .set({ path: path.join(source, "moved.jpg") })
        .where(eq(photos.id, 2))
        .run();
      db.update(photos)
        .set({ sourceCheckedAt: Date.now() + 60_000 })
        .where(eq(photos.id, 3))
        .run();
    }
    return stat;
  });
  const onAvailable = vi.fn();
  expect(await reconcileLibrarySources({ onAvailable })).toMatchObject({
    checked: 3,
    available: 3,
    changed: 0,
  });
  expect(
    db
      .select()
      .from(photos)
      .all()
      .every((p) => p.sourceStatus === "offline")
  ).toBe(true);
  expect(row(1)).toMatchObject({ fileRevision: 1, sourceCheckedAt: null });
  expect(row(2)).toMatchObject({
    path: path.join(source, "moved.jpg"),
    sourceCheckedAt: null,
  });
  expect(onAvailable).not.toHaveBeenCalled();
});

it("rolls back a failed page without losing photo identity or associations", async () => {
  sqlite.exec(`CREATE TRIGGER fail_source_write BEFORE UPDATE OF source_status ON photos
    WHEN NEW.id = 2 BEGIN SELECT RAISE(ABORT, 'source write failed'); END`);
  const onAvailable = vi.fn();
  await expect(reconcileLibrarySources({ onAvailable })).rejects.toThrow(
    "source write failed"
  );
  expect(sqlite.inTransaction).toBe(false);
  expect(db.select().from(photos).all()).toHaveLength(3);
  for (const photo of db.select().from(photos).all()) {
    expect(photo).toMatchObject({
      sourceStatus: "offline",
      sourceCheckedAt: null,
      sourceAvailableAt: null,
      isFavorite: true,
      deletedAt: null,
    });
  }
  expect(db.select().from(albumPhotos).all()).toHaveLength(1);
  expect(db.select().from(photoTags).all()).toHaveLength(1);
  expect(onAvailable).not.toHaveBeenCalled();
  sqlite.exec("DROP TRIGGER fail_source_write");
  expect(await reconcileLibrarySources({ onAvailable })).toMatchObject({
    changed: 3,
  });
  expect(onAvailable).toHaveBeenCalledTimes(3);
});

it("uses only individual file evidence for mixed available, denied and missing states", async () => {
  const missing = path.join(source, "missing.jpg");
  db.update(photos).set({ path: missing }).where(eq(photos.id, 3)).run();
  const originalAccess = fs.promises.access;
  vi.spyOn(fs.promises, "access").mockImplementation((file, mode) => {
    if (file === photoPath(2)) {
      return Promise.reject(
        Object.assign(new Error("denied"), { code: "EACCES" })
      );
    }
    return originalAccess(file, mode);
  });
  const onAvailable = vi.fn();
  expect(await reconcileLibrarySources({ onAvailable })).toMatchObject({
    checked: 3,
    changed: 3,
    available: 1,
    inaccessible: 1,
    missing: 1,
  });
  expect(row(2)).toMatchObject({
    sourceStatus: "inaccessible",
    sourceErrorCode: "EACCES",
  });
  expect(row(3)).toMatchObject({
    sourceStatus: "missing",
    sourceErrorCode: "ENOENT",
  });
  expect(onAvailable).toHaveBeenCalledTimes(1);
});

it("stops content callbacks after cancellation without undoing a committed page", async () => {
  const controller = new AbortController();
  const onAvailable = vi.fn(() => {
    expect(sqlite.inTransaction).toBe(false);
    controller.abort();
    return Promise.resolve();
  });
  expect(
    await reconcileLibrarySources({ signal: controller.signal, onAvailable })
  ).toMatchObject({
    checked: 3,
    available: 3,
    changed: 3,
  });
  expect(onAvailable).toHaveBeenCalledTimes(1);
  expect(
    db
      .select()
      .from(photos)
      .all()
      .every((p) => p.sourceStatus === "available")
  ).toBe(true);
});

it("yields a busy content callback slice to foreground cancellation after committing the page", async () => {
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const controller = new AbortController();
  const events: string[] = [];
  const onAvailable = vi.fn(() => {
    events.push("content");
    clock = 5;
    setImmediate(() => {
      events.push("foreground");
      controller.abort();
    });
    return Promise.resolve();
  });
  expect(
    await reconcileLibrarySources({ signal: controller.signal, onAvailable })
  ).toMatchObject({ checked: 3, changed: 3, available: 3 });
  expect(events).toEqual(["content", "foreground"]);
  expect(onAvailable).toHaveBeenCalledTimes(1);
  expect(sqlite.inTransaction).toBe(false);
  expect(db.select().from(photos).all()).toHaveLength(3);
  for (const photo of db.select().from(photos).all()) {
    expect(photo).toMatchObject({
      sourceStatus: "available",
      isFavorite: true,
      deletedAt: null,
    });
  }
  expect(db.select().from(albumPhotos).all()).toHaveLength(1);
  expect(db.select().from(photoTags).all()).toHaveLength(1);
});

it("rechecks cancellation after yielding a source probe slice before any page write", async () => {
  const observations = new Map(
    await Promise.all(
      [1, 2, 3].map(
        async (id) =>
          [photoPath(id), await fs.promises.stat(photoPath(id))] as const
      )
    )
  );
  let clock = 0;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  const controller = new AbortController();
  const foreground = vi.fn(() => controller.abort());
  const originalStat = fs.promises.stat;
  vi.spyOn(fs.promises, "stat").mockImplementation((file, options) => {
    const observation = observations.get(String(file));
    if (observation) {
      if (file === photoPath(1)) {
        clock = 5;
        setImmediate(foreground);
      }
      return Promise.resolve(observation);
    }
    return originalStat(file, options);
  });
  const originalAccess = fs.promises.access;
  vi.spyOn(fs.promises, "access").mockImplementation((file, mode) => {
    // Model immediately resolved probes so only the explicit time slice can
    // hand control to the foreground macrotask between photo observations.
    return observations.has(String(file))
      ? Promise.resolve()
      : originalAccess(file, mode);
  });
  const onAvailable = vi.fn();
  expect(
    await reconcileLibrarySources({ signal: controller.signal, onAvailable })
  ).toMatchObject({ checked: 0, changed: 0 });
  expect(foreground).toHaveBeenCalledOnce();
  expect(sourceWrites()).toHaveLength(0);
  expect(onAvailable).not.toHaveBeenCalled();
  expect(
    db
      .select()
      .from(photos)
      .all()
      .every((photo) => photo.sourceCheckedAt === null)
  ).toBe(true);
  expect(db.select().from(albumPhotos).all()).toHaveLength(1);
  expect(db.select().from(photoTags).all()).toHaveLength(1);
});
