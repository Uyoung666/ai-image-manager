/** @vitest-environment node */
import { call } from "@orpc/server";
import { dismissDuplicates, findDuplicates } from "@/ipc/photos/handlers/stats";
import { updateDuplicateReviewState } from "@/services/duplicate-review";
import { cancelDuplicateScan } from "@/services/duplicate-scan-runtime";
import { computeFullFileHash } from "@/services/file-hash";

vi.mock("@/services/file-hash", async (original) => {
  const actual = await original<typeof import("@/services/file-hash")>();
  return { ...actual, computeFullFileHash: vi.fn(actual.computeFullFileHash) };
});

import { setSetting } from "@/services/settings-manager";

const vectors = vi.hoisted(() => ({
  read: vi.fn(() => Promise.resolve(new Map<number, number[]>())),
  revision: vi.fn(() => Promise.resolve("vectors:1")),
}));
vi.mock("@/services/ai-embedder", () => ({ getPhotoVectors: vectors.read }));
vi.mock("@/services/ai/vector-db", () => ({
  getDuplicateVectorRevision: vectors.revision,
}));

/** @vitest-environment node */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  db: null as ReturnType<typeof drizzle> | null,
}));

function getTestDb() {
  if (!state.db) {
    throw new Error("test database is not initialized");
  }
  return state.db;
}

vi.mock("@/db", () => ({
  getDatabase: () => {
    if (!state.db) {
      throw new Error("test database is not initialized");
    }
    return state.db;
  },
}));
vi.mock("@/ipc/photos/handlers/listing", () => ({
  invalidateCountCache: vi.fn(),
}));

vi.mock("@/services/photo-sequences", () => ({
  notifySequencesChanged: vi.fn(),
  bumpPhotoSequenceRevision: vi.fn(),
  getPhotoSequenceRevision: () => 0,
  cleanupDeletedPhotoSequenceMembers: vi.fn(() => false),
}));
vi.mock("@/services/smart-album-engine", () => ({
  invalidateSmartAlbumCache: vi.fn(),
}));

import {
  duplicatePairs,
  duplicatePhotoFingerprints,
  duplicateReviewGroups,
  duplicateReviewMembers,
  folders,
  photos,
} from "@/db/schema";
import { applyDuplicateKeepCount } from "@/services/duplicate-review";

