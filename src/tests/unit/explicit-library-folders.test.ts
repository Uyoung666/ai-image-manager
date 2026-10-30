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
import { stopThumbnailer } from "@/services/thumbnailer";
import { getFolderPaths, invalidateFoldersCache } from "@/utils/folder-paths";
import { TestRuntime } from "../helpers/test-runtime";

const state = vi.hoisted(() => ({ dataPath: "", watch: vi.fn() }));
vi.mock("@/utils/data-path", () => ({ getDataPath: () => state.dataPath }));
vi.mock("@/services/ai-embedder", () => ({ deletePhotoVectors: vi.fn() }));
vi.mock("@/services/background-file-watcher", () => ({
  createBackgroundWatcher: state.watch,
}));
vi.mock("@/services/color-extractor", () => ({
  extractDominantColors: async () => [],
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
beforeEach(() => {
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
