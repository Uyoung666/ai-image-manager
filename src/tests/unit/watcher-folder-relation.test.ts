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
  watchers: [] as Array<
    EventEmitter & {
      close: ReturnType<typeof vi.fn>;
      folderPath: string;
    }
  >,
  closeErrors: new Map<string, Error>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  throwOnWatch: new Set<string>(),
  thumbnail: vi.fn(),
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("chokidar", () => ({
  default: {
    watch: (folderPath: string) => {
      if (state.throwOnWatch.has(folderPath)) {
        throw Object.assign(new Error("watch creation failed"), {
          code: "UNKNOWN",
          syscall: "watch",
        });
      }
      const watcher = new EventEmitter() as (typeof state.watchers)[number];
      const close = vi.fn(() => {
        watcher.removeAllListeners();
        const error = state.closeErrors.get(folderPath);
        if (error) {
          return Promise.reject(error);
        }
        return Promise.resolve();
      });
      Object.assign(watcher, { close, folderPath });
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
  createLogger: () => state.logger,
}));

let sqlite: Database.Database;
let root: string;
let indexer: typeof import("@/services/indexer");
beforeEach(async () => {
  vi.resetModules();
  state.watchers.length = 0;
  state.closeErrors.clear();
  state.logger.info.mockReset();
  state.logger.warn.mockReset();
  state.logger.error.mockReset();
  state.throwOnWatch.clear();
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

function getMockWatcher(folderPath: string) {
  const watcher = state.watchers.findLast(
    (item) => item.folderPath === folderPath
  );
  expect(watcher).toBeDefined();
  return watcher as (typeof state.watchers)[number];
}

it.each([
  "watchFolder",
  "startWatching",
] as const)("%s contains an asynchronous watcher error and ignores stale errors", async (entry) => {
  const changed = vi.fn();
  if (entry === "watchFolder") {
    indexer.watchFolder(root, changed);
  } else {
    indexer.startWatching(changed);
  }

  const oldWatcher = getMockWatcher(root);
  const error = Object.assign(new Error("unknown error, watch"), {
    code: "UNKNOWN",
    syscall: "watch",
  });
  expect(() => oldWatcher.emit("error", error)).not.toThrow();
  expect(() => oldWatcher.emit("error", error)).not.toThrow();
  await vi.waitFor(() => expect(oldWatcher.close).toHaveBeenCalledTimes(1));

  expect(
    sqlite
      .prepare(
        "select is_watching isWatching, watcher_started_at watcherStartedAt from folders where path = ?"
      )
      .get(root)
  ).toEqual({ isWatching: 0, watcherStartedAt: null });
  expect(state.logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      folderId: expect.any(Number),
      folderPath: root,
      code: "UNKNOWN",
      syscall: "watch",
      phase: "error",
      err: error,
    }),
    "Watcher: File system error"
  );
  expect(
    state.logger.error.mock.calls.filter(
      ([fields]) => fields?.phase === "error"
    )
  ).toHaveLength(1);

  indexer.watchFolder(root, changed);
  const replacement = getMockWatcher(root);
  expect(replacement).not.toBe(oldWatcher);
  oldWatcher.emit("error", error);
  oldWatcher.emit("add", path.join(root, "late.jpg"));
  await Promise.resolve();
  expect(replacement.close).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
});

it.each([
  "watchFolder",
  "startWatching",
] as const)("%s contains synchronous watcher creation failure", async (entry) => {
  sqlite
    .prepare(
      "update folders set is_watching = 1, watcher_started_at = 123 where path = ?"
    )
    .run(root);
  state.throwOnWatch.add(root);
  const changed = vi.fn();

  expect(() => {
    if (entry === "watchFolder") {
      indexer.watchFolder(root, changed);
    } else {
      indexer.startWatching(changed);
    }
  }).not.toThrow();

  if (entry === "startWatching") {
    const otherWatcher = getMockWatcher(path.join(root, "A"));
    const newPhoto = path.join(root, "A/after-create-failure.jpg");
    fs.copyFileSync(path.join(root, "A/photo.jpg"), newPhoto);
    otherWatcher.emit("add", newPhoto);
    await vi.waitFor(() =>
      expect(changed).toHaveBeenCalledWith(expect.any(Number), "add")
    );
  } else {
    expect(state.watchers.some((watcher) => watcher.folderPath === root)).toBe(
      false
    );
  }

  expect(
    sqlite
      .prepare(
        "select is_watching isWatching, watcher_started_at watcherStartedAt from folders where path = ?"
      )
      .get(root)
  ).toEqual({ isWatching: 0, watcherStartedAt: null });
  expect(state.logger.error).toHaveBeenCalledWith(
    expect.objectContaining({
      folderId: expect.any(Number),
      folderPath: root,
      code: "UNKNOWN",
      syscall: "watch",
      phase: "create",
    }),
    "Watcher: Failed to create"
  );
});

it("swallows close and state update failures from an asynchronous watcher error", async () => {
  const closeError = new Error("close failed");
  state.closeErrors.set(root, closeError);
  indexer.startWatching(vi.fn());
  const watcher = getMockWatcher(root);
  sqlite.exec(
    "CREATE TRIGGER fail_watcher_state BEFORE UPDATE OF is_watching ON folders WHEN NEW.is_watching = 0 BEGIN SELECT RAISE(ABORT, 'state update failed'); END"
  );

  const watcherError = Object.assign(new Error("unknown error, watch"), {
    code: "UNKNOWN",
    syscall: "watch",
  });
  expect(() => watcher.emit("error", watcherError)).not.toThrow();
  await vi.waitFor(() => expect(watcher.close).toHaveBeenCalledTimes(1));
  expect(() => watcher.emit("error", watcherError)).not.toThrow();
  await Promise.resolve();

  expect(state.logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "state" }),
    "Watcher: Failed to update state (stopped)"
  );
  expect(state.logger.error).toHaveBeenCalledWith(
    expect.objectContaining({ phase: "close", err: closeError }),
    "Watcher: Failed to close"
  );
});