describe("duplicate cleanup deletion plans", () => {
  let sqlite: Database.Database;
  let fixtureDir: string;

  beforeEach(() => {
    vectors.read.mockReset().mockResolvedValue(new Map());
    vectors.revision.mockReset().mockResolvedValue("vectors:1");
    sqlite = new Database(":memory:");
    state.db = drizzle(sqlite);
    migrate(state.db, { migrationsFolder: "drizzle" });
    fixtureDir = path.join(
      process.cwd(),
      ".cache",
      `duplicate-cleanup-plan-${crypto.randomUUID()}`
    );
    fs.mkdirSync(fixtureDir, { recursive: true });

    state.db
      .insert(folders)
      .values({ displayName: "Fixtures", path: fixtureDir, photoCount: 3 })
      .run();
    const folder = state.db.select().from(folders).get();
    if (!folder) {
      throw new Error("fixture folder was not created");
    }
    const files = ["a.jpg", "b.jpg", "c.jpg"].map((name) => {
      const filePath = path.join(fixtureDir, name);
      fs.writeFileSync(filePath, Buffer.from("duplicate-fixture"));
      const stat = fs.statSync(filePath);
      const fullSha256 = crypto
        .createHash("sha256")
        .update(fs.readFileSync(filePath))
        .digest("hex");
      return { filePath, fullSha256, stat };
    });
    const photoRows = files.map(({ filePath, stat }, index) => ({
      createdAt: 100,
      fileDate: 100,
      fileSize: stat.size,
      filename: path.basename(filePath),
      folderId: folder.id,
      height: 100,
      id: index + 1,
      path: filePath,
      width: 100,
    }));
    state.db.insert(photos).values(photoRows).run();
    state.db
      .insert(duplicatePairs)
      .values([
        { matchType: "exact", photoAId: 1, photoBId: 2, status: "confirmed" },
        { matchType: "exact", photoAId: 1, photoBId: 3, status: "confirmed" },
      ])
      .run();
    state.db
      .insert(duplicateReviewGroups)
      .values({
        complete: true,
        groupKey: "exact:1-2-3",
        groupVersion: "review-version-1",
        ignoreState: "ACTIVE",
        memberIdsJson: "[1,2,3]",
        needsReview: false,
        reviewRevision: 4,
      })
      .run();
    state.db
      .insert(duplicateReviewMembers)
      .values([
        {
          contentRevision: 1,
          decision: "KEEP",
          groupKey: "exact:1-2-3",
          needsReview: false,
          photoId: 1,
        },
        {
          contentRevision: 1,
          decision: "KEEP",
          groupKey: "exact:1-2-3",
          needsReview: false,
          photoId: 2,
        },
        {
          contentRevision: 1,
          decision: "DELETE",
          groupKey: "exact:1-2-3",
          needsReview: false,
          photoId: 3,
        },
      ])
      .run();
    state.db
      .insert(duplicatePhotoFingerprints)
      .values(
        files.map(({ filePath, fullSha256, stat }, index) => ({
          contentRevision: 1,
          fileSize: stat.size,
          fullSha256,
          hashVersion: "sha256-full-v1",
          modifiedAt: stat.mtimeMs,
          path: filePath,
          photoId: index + 1,
          sampleHash: fullSha256,
          verifiedAt: Date.now(),
        }))
      )
      .run();
  });

  afterEach(() => {
    state.db = null;
    sqlite?.close();
  });

  function makeSimilar() {
    for (const row of getTestDb().select().from(photos).all()) {
      fs.writeFileSync(row.path, Buffer.from(`distinct-image-${row.id}`));
      getTestDb()
        .update(photos)
        .set({ phash: "0000000000000000" })
        .where(eq(photos.id, row.id))
        .run();
    }
  }
  it("includes reframed candidates only when AI confirms similarity", async () => {
    makeSimilar();
    const hashes = ["5d0dbb65c6836063", "5d0db945e6e36062", "0b2df3648ef36062"];
    hashes.forEach((phash, index) => {
      getTestDb()
        .update(photos)
        .set({ phash })
        .where(eq(photos.id, index + 1))
        .run();
    });
    vectors.read.mockResolvedValue(
      new Map([
        [1, [1, 0]],
        [2, [1, 0]],
        [3, [0.965, Math.sqrt(1 - 0.965 ** 2)]],
      ])
    );
    const result = await call(findDuplicates, { forceRescan: true });
    expect(result.groups[0].photoCount).toBe(3);
    vectors.read.mockResolvedValue(
      new Map([
        [1, [1, 0]],
        [2, [1, 0]],
        [3, [0, 1]],
      ])
    );
    const rejected = await call(findDuplicates, { forceRescan: true });
    expect(rejected.groups[0].photoCount).toBe(2);
    vectors.read.mockResolvedValue(new Map());
    const noAI = await call(findDuplicates, { forceRescan: true });
    expect(noAI.groups[0].photoCount).toBe(2);
  });
  it("restores ignored groups and preserves their saved decisions", async () => {
    makeSimilar();
    const result = await call(findDuplicates, { forceRescan: true });
    const group = result.groups[0];
    applyDuplicateKeepCount(getTestDb(), {
      count: 1,
      expectedReviewRevision: group.reviewRevision ?? -1,
      groupKey: group.groupKey,
      groupVersion: group.groupVersion ?? "",
    });
    await call(dismissDuplicates, {
      groupKey: group.groupKey,
      dismissed: true,
    });
    await call(dismissDuplicates, {
      groupKey: group.groupKey,
      dismissed: false,
    });
    const refreshed = await call(findDuplicates, { forceRescan: false });
    expect(refreshed.groups[0].status).toBe("active");
    expect(refreshed.groups[0].reviewDecisions).toEqual({
      1: "KEEP",
      2: "DELETE",
      3: "DELETE",
    });
  });
  it("preserves saved decisions when unchanged similar files are rescanned", async () => {
    makeSimilar();
    const first = await call(findDuplicates, { forceRescan: true });
    const g = first.groups[0];
    applyDuplicateKeepCount(getTestDb(), {
      count: 1,
      expectedReviewRevision: g.reviewRevision ?? -1,
      groupKey: g.groupKey,
      groupVersion: g.groupVersion ?? "",
    });
    const second = await call(findDuplicates, { forceRescan: true });
    expect(second.groups[0].reviewDecisions).toEqual({
      1: "KEEP",
      2: "DELETE",
      3: "DELETE",
    });
    expect(second.groups[0].reviewNeedsReview).toBe(false);
  });
  it("preserves ignore after importing an unrelated photo", async () => {
    const first = await call(findDuplicates, { forceRescan: true });
    await call(dismissDuplicates, { groupKey: first.groups[0].groupKey });
    const file = path.join(fixtureDir, "unrelated.jpg");
    fs.writeFileSync(file, "unrelated");
    getTestDb()
      .insert(photos)
      .values({ path: file, filename: "unrelated.jpg", fileSize: 9 })
      .run();
    const second = await call(findDuplicates, { forceRescan: true });
    expect(second.groups[0].status).toBe("dismissed");
  });
  it("keeps old results when settings change during verification", async () => {
    const before = getTestDb().select().from(duplicatePairs).all();
    vectors.read.mockImplementationOnce(() => {
      setSetting("duplicates.settingsRevision", "2");
      return Promise.resolve(new Map());
    });
    await expect(call(findDuplicates, { forceRescan: true })).rejects.toThrow(
      "STALE_RUN"
    );
    expect(getTestDb().select().from(duplicatePairs).all()).toEqual(before);
  });
  it("coalesces identical requests", async () => {
    const [a, b] = await Promise.all([
      call(findDuplicates, { forceRescan: true }),
      call(findDuplicates, { forceRescan: true }),
    ]);
    expect(a.runId).toBe(b.runId);
    expect(vectors.read).toHaveBeenCalledTimes(1);
  });
  it("cancels without publishing partial results", async () => {
    const before = getTestDb().select().from(duplicatePairs).all();
    vectors.read.mockImplementationOnce(() => {
      cancelDuplicateScan();
      return Promise.resolve(new Map());
    });
    await expect(call(findDuplicates, { forceRescan: true })).rejects.toThrow(
      "SCAN_CANCELLED"
    );
    expect(getTestDb().select().from(duplicatePairs).all()).toEqual(before);
  });
  it("rolls back pairs and fingerprints when snapshot publication fails", async () => {
    const before = getTestDb().select().from(duplicatePairs).all();
    const fingerprints = getTestDb()
      .select()
      .from(duplicatePhotoFingerprints)
      .all();
    sqlite.exec(
      "CREATE TRIGGER fail_snapshot BEFORE INSERT ON duplicate_run_groups BEGIN SELECT RAISE(ABORT, 'snapshot failed'); END"
    );
    await expect(call(findDuplicates, { forceRescan: true })).rejects.toThrow(
      "snapshot failed"
    );
    expect(getTestDb().select().from(duplicatePairs).all()).toEqual(before);
    expect(getTestDb().select().from(duplicatePhotoFingerprints).all()).toEqual(
      fingerprints
    );
  });
  it("reuses verified hashes on cache hits and invalidates on vector revision", async () => {
    await call(findDuplicates, { forceRescan: true });
    const hash = vi.mocked(computeFullFileHash);
    hash.mockClear();
    const cached = await call(findDuplicates, { forceRescan: false });
    expect(cached.fromCache).toBe(true);
    expect(hash).not.toHaveBeenCalled();
    vectors.revision.mockResolvedValue("vectors:2");
    const changed = await call(findDuplicates, { forceRescan: false });
    expect(changed.fromCache).toBe(false);
    expect(hash).toHaveBeenCalled();
    hash.mockClear();
  });
  it("saves incomplete review without authorizing cleanup", async () => {
    const first = await call(findDuplicates, { forceRescan: true });
    const g = first.groups[0];
    const saved = updateDuplicateReviewState(getTestDb(), {
      groupKey: g.groupKey,
      groupVersion: g.groupVersion ?? "",
      expectedReviewRevision: g.reviewRevision ?? -1,
      decisions: [
        { photoId: 1, decision: "DELETE" },
        { photoId: 2, decision: "UNDECIDED" },
        { photoId: 3, decision: "UNDECIDED" },
      ],
    });
    expect(saved.complete).toBe(false);
    expect(saved.members[0].decision).toBe("DELETE");
    const second = await call(findDuplicates, { forceRescan: false });
    expect(second.groups[0].reviewDecisions?.[1]).toBe("DELETE");
  });
});
