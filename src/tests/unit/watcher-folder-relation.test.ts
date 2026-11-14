// @vitest-environment node
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { photos } from "@/db/schema";

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
  waitForeground: vi.fn(),
}));
vi.mock("@/services/library-foreground", () => ({
  isLibraryForegroundBusy: () => false,
  waitForLibraryForegroundIdle: state.waitForeground,
}));
vi.mock("@/db", () => ({ getDatabase: () => state.db }));
vi.mock("@/services/background-file-watcher", () => ({
  createBackgroundWatcher: (folderPath: string) => {
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
}));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: async () => undefined,
  deleteColorVectors: async () => undefined,
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: () => undefined,
}));
vi.mock("@/services/thumbnailer", () => ({
  getThumbnailSize: () => 512,
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

async function verifyFixtureFingerprint(): Promise<number> {
  const db = state.db as ReturnType<typeof drizzle>;
  const photo = db.select().from(photos).get();
  if (!photo) {
    throw new Error("Missing indexed fixture");
  }
  const { backfillLibraryFingerprint } = await import(
    "@/services/library-moves"
  );
  await backfillLibraryFingerprint(db, photo, () => true);
  return photo.id;
}
beforeEach(async () => {
  vi.resetModules();
  state.watchers.length = 0;
  state.closeErrors.clear();
  state.logger.info.mockReset();
  state.logger.warn.mockReset();
  state.logger.error.mockReset();
  state.throwOnWatch.clear();
  state.waitForeground
    .mockReset()
    .mockImplementation((isCurrent: () => boolean) =>
      Promise.resolve(isCurrent())
    );
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
  vi.restoreAllMocks();
  indexer?.setWatcherReconciliationCallback();
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

it("shares recursive roots and publishes readiness only after ready", () => {
  const ready = vi.fn();
  indexer.setWatcherReconciliationCallback(ready);
  indexer.startWatching(vi.fn());
  expect(state.watchers).toHaveLength(1);
  expect(
    sqlite
      .prepare("select is_watching value from folders where path=?")
      .get(root)
  ).toEqual({ value: 0 });
  state.watchers[0].emit("ready");
  expect(ready).toHaveBeenCalledWith(root);
  state.watchers[0].emit("addDir", path.join(root, "new-folder"));
  expect(ready).toHaveBeenCalledTimes(2);
  expect(
    sqlite
      .prepare("select is_watching value from folders where path=?")
      .get(root)
  ).toEqual({ value: 1 });
  indexer.watchFolder(path.join(root, "A"), vi.fn());
  expect(state.watchers).toHaveLength(1);
});

it("background scans find offline deep additions without reprocessing existing photos", async () => {
  const deep = path.join(
    root,
    ...Array.from({ length: 12 }, (_, i) => `level-${i}`)
  );
  fs.mkdirSync(deep, { recursive: true });
  fs.copyFileSync(path.join(root, "A/photo.jpg"), path.join(deep, "new.jpg"));
  state.thumbnail.mockClear();
  const result = await indexer.scanFolder(root, undefined, {
    background: true,
  });
  expect(result.incomplete).toBe(false);
  expect(result.newPhotoIds).toHaveLength(1);
  expect(state.thumbnail).toHaveBeenCalledOnce();
  const again = await indexer.scanFolder(root, undefined, { background: true });
  expect(again.newPhotoIds).toEqual([]);
  expect(state.thumbnail).toHaveBeenCalledOnce();
});

it("waits at a background batch boundary before probing originals and cancels cleanly", async () => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  state.waitForeground.mockImplementationOnce(
    async (isCurrent: () => boolean) => {
      entered.resolve();
      await release.promise;
      return isCurrent();
    }
  );
  const original = path.join(root, "A/photo.jpg");
  const access = vi.spyOn(fs.promises, "access");
  const existing = sqlite
    .prepare("SELECT id, path, source_checked_at FROM photos")
    .all();
  const scanning = indexer.scanFolder(root, undefined, { background: true });
  await entered.promise;
  expect(access.mock.calls.filter(([file]) => file === original)).toHaveLength(
    0
  );
  indexer.stopScanning();
  release.resolve();
  expect(await scanning).toMatchObject({ cancelled: true, newPhotoIds: [] });
  expect(
    sqlite.prepare("SELECT id, path, source_checked_at FROM photos").all()
  ).toEqual(existing);
});

it("keeps an explicit scan independent of the foreground background-work gate", async () => {
  state.waitForeground.mockClear();
  const result = await indexer.scanFolder(root);
  expect(result.cancelled).toBe(false);
  expect(result.photoIds).toHaveLength(1);
  expect(state.waitForeground).not.toHaveBeenCalled();
});

it("recovers a failed watcher with bounded retries and ignores retired readiness", async () => {
  vi.useFakeTimers();
  try {
    const ready = vi.fn();
    indexer.setWatcherReconciliationCallback(ready);
    indexer.watchFolder(root, vi.fn());
    const retired = state.watchers[0];
    retired.emit("error", new Error("native failure"));
    await vi.advanceTimersByTimeAsync(6001);
    expect(state.watchers).toHaveLength(2);
    retired.emit("ready");
    expect(ready).not.toHaveBeenCalled();
    for (const delay of [36_001, 144_001]) {
      state.watchers.at(-1)?.emit("error", new Error("native failure"));
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(state.watchers).toHaveLength(4);
    state.watchers.at(-1)?.emit("error", new Error("native failure"));
    await vi.advanceTimersByTimeAsync(600_000);
    expect(state.watchers).toHaveLength(4);
  } finally {
    vi.useRealTimers();
  }
});

it.each([
  "watchFolder",
  "startWatching",
] as const)("%s assigns the first moved file to a newly discovered nested directory", async (entry) => {
  const originalId = await verifyFixtureFingerprint();
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
  // A destination event is not dependent on delivery of the old-path event.
  state.watchers[0].emit("add", target);
  await vi.waitFor(() =>
    expect(changed).toHaveBeenCalledWith(originalId, "update")
  );
  state.watchers[0].emit("unlink", oldPath);
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
  fs.copyFileSync(oldPath, target);
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
        "select p.path, f.path folderPath, f.photo_count count from photos p join folders f on f.id=p.folder_id where p.path=?"
      )
      .all(target)
  ).toEqual([{ path: target, folderPath: path.dirname(target), count: 1 }]);
});

it("includes a watcher insert in the first scan result when the scan was preparing it", async () => {
  const changed = vi.fn();
  indexer.watchFolder(root, changed);
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "B/photo.jpg");
  fs.mkdirSync(path.dirname(target));
  fs.copyFileSync(oldPath, target);
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
  expect(result.photoIds).toHaveLength(2);
  expect(result.newPhotoIds).toHaveLength(0);
  expect(
    sqlite
      .prepare(
        "select p.path, f.path folderPath, f.photo_count count from photos p join folders f on f.id=p.folder_id where p.path=?"
      )
      .all(target)
  ).toEqual([{ path: target, folderPath: path.dirname(target), count: 1 }]);
});

it("retains the original ID for an offline edit of the folder layout", async () => {
  const originalId = await verifyFixtureFingerprint();
  sqlite.prepare("UPDATE photos SET is_favorite=1 WHERE id=?").run(originalId);
  sqlite.exec(`
    INSERT INTO tags(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO photo_tags(photo_id, tag_id) VALUES (${originalId}, 1);
    INSERT INTO albums(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO album_photos(photo_id, album_id) VALUES (${originalId}, 1);
    INSERT INTO face_vectors(photo_id, bbox_x, bbox_y, bbox_width, bbox_height, created_at)
      VALUES (${originalId}, 0, 0, 1, 1, 0);
    INSERT INTO cull_sessions(id, name, created_at) VALUES (1, 'kept', 0);
    INSERT INTO cull_session_photos(session_id, photo_id) VALUES (1, ${originalId});
  `);
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "renamed.jpg");
  fs.renameSync(oldPath, target);
  const result = await indexer.scanFolder(root);
  expect(result).toMatchObject({
    moved: 1,
    newPhotoIds: [],
    photoIds: [originalId],
  });
  expect(
    sqlite.prepare("SELECT id, path, is_favorite FROM photos").all()
  ).toEqual([{ id: originalId, path: target, is_favorite: 1 }]);
  for (const table of [
    "photo_tags",
    "album_photos",
    "face_vectors",
    "cull_session_photos",
  ]) {
    expect(sqlite.prepare(`SELECT photo_id FROM ${table}`).all()).toEqual([
      { photo_id: originalId },
    ]);
  }
});

it("imports a verified identical copy as a separate photo while the original still exists", async () => {
  const originalId = await verifyFixtureFingerprint();
  const target = path.join(root, "copy.jpg");
  fs.copyFileSync(path.join(root, "A/photo.jpg"), target);
  const result = await indexer.scanFolder(root);
  expect(result.moved).toBe(0);
  expect(result.newPhotoIds).toHaveLength(1);
  expect(result.newPhotoIds[0]).not.toBe(originalId);
  expect(result.photoIds).toHaveLength(2);
});

it.runIf(process.platform === "win32")(
  "accepts case-only spelling changes without replacing the photo ID",
  async () => {
    const originalId = await verifyFixtureFingerprint();
    const original = path.join(root, "A/photo.jpg");
    const target = path.join(root, "A/PHOTO.JPG");
    fs.renameSync(original, target);
    const result = await indexer.scanFolder(root);
    expect(result.newPhotoIds).toEqual([]);
    expect(result.photoIds).toEqual([originalId]);
    expect(
      sqlite.prepare("SELECT id, path, filename FROM photos").all()
    ).toEqual([{ id: originalId, path: target, filename: "PHOTO.JPG" }]);
  }
);

it("keeps recorded availability after an unexpectedly empty scan", async () => {
  const originalId = await verifyFixtureFingerprint();
  fs.renameSync(path.join(root, "A/photo.jpg"), path.join(root, "outside.bak"));
  const result = await indexer.scanFolder(root);
  expect(result.incomplete).toBe(true);
  expect(sqlite.prepare("SELECT id, source_status FROM photos").all()).toEqual([
    { id: originalId, source_status: "available" },
  ]);
  expect(
    sqlite
      .prepare("SELECT last_scan_result FROM folders WHERE path=?")
      .get(root)
  ).toEqual({
    last_scan_result: "empty",
  });
});

it("keeps a missing ID when more than one new path matches its fingerprint", async () => {
  const originalId = await verifyFixtureFingerprint();
  const oldPath = path.join(root, "A/photo.jpg");
  const target = path.join(root, "same.jpg");
  fs.copyFileSync(oldPath, target);
  fs.renameSync(oldPath, path.join(root, "renamed.jpg"));
  const result = await indexer.scanFolder(root);
  expect(result).toMatchObject({ moved: 0, newPhotoIds: [], missing: 1 });
  expect(
    sqlite.prepare("SELECT id, path, source_status FROM photos").all()
  ).toEqual([{ id: originalId, path: oldPath, source_status: "missing" }]);
});

it("defers a watcher move when another identical target exists before its add event arrives", async () => {
  const originalId = await verifyFixtureFingerprint();
  const changed = vi.fn();
  indexer.watchFolder(root, changed);
  const oldPath = path.join(root, "A/photo.jpg");
  const first = path.join(root, "first.jpg");
  const second = path.join(root, "second.jpg");
  fs.copyFileSync(oldPath, first);
  fs.renameSync(oldPath, second);
  state.watchers[0].emit("add", first);
  await vi.waitFor(() => expect(indexer.getWatcherStats().skipped).toBe(1));
  state.watchers[0].emit("add", second);
  await vi.waitFor(() => expect(indexer.getWatcherStats().skipped).toBe(2));
  expect(changed).not.toHaveBeenCalled();
  expect(sqlite.prepare("SELECT id, path FROM photos").all()).toEqual([
    { id: originalId, path: oldPath },
  ]);
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
