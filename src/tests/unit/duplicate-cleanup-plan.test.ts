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

const staleReviewError = /STALE_REVIEW/;

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
vi.mock("@/ipc/photos/handlers/stats", () => ({
  invalidateStatsCache: vi.fn(),
}));
vi.mock("@/services/photo-sequences", () => ({
  bumpPhotoSequenceRevision: vi.fn(),
  cleanupDeletedPhotoSequenceMembers: vi.fn(() => false),
}));
vi.mock("@/services/smart-album-engine", () => ({
  invalidateSmartAlbumCache: vi.fn(),
}));

import {
  duplicateCleanupPlans,
  duplicatePairs,
  duplicatePhotoFingerprints,
  duplicateReviewGroups,
  duplicateReviewMembers,
  folders,
  photos,
} from "@/db/schema";
import {
  createDuplicateCleanupPlan,
  executeDuplicateCleanupPlan,
  restoreDuplicateCleanupBatch,
} from "@/services/duplicate-cleanup-plan";
import { applyDuplicateKeepCount } from "@/services/duplicate-review";

describe("duplicate cleanup deletion plans", () => {
  let sqlite: Database.Database;
  let fixtureDir: string;

  beforeEach(() => {
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

  it("creates, executes, and restores a plan with multiple keepers", async () => {
    const plan = await createDuplicateCleanupPlan(
      {
        groups: [
          {
            deletePhotoIds: [3],
            groupKey: "exact:1-2-3",
            groupVersion: "review-version-1",
            keepPhotoIds: [1, 2],
            matchType: "exact",
            reviewRevision: 4,
          },
        ],
      },
      state.db ?? undefined
    );

    expect(plan.deleteCount).toBe(1);
    expect(plan.groups[0]?.keepPhotoIds).toEqual([1, 2]);
    const executed = await executeDuplicateCleanupPlan(
      { planId: plan.planId },
      state.db ?? undefined
    );
    expect(executed.deletedCount).toBe(1);
    expect(executed.alreadyExecuted).toBe(false);
    expect(
      state.db?.select({ deletedAt: photos.deletedAt }).from(photos).all()
    ).toEqual([
      { deletedAt: null },
      { deletedAt: null },
      { deletedAt: expect.any(Number) },
    ]);

    const repeated = await executeDuplicateCleanupPlan(
      { planId: plan.planId },
      state.db ?? undefined
    );
    expect(repeated.alreadyExecuted).toBe(true);
    expect(repeated.batchId).toBe(executed.batchId);

    const restored = await restoreDuplicateCleanupBatch(
      { batchId: executed.batchId },
      state.db ?? undefined
    );
    expect(restored.restoredIds).toEqual([3]);
    expect(
      state.db
        ?.select({ deletedAt: photos.deletedAt })
        .from(photos)
        .where(eq(photos.id, 3))
        .get()?.deletedAt
    ).toBeNull();
    expect(
      state.db
        ?.select({
          decision: duplicateReviewMembers.decision,
          needsReview: duplicateReviewMembers.needsReview,
        })
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.photoId, 3))
        .get()
    ).toEqual({ decision: "UNDECIDED", needsReview: true });
  });

  it("applies a keep count to every member, including members not loaded by the UI", () => {
    const review = applyDuplicateKeepCount(getTestDb(), {
      count: 2,
      expectedReviewRevision: 4,
      groupKey: "exact:1-2-3",
      groupVersion: "review-version-1",
    });
    expect(
      review.members.map((member) => [member.photoId, member.decision])
    ).toEqual([
      [1, "KEEP"],
      [2, "KEEP"],
      [3, "DELETE"],
    ]);
    expect(review.complete).toBe(true);
  });

  it("does not restore a later deletion through an older cleanup batch", async () => {
    const plan = await createDuplicateCleanupPlan(
      {
        groups: [
          {
            deletePhotoIds: [3],
            groupKey: "exact:1-2-3",
            groupVersion: "review-version-1",
            keepPhotoIds: [1, 2],
            matchType: "exact",
            reviewRevision: 4,
          },
        ],
      },
      state.db ?? undefined
    );
    const executed = await executeDuplicateCleanupPlan(
      { planId: plan.planId },
      state.db ?? undefined
    );
    state.db
      ?.update(photos)
      .set({ deletionBatchId: null, deletedAt: Date.now() })
      .where(eq(photos.id, 3))
      .run();

    const restored = await restoreDuplicateCleanupBatch(
      { batchId: executed.batchId },
      state.db ?? undefined
    );
    expect(restored.restoredIds).toEqual([]);
    expect(restored.failed).toEqual([
      {
        id: 3,
        filename: "c.jpg",
        message: "Photo was deleted by a different batch",
      },
    ]);
    expect(
      state.db
        ?.select({ deletedAt: photos.deletedAt })
        .from(photos)
        .where(eq(photos.id, 3))
        .get()?.deletedAt
    ).toEqual(expect.any(Number));
  });

  it("reports a missing original and allows a later retry", async () => {
    const plan = await createDuplicateCleanupPlan(
      {
        groups: [
          {
            deletePhotoIds: [3],
            groupKey: "exact:1-2-3",
            groupVersion: "review-version-1",
            keepPhotoIds: [1, 2],
            matchType: "exact",
            reviewRevision: 4,
          },
        ],
      },
      getTestDb()
    );
    const executed = await executeDuplicateCleanupPlan(
      { planId: plan.planId },
      getTestDb()
    );
    const original = path.join(fixtureDir, "c.jpg");
    const parked = path.join(fixtureDir, "parked.jpg");
    fs.renameSync(original, parked);
    try {
      const result = restoreDuplicateCleanupBatch(
        { batchId: executed.batchId },
        getTestDb()
      );
      expect(result.status).toBe("RESTORE_PARTIAL");
      expect(result.failed).toEqual([
        { id: 3, filename: "c.jpg", message: "Original file no longer exists" },
      ]);
      expect(result.restoredIds).toEqual([]);
    } finally {
      fs.renameSync(parked, original);
    }
    const retry = restoreDuplicateCleanupBatch(
      { batchId: executed.batchId },
      getTestDb()
    );
    expect(retry.failed).toEqual([]);
    expect(retry.restoredIds).toEqual([3]);
  });
  it("rejects a keep count outside the group bounds", () => {
    expect(() =>
      applyDuplicateKeepCount(getTestDb(), {
        count: 0,
        expectedReviewRevision: 4,
        groupKey: "exact:1-2-3",
        groupVersion: "review-version-1",
      })
    ).toThrow("Keep count must be between 1 and the group size");
    expect(() =>
      applyDuplicateKeepCount(getTestDb(), {
        count: 4,
        expectedReviewRevision: 4,
        groupKey: "exact:1-2-3",
        groupVersion: "review-version-1",
      })
    ).toThrow("Keep count must be between 1 and the group size");
  });

  it("rejects a file changed after review before creating the plan", async () => {
    const filePath = path.join(fixtureDir, "c.jpg");
    fs.writeFileSync(filePath, "changed-after-review");
    await expect(
      createDuplicateCleanupPlan(
        {
          groups: [
            {
              deletePhotoIds: [3],
              groupKey: "exact:1-2-3",
              groupVersion: "review-version-1",
              keepPhotoIds: [1, 2],
              matchType: "exact",
              reviewRevision: 4,
            },
          ],
        },
        state.db ?? undefined
      )
    ).rejects.toThrow(staleReviewError);
    expect(
      state.db
        ?.select({ status: duplicateCleanupPlans.status })
        .from(duplicateCleanupPlans)
        .all()
    ).toEqual([]);
  });
});
