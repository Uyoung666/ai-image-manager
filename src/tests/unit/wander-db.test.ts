/**
 * @vitest-environment node
 *
 * DB-backed tests for the Wander curation service: the three curation modes,
 * the fallback chain, exposure upserts, and session-to-album saving.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const TEST_DATA_DIR = path.join(os.tmpdir(), "ai-image-manager-test-wander");
const TEST_PHOTO_DIR = path.join(TEST_DATA_DIR, "photo-fixtures");

vi.mock("electron", () => ({
  app: {
    getPath(name: string): string {
      return name === "userData" ? TEST_DATA_DIR : TEST_DATA_DIR;
    },
    isPackaged: false,
    getAppPath(): string {
      return process.cwd();
    },
    whenReady(): Promise<void> {
      return Promise.resolve();
    },
    on(_event: string, _cb: (...args: unknown[]) => void): void {
      return;
    },
    exit(_code?: number): void {
      return;
    },
  },
  screen: {
    getPrimaryDisplay(): { scaleFactor: number } {
      return { scaleFactor: 1 };
    },
  },
  BrowserWindow: class {},
  Tray: class {},
  Menu: { buildFromTemplate: () => [] },
  nativeImage: { createFromBuffer: () => ({}) },
  ipcMain: { on: () => undefined },
  protocol: {
    registerSchemesAsPrivileged: () => undefined,
    handle: () => undefined,
  },
  globalShortcut: {
    register: () => true,
    unregisterAll: () => undefined,
  },
}));

vi.mock("electron-store", () => ({
  default: class {
    private data = new Map<string, unknown>();
    get(key: string, defaultValue: unknown): unknown {
      return this.data.get(key) ?? defaultValue;
    }
    set(key: string, value: unknown): void {
      this.data.set(key, value);
    }
  },
}));

import { closeDatabase, getDatabase, initDatabase } from "@/db";
import {
  albumPhotos,
  albums,
  exifData,
  photos,
  photoTags,
  photoViewStats,
  tags,
} from "@/db/schema";
import {
  curateRediscovery,
  curateTheme,
  curateTimeCapsule,
  getCuratedWanderSession,
  recordExposure,
  saveSessionToAlbum,
} from "@/ipc/wander/service";

function setupTestDirs(): void {
  for (const d of [TEST_DATA_DIR, TEST_PHOTO_DIR]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
}

function cleanupTestDirs(): void {
  if (fs.existsSync(TEST_DATA_DIR)) {
    fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  }
}

// Local-noon epoch so day grouping never crosses midnight/DST boundaries.
function dayMs(year: number, month: number, day: number): number {
  return new Date(year, month - 1, day, 12, 0, 0).getTime();
}

let seq = 0;

function insertPhoto(
  opts: {
    dateTaken?: number;
    deletedAt?: number | null;
    favorite?: boolean;
    fileDate?: number;
    height?: number;
    width?: number;
  } = {}
): number {
  seq += 1;
  const dir = path.join(TEST_PHOTO_DIR, `p${seq}`);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `photo-${seq}.jpg`);
  fs.writeFileSync(filePath, "placeholder");
  const db = getDatabase();
  const row = db
    .insert(photos)
    .values({
      path: filePath,
      filename: `photo-${seq}.jpg`,
      fileSize: 1,
      fileDate: opts.fileDate ?? null,
      width: opts.width ?? 1200,
      height: opts.height ?? 800,
      format: "jpg",
      isFavorite: opts.favorite ?? false,
      deletedAt: opts.deletedAt ?? null,
    })
    .returning({ id: photos.id })
    .get();
  if (opts.dateTaken != null) {
    db.insert(exifData)
      .values({ photoId: row.id, dateTaken: opts.dateTaken })
      .run();
  }
  return row.id;
}

function insertTag(
  name: string,
  links: Array<{
    confidence?: number | null;
    origin?: "manual" | "auto";
    photoId: number;
    userConfirmed?: boolean;
  }>
): number {
  const db = getDatabase();
  const tag = db.insert(tags).values({ name }).returning({ id: tags.id }).get();
  for (const link of links) {
    db.insert(photoTags)
      .values({
        photoId: link.photoId,
        tagId: tag.id,
        origin: link.origin ?? "manual",
        confidence: link.confidence ?? null,
        userConfirmed: link.userConfirmed ?? false,
      })
      .run();
  }
  return tag.id;
}

function insertViewStat(
  photoId: number,
  opts: {
    lastViewedAt?: number | null;
    lastWanderedAt?: number | null;
    viewCount?: number;
    wanderShownCount?: number;
  }
): void {
  getDatabase()
    .insert(photoViewStats)
    .values({
      photoId,
      viewCount: opts.viewCount ?? 0,
      lastViewedAt: opts.lastViewedAt ?? null,
      wanderShownCount: opts.wanderShownCount ?? 0,
      lastWanderedAt: opts.lastWanderedAt ?? null,
    })
    .run();
}

beforeAll(() => {
  cleanupTestDirs();
  setupTestDirs();
  initDatabase();
});

afterAll(() => {
  // Windows: the SQLite handle must be closed before the temp dir is removed.
  closeDatabase();
  cleanupTestDirs();
});

beforeEach(() => {
  const db = getDatabase();
  db.delete(albumPhotos).run();
  db.delete(albums).run();
  db.delete(photoViewStats).run();
  db.delete(photoTags).run();
  db.delete(tags).run();
  db.delete(exifData).run();
  db.delete(photos).run();
});

describe("curateTimeCapsule", () => {
  it("returns photos from the same month/day in prior years when at least four exist", () => {
    const now = new Date();
    const prior = dayMs(
      now.getFullYear() - 3,
      now.getMonth() + 1,
      now.getDate()
    );
    const ids = Array.from({ length: 4 }, () =>
      insertPhoto({ dateTaken: prior })
    );

    const result = curateTimeCapsule();

    expect(result.mode).toBe("timeCapsule");
    expect(result.titleKey).toBe("wander.title.timeCapsuleToday");
    expect(result.photos.length).toBeGreaterThanOrEqual(4);
    const resultIds = new Set(result.photos.map((photo) => photo.id));
    expect(ids.every((id) => resultIds.has(id))).toBe(true);
  });

  it("falls back to a random historical capture day when today has fewer than four", () => {
    const anchor = dayMs(2023, 5, 15);
    const a1 = insertPhoto({ dateTaken: anchor });
    const a2 = insertPhoto({ dateTaken: anchor });

    const result = curateTimeCapsule();

    expect(result.mode).toBe("timeCapsule");
    expect(result.titleKey).toBe("wander.title.timeCapsuleDate");
    expect(new Set(result.photos.map((photo) => photo.id))).toEqual(
      new Set([a1, a2])
    );
  });

  it("expands the chosen historical day by ±3 days", () => {
    const anchor = dayMs(2023, 5, 15);
    const before = dayMs(2023, 5, 12);
    const after = dayMs(2023, 5, 18);
    insertPhoto({ dateTaken: anchor });
    insertPhoto({ dateTaken: anchor });
    insertPhoto({ dateTaken: before });
    insertPhoto({ dateTaken: after });

    const result = curateTimeCapsule();

    expect(result.titleKey).toBe("wander.title.timeCapsuleDate");
    expect(result.photos).toHaveLength(4);
  });

  it("uses fileDate when EXIF dateTaken is absent", () => {
    const now = new Date();
    const prior = dayMs(
      now.getFullYear() - 3,
      now.getMonth() + 1,
      now.getDate()
    );
    const ids = Array.from({ length: 4 }, () =>
      insertPhoto({ fileDate: prior })
    );

    const result = curateTimeCapsule();

    expect(result.titleKey).toBe("wander.title.timeCapsuleToday");
    expect(result.photos.length).toBeGreaterThanOrEqual(4);
    expect(
      ids.every((id) => result.photos.some((photo) => photo.id === id))
    ).toBe(true);
  });
});

describe("curateTheme", () => {
  it("selects a tag backed by at least four trusted photos", () => {
    const photoIds = Array.from({ length: 4 }, () => insertPhoto());
    insertTag(
      "Beach",
      photoIds.map((photoId) => ({ photoId, origin: "manual" }))
    );

    const result = curateTheme();

    expect(result.mode).toBe("theme");
    expect(result.titleParams?.theme).toBe("Beach");
    expect(result.photos.length).toBeGreaterThanOrEqual(4);
  });

  it("ignores tags with fewer than four photos", () => {
    const photoIds = Array.from({ length: 3 }, () => insertPhoto());
    insertTag(
      "Solo",
      photoIds.map((photoId) => ({ photoId, origin: "manual" }))
    );

    const result = curateTheme();

    expect(result.mode).toBe("theme");
    expect(result.photos).toHaveLength(0);
  });

  it("ignores auto tags below the trusted confidence floor but keeps those above it", () => {
    const lowPhotos = Array.from({ length: 4 }, () => insertPhoto());
    insertTag(
      "LowConfidence",
      lowPhotos.map((photoId) => ({
        photoId,
        origin: "auto",
        confidence: 0.2,
      }))
    );
    expect(curateTheme().photos).toHaveLength(0);

    const trustedPhotos = Array.from({ length: 4 }, () => insertPhoto());
    insertTag(
      "TrustedAuto",
      trustedPhotos.map((photoId) => ({
        photoId,
        origin: "auto",
        confidence: 0.7,
      }))
    );
    expect(curateTheme().titleParams?.theme).toBe("TrustedAuto");
  });

  it("prefers tags with manual provenance over auto-only tags", () => {
    const manualPhotos = Array.from({ length: 4 }, () => insertPhoto());
    const autoPhotos = Array.from({ length: 4 }, () => insertPhoto());
    insertTag(
      "ManualTag",
      manualPhotos.map((photoId) => ({ photoId, origin: "manual" }))
    );
    insertTag(
      "AutoTag",
      autoPhotos.map((photoId) => ({
        photoId,
        origin: "auto",
        confidence: 0.7,
      }))
    );

    const result = curateTheme();

    expect(result.titleParams?.theme).toBe("ManualTag");
  });
});

describe("curateRediscovery", () => {
  it("puts never-viewed photos ahead of viewed ones", () => {
    const neverViewed = insertPhoto();
    const viewed = insertPhoto();
    insertViewStat(viewed, { viewCount: 5, lastViewedAt: 100 });

    const result = curateRediscovery();

    expect(result.photos[0]?.id).toBe(neverViewed);
  });

  it("puts least-recently-viewed photos next", () => {
    const neverViewed = insertPhoto();
    const older = insertPhoto();
    insertViewStat(older, { viewCount: 1, lastViewedAt: 100 });
    const newer = insertPhoto();
    insertViewStat(newer, { viewCount: 1, lastViewedAt: 200 });

    const ids = curateRediscovery().photos.map((photo) => photo.id);

    expect(ids[0]).toBe(neverViewed);
    expect(ids.indexOf(older)).toBeLessThan(ids.indexOf(newer));
  });

  it("deprioritizes photos wandered within the last 30 days", () => {
    const recent = Date.now() - 24 * 60 * 60 * 1000;
    const first = insertPhoto();
    const second = insertPhoto();
    const recentlyWandered = insertPhoto();
    insertViewStat(recentlyWandered, {
      wanderShownCount: 3,
      lastWanderedAt: recent,
    });

    const ids = curateRediscovery().photos.map((photo) => photo.id);

    expect(ids.slice(0, 2).sort()).toEqual([first, second].sort());
    expect(ids[2]).toBe(recentlyWandered);
  });

  it("excludes deleted or unmeasured photos", () => {
    const deleted = insertPhoto({ deletedAt: Date.now() });
    const unmeasured = insertPhoto({ width: 0, height: 0 });
    const valid = insertPhoto();

    const ids = curateRediscovery().photos.map((photo) => photo.id);

    expect(ids).toContain(valid);
    expect(ids).not.toContain(deleted);
    expect(ids).not.toContain(unmeasured);
  });
});

describe("getCuratedWanderSession fallback chain", () => {
  it("falls back to rediscovery when the requested mode yields fewer than two photos", () => {
    const tagPhoto = insertPhoto();
    insertTag("LonelyTag", [{ photoId: tagPhoto, origin: "manual" }]);
    insertPhoto();
    insertPhoto();

    const result = getCuratedWanderSession({ mode: "theme", limit: 8 });

    expect(result.mode).toBe("rediscovery");
    expect(result.photos.length).toBeGreaterThanOrEqual(2);
  });

  it("returns an empty session for an empty library", () => {
    const result = getCuratedWanderSession({ mode: "auto", limit: 8 });

    expect(result.photos).toHaveLength(0);
  });
});

describe("recordExposure", () => {
  it("upserts independent lightbox and wander counters for one photo", () => {
    const photoId = insertPhoto();

    recordExposure(photoId, "lightbox");
    recordExposure(photoId, "lightbox");
    recordExposure(photoId, "wander");

    const row = getDatabase()
      .select()
      .from(photoViewStats)
      .where(eq(photoViewStats.photoId, photoId))
      .get();
    expect(row).toBeDefined();
    expect(row?.viewCount).toBe(2);
    expect(row?.wanderShownCount).toBe(1);
    expect(row?.lastViewedAt ?? 0).toBeGreaterThan(0);
    expect(row?.lastWanderedAt ?? 0).toBeGreaterThan(0);
  });
});

describe("saveSessionToAlbum", () => {
  it("creates an album and links photos in sort order", () => {
    const a = insertPhoto();
    const b = insertPhoto();
    const c = insertPhoto();

    const albumId = saveSessionToAlbum("Wander Picks", [a, b, c]);

    const album = getDatabase()
      .select()
      .from(albums)
      .where(eq(albums.id, albumId))
      .get();
    expect(album?.name).toBe("Wander Picks");
    expect(album?.isSmart).toBe(false);
    expect(album?.coverPhotoId).toBe(a);

    const links = getDatabase()
      .select()
      .from(albumPhotos)
      .where(eq(albumPhotos.albumId, albumId))
      .orderBy(albumPhotos.sortOrder)
      .all();
    expect(links.map((link) => link.photoId)).toEqual([a, b, c]);
  });

  it("throws and creates no album when a photo is unavailable", () => {
    const available = insertPhoto();

    expect(() => saveSessionToAlbum("Broken", [available, 999_999])).toThrow();
    expect(getDatabase().select().from(albums).all()).toHaveLength(0);
  });
});
