/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import { eq } from "drizzle-orm";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { closeDatabase, getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import { repairUnassignedLibraryPhotos } from "@/services/explicit-library-folders";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import {
  indexExplicitPhotoFiles,
  startWatching,
  stopWatching,
} from "@/services/indexer";
import { thumbnailSourceIdentity } from "@/services/thumbnail-identity";
import {
  generateThumbnail,
  initThumbnailer,
  stopThumbnailer,
} from "@/services/thumbnailer";
import { getFolderPaths, invalidateFoldersCache } from "@/utils/folder-paths";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ dataPath: "", watch: vi.fn() }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/ai-embedder", () => ({
  deletePhotoVectors: vi.fn(),
  deleteColorVectors: vi.fn(),
}));
vi.mock("@/services/background-file-watcher", () => ({
  createBackgroundWatcher: state.watch,
}));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: async () => "[]",
}));
vi.mock("@/services/dedup-service", () => ({
  checkNewPhotoDuplicates: vi.fn(),
}));
vi.mock("@/services/raw-preview", () => ({
  isRawFile: () => false,
  extractRawPreview: vi.fn(),
  readRawDimensions: vi.fn(),
}));

let runtime: TestRuntime;
let source: string;
const previousSharpCache = sharp.cache();
beforeEach(() => {
  sharp.cache(false);
  vi.clearAllMocks();
  runtime = new TestRuntime("explicit-library-folders");
  state.dataPath = path.join(runtime.root, "profile");
  source = path.join(runtime.root, "output", "选片结果");
  fs.mkdirSync(path.join(source, "子目录"), { recursive: true });
  vi.stubEnv("APPDATA", runtime.root);
  reloadFolderMatcher();
  invalidateFoldersCache();
});
afterEach(async () => {
  await stopWatching();
  await stopThumbnailer();
  closeDatabase();
  invalidateFoldersCache();
  vi.unstubAllEnvs();
  expect(runtime.cleanup().status).toBe("deleted");
  sharp.cache({
    memory: previousSharpCache.memory.max,
    files: previousSharpCache.files.max,
    items: previousSharpCache.items.max,
  });
});

it("indexes only confirmed files with their folder tree and skips watching them after restart", async () => {
  const file = path.join(source, "子目录", "入选.png");
  const sibling = path.join(source, "子目录", "未选.png");
  const bytes = await sharp({
    create: { width: 40, height: 20, channels: 3, background: "#227abc" },
  })
    .png()
    .toBuffer();
  fs.writeFileSync(file, bytes);
  fs.writeFileSync(sibling, bytes);
  const imported = await indexExplicitPhotoFiles([file], undefined, source);
  expect(imported).toMatchObject({ added: 1, failed: 0 });
  const db = getDatabase();
  const tree = db.select().from(folders).all();
  expect(tree).toHaveLength(2);
  const root = tree.find((f) => f.path === source);
  const child = tree.find((f) => f.path === path.dirname(file));
  expect(root).toMatchObject({ parentId: null, explicitOnly: true });
  expect(child).toMatchObject({
    parentId: root?.id,
    photoCount: 1,
    explicitOnly: true,
  });
  expect(db.select().from(photos).all()).toEqual([
    expect.objectContaining({
      path: file,
      folderId: child?.id,
      width: 40,
      height: 20,
    }),
  ]);
  expect(getFolderPaths()).toEqual([]);
  expect(await indexExplicitPhotoFiles([file], undefined, source)).toEqual({
    added: 0,
    failed: 0,
    photoIds: [],
  });
  closeDatabase();
  startWatching(() => undefined);
  expect(state.watch).not.toHaveBeenCalled();
  const queue = await import("@/services/import-queue");
  queue.resumeInterruptedImports();
  expect(queue.getImportQueueStatus()).toMatchObject({
    current: null,
    pending: [],
    history: [],
  });
  expect(getDatabase().select().from(photos).all()).toHaveLength(1);
  expect(fs.readFileSync(sibling)).toEqual(bytes);
});

