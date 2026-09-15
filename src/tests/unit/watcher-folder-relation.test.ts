// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: undefined as unknown,
  watchers: [] as EventEmitter[],
  thumbnail: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("chokidar", () => ({
  default: {
    watch: () => {
      const watcher = new EventEmitter();
      Object.assign(watcher, { close: async () => undefined });
      state.watchers.push(watcher);
      return watcher;
    },
  },
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: async () => undefined,
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: () => undefined,
}));
vi.mock("@/services/thumbnailer", () => ({
  generateThumbnail: state.thumbnail,
  deletePhotoThumbnails: () => undefined,
}));
vi.mock("@/services/raw-preview", () => ({ isRawFile: () => false }));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: async () => null,
}));
vi.mock("@/utils/logger", () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

let sqlite: Database.Database;
let root: string;
let indexer: typeof import("@/services/indexer");
beforeEach(async () => {
  vi.resetModules();
  state.watchers.length = 0;
  sqlite = new Database(":memory:");
  state.db = drizzle(sqlite);
  migrate(state.db as ReturnType<typeof drizzle>, {
    migrationsFolder: "drizzle",
  });
  const base = path.resolve(".test-runtime");
  fs.mkdirSync(base, { recursive: true });
  root = fs.mkdtempSync(path.join(base, "f04-unit-"));
  fs.mkdirSync(path.join(root, "A"));
  const buffer = await sharp({
    create: { width: 32, height: 32, channels: 3, background: "#4080a0" },
  })
    .jpeg()
    .toBuffer();
  fs.writeFileSync(path.join(root, "A/photo.jpg"), buffer);
  state.thumbnail
    .mockReset()
    .mockResolvedValue({ buffer, thumbnailPath: null, width: 32, height: 32 });
  indexer = await import("@/services/indexer");
  await indexer.scanFolder(root);
});
afterEach(async () => {
  await indexer?.stopWatching();
  sqlite?.close();
  if (
    root &&
    path.dirname(root) === path.resolve(".test-runtime") &&
    path.basename(root).startsWith("f04-unit-")
  ) {
    await fs.promises.rm(root, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100,
    });
  }
});

it.each([
  "watchFolder",
  "startWatching",
] as const)("%s assigns the first moved file to a newly discovered nested directory", async (entry) => {
  const changed = vi.fn();
  if (entry === "watchFolder") {
    indexer.watchFolder(root, changed);
  } else {
    indexer.startWatching(changed);
  }
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "B/深层/photo.jpg");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.renameSync(oldPath, target);
  state.watchers[0].emit("unlink", oldPath);
  state.watchers[0].emit("add", target);
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledWith(expect.any(Number), "add")
  );
  const rows = sqlite
    .prepare(
      "select p.path, f.path folderPath, f.photo_count count, parent.path parentPath from photos p join folders f on f.id=p.folder_id left join folders parent on parent.id=f.parent_id"
    )
    .all();
  expect(rows).toEqual([
    {
      path: target,
      folderPath: path.dirname(target),
      count: 1,
      parentPath: path.join(root, "B"),
    },
  ]);
  expect(sqlite.prepare("pragma foreign_key_check").all()).toEqual([]);
  expect(fs.existsSync(oldPath)).toBe(false);
  expect(fs.existsSync(target)).toBe(true);
});

it("keeps the same directory and count when a scan finishes during watcher preparation", async () => {
  const changed = vi.fn();
  indexer.watchFolder(root, changed);
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "B/photo.jpg");
  fs.mkdirSync(path.dirname(target));
  fs.renameSync(oldPath, target);
  const thumbnail = await state.thumbnail();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  state.thumbnail.mockImplementationOnce(async () => {
    entered = true;
    await waiting;
    return thumbnail;
  });
  state.watchers[0].emit("unlink", oldPath);
  state.watchers[0].emit("add", target);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    await indexer.scanFolder(root);
  } finally {
    release();
  }
  await vi.waitFor(() =>
    expect(indexer.getWatcherStats().queuePending).toBe(0)
  );
  expect(indexer.getWatcherStats().errors).toBe(0);
  expect(changed).toHaveBeenCalledWith(expect.any(Number), "add");
  expect(
    sqlite
      .prepare(
        "select p.path, f.path folderPath, f.photo_count count from photos p join folders f on f.id=p.folder_id"
      )
      .all()
  ).toEqual([{ path: target, folderPath: path.dirname(target), count: 1 }]);
});

it("includes a watcher insert in the first scan result when the scan was preparing it", async () => {
  const changed = vi.fn();
  indexer.watchFolder(root, changed);
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "B/photo.jpg");
  fs.mkdirSync(path.dirname(target));
  fs.renameSync(oldPath, target);
  state.watchers[0].emit("unlink", oldPath);
  const thumbnail = await state.thumbnail();
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  state.thumbnail.mockImplementationOnce(async () => {
    entered = true;
    await waiting;
    return thumbnail;
  });
  const scan = indexer.scanFolder(root);
  try {
    await vi.waitFor(() => expect(entered).toBe(true));
    state.watchers[0].emit("add", target);
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith(expect.any(Number), "add")
    );
  } finally {
    release();
  }
  const result = await scan;
  expect(result.photoIds).toHaveLength(1);
  expect(result.newPhotoIds).toHaveLength(0);
  expect(
    sqlite
      .prepare(
        "select p.path, f.path folderPath, f.photo_count count from photos p join folders f on f.id=p.folder_id"
      )
      .all()
  ).toEqual([{ path: target, folderPath: path.dirname(target), count: 1 }]);
});

it("rolls back directory discovery on a database failure instead of assigning the ancestor", async () => {
  const changed = vi.fn();
  indexer.watchFolder(root, changed);
  const target = path.join(root, "B/blocked/photo.jpg");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(path.join(root, "A/photo.jpg"), target);
  sqlite.exec(
    "CREATE TRIGGER fail_directory BEFORE INSERT ON folders WHEN NEW.display_name='blocked' BEGIN SELECT RAISE(ABORT, 'test directory failure'); END"
  );
  state.watchers[0].emit("add", target);
  await vi.waitFor(() => expect(indexer.getWatcherStats().errors).toBe(1));
  expect(changed).not.toHaveBeenCalled();
  expect(sqlite.prepare("select path from photos").all()).toEqual([
    { path: path.join(root, "A/photo.jpg") },
  ]);
  expect(
    sqlite
      .prepare("select count(*) n from folders where display_name='B'")
      .get()
  ).toEqual({ n: 0 });
});
