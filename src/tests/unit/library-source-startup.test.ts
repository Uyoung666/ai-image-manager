/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { folders, photos } from "@/db/schema";
import { reconcileLibrarySources } from "@/services/library-source";
import { TestRuntime } from "@/tests/helpers/test-runtime";

const state = vi.hoisted(() => ({ db: undefined as unknown }));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));

let runtime: TestRuntime;
let sqlite: Database.Database;
let db: ReturnType<typeof drizzle>;
let online: string;
let offline: string;
let available: string;

beforeEach(async () => {
  runtime = new TestRuntime("library-source-startup");
  online = path.join(runtime.root, "online");
  offline = path.join(runtime.root, "offline");
  available = path.join(online, "available.jpg");
  await fs.promises.mkdir(online);
  await fs.promises.writeFile(available, "original bytes");
  sqlite = new Database(":memory:");
  db = drizzle(sqlite);
  migrate(db, { migrationsFolder: "drizzle" });
  state.db = db;
  db.insert(folders)
    .values([
      { id: 1, path: online, displayName: "online" },
      { id: 2, path: offline, displayName: "offline" },
    ])
    .run();
  db.insert(photos)
    .values([
      { id: 1, folderId: 1, path: available, filename: "available.jpg" },
      {
        id: 2,
        folderId: 1,
        path: path.join(online, "missing.jpg"),
        filename: "missing.jpg",
      },
      {
        id: 3,
        folderId: 2,
        path: path.join(offline, "photo.jpg"),
        filename: "photo.jpg",
        sourceStatus: "available",
        isFavorite: true,
      },
    ])
    .run();
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("probes online roots once without duplicating the later per-file source check", async () => {
  const stat = vi.spyOn(fs.promises, "stat");
  const access = vi.spyOn(fs.promises, "access");
  const opendir = vi.spyOn(fs.promises, "opendir");
  const sourcePaths = new Set([
    available,
    path.join(online, "missing.jpg"),
    path.join(offline, "photo.jpg"),
  ]);
  const sourceCalls = (calls: readonly (readonly unknown[])[]) =>
    calls.flatMap(([file]) =>
      typeof file === "string" && sourcePaths.has(file) ? [file] : []
    );
  const onAvailable = vi.fn();
  expect(
    await reconcileLibrarySources({ unavailableRootsOnly: true, onAvailable })
  ).toMatchObject({ checked: 1, offline: 1, missing: 0, available: 0 });
  expect(sourceCalls(stat.mock.calls)).toEqual([]);
  expect(sourceCalls(access.mock.calls)).toEqual([]);
  expect(opendir.mock.calls.filter(([root]) => root === online)).toHaveLength(
    1
  );
  expect(onAvailable).not.toHaveBeenCalled();
  expect(
    db.select().from(folders).where(eq(folders.id, 1)).get()
  ).toMatchObject({
    sourceStatus: "available",
    sourceCheckedAt: expect.any(Number),
  });
  expect(db.select().from(photos).where(eq(photos.id, 1)).get()).toMatchObject({
    sourceStatus: "unverified",
    sourceCheckedAt: null,
  });

  const summary = await reconcileLibrarySources({ onAvailable });
  expect(summary).toMatchObject({
    checked: 3,
    available: 1,
    missing: 1,
    offline: 1,
  });
  expect(sourceCalls(access.mock.calls).sort()).toEqual([
    available,
    path.join(online, "missing.jpg"),
  ]);
  expect(sourceCalls(stat.mock.calls)).toEqual([available]);
  expect(onAvailable).toHaveBeenCalledTimes(1);
});

it("still marks disconnected roots offline and preserves photo identity and favourites", async () => {
  await reconcileLibrarySources({ unavailableRootsOnly: true });
  expect(db.select().from(photos).all()).toHaveLength(3);
  expect(db.select().from(photos).where(eq(photos.id, 3)).get()).toMatchObject({
    id: 3,
    path: path.join(offline, "photo.jpg"),
    sourceStatus: "offline",
    isFavorite: true,
    deletedAt: null,
  });
  expect(
    db.select().from(folders).where(eq(folders.id, 2)).get()
  ).toMatchObject({
    sourceStatus: "offline",
    lastScanResult: "offline",
  });
});