it("repairs older unassigned imports once without scanning siblings or restoring deleted photos", () => {
  const db = getDatabase();
  const legacy = db
    .insert(photos)
    .values({ path: path.join(source, "入选.png"), filename: "入选.png" })
    .returning()
    .get();
  const deleted = db
    .insert(photos)
    .values({
      path: path.join(source, "已删除.png"),
      filename: "已删除.png",
      deletedAt: 1,
    })
    .returning()
    .get();
  expect(repairUnassignedLibraryPhotos()).toBe(1);
  const folder = db.select().from(folders).get();
  expect(folder).toMatchObject({
    path: source,
    photoCount: 1,
    explicitOnly: true,
  });
  expect(
    db.select().from(photos).where(eq(photos.id, legacy.id)).get()?.folderId
  ).toBe(folder?.id);
  expect(
    db.select().from(photos).where(eq(photos.id, deleted.id)).get()?.folderId
  ).toBeNull();
  expect(repairUnassignedLibraryPhotos()).toBe(0);
  expect(db.select().from(photos).all()).toHaveLength(2);
  expect(getFolderPaths()).toEqual([]);
  expect(state.watch).not.toHaveBeenCalled();
});

it("imports new pixels without replacing a moved photo's preview when source stats collide", async () => {
  const file = path.join(source, "reused.jpg");
  const moved = path.join(runtime.root, "moved.jpg");
  const images = await Promise.all(
    ["#ff0000", "#0000ff"].map((background) =>
      sharp({ create: { width: 64, height: 64, channels: 3, background } })
        .jpeg()
        .toBuffer()
    )
  );
  const length = Math.max(...images.map((image) => image.length));
  const padded = images.map((image) =>
    Buffer.concat([image, Buffer.alloc(length - image.length)])
  );
  fs.writeFileSync(file, padded[0]);
  const firstStat = await fs.promises.stat(file);
  const db = getDatabase();
  initThumbnailer();
  const first = await generateThumbnail(file);
  fs.renameSync(file, moved);
  const previous = db
    .insert(photos)
    .values({
      path: moved,
      filename: "moved.jpg",
      thumbnailPath: first.thumbnailPath,
      isFavorite: true,
    })
    .returning()
    .get();
  fs.writeFileSync(file, padded[1]);
  const stat = fs.promises.stat.bind(fs.promises);
  const fixed = vi
    .spyOn(fs.promises, "stat")
    .mockImplementation(async (target) => {
      const result = await stat(target);
      return String(target) === file
        ? Object.assign(result, {
            mtimeMs: firstStat.mtimeMs,
            ctimeMs: firstStat.ctimeMs,
          })
        : result;
    });
  try {
    expect(thumbnailSourceIdentity(await fs.promises.stat(file))).toBe(
      thumbnailSourceIdentity(firstStat)
    );
    expect(
      await indexExplicitPhotoFiles([file], undefined, source)
    ).toMatchObject({
      added: 1,
      failed: 0,
    });
    const imported = db
      .select()
      .from(photos)
      .where(eq(photos.path, file))
      .get();
    expect(imported?.thumbnailPath).toBeTruthy();
    expect(imported?.thumbnailPath).not.toBe(first.thumbnailPath);
    const pixels = await sharp(imported?.thumbnailPath ?? "")
      .raw()
      .toBuffer();
    expect(pixels[0]).toBeLessThan(15);
    expect(pixels[2]).toBeGreaterThan(240);
    expect(
      (await sharp(first.thumbnailPath).raw().toBuffer())[0]
    ).toBeGreaterThan(240);
    expect(
      db.select().from(photos).where(eq(photos.id, previous.id)).get()
    ).toMatchObject({
      path: moved,
      thumbnailPath: first.thumbnailPath,
      isFavorite: true,
    });
  } finally {
    fixed.mockRestore();
  }
});
