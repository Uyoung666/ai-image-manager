import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  duplicateCleanupEvents,
  duplicateCleanupPlanItems,
  duplicateCleanupPlans,
  duplicateDetectionRuns,
  duplicatePairs,
  duplicatePhotoFingerprints,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateReviewMembers,
  folders,
  photoSequenceMembers,
  photos,
} from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateStatsCache } from "@/ipc/photos/handlers/stats";
import {
  type DuplicatePairRecord,
  groupDuplicatePairs,
} from "@/services/duplicate-groups";
import { hasActiveDuplicateScan } from "@/services/duplicate-scan-runtime";
import { computeFullFileHash, filesHaveSameBytes } from "@/services/file-hash";
import {
  cleanupDeletedPhotoSequenceMembers,
  notifySequencesChanged,
} from "@/services/photo-sequences";
import { getSetting } from "@/services/settings-manager";
import { invalidateSmartAlbumCache } from "@/services/smart-album-engine";

export const DUPLICATE_CLEANUP_PLAN_TTL_MS = 10 * 60 * 1000;
export const DUPLICATE_SCAN_LEASE_MS = 30 * 60 * 1000;

export function listDuplicateCleanupBatches(db = getDatabase()) {
  const plans = db
    .select()
    .from(duplicateCleanupPlans)
    .where(
      inArray(duplicateCleanupPlans.status, ["EXECUTED", "RESTORE_PARTIAL"])
    )
    .orderBy(desc(duplicateCleanupPlans.executedAt))
    .all();
  return plans.flatMap((plan) => {
    if (!plan.batchId) {
      return [];
    }
    const pending = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        and(
          eq(photos.deletionBatchId, plan.batchId),
          sql`${photos.deletedAt} IS NOT NULL`
        )
      )
      .all();
    if (pending.length === 0) {
      return [];
    }
    return [
      {
        batchId: plan.batchId,
        executedAt: plan.executedAt ?? plan.createdAt,
        remainingCount: pending.length,
      },
    ];
  });
}

export type DuplicateCleanupPlanStatus =
  | "READY"
  | "EXECUTED"
  | "EXPIRED"
  | "STALE"
  | "RESTORED"
  | "RESTORE_PARTIAL";

export class DuplicateCleanupPlanError extends Error {
  readonly code:
    | "INVALID_SELECTION"
    | "STALE_GROUP"
    | "STALE_REVIEW"
    | "UNDECIDED_MEMBERS"
    | "NO_KEEPER"
    | "FILE_CHANGED"
    | "SOURCE_MISSING"
    | "PLAN_EXPIRED"
    | "PLAN_NOT_READY"
    | "PLAN_NOT_FOUND"
    | "RESTORE_FAILED";

  constructor(code: DuplicateCleanupPlanError["code"], message: string) {
    super(`${code}: ${message}`);
    this.name = "DuplicateCleanupPlanError";
    this.code = code;
  }
}

function assertNoDuplicateScanRunning(
  db: ReturnType<typeof getDatabase>
): void {
  if (hasActiveDuplicateScan()) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      "Duplicate detection is still running; review results after it completes"
    );
  }
  const activeSince = Date.now() - DUPLICATE_SCAN_LEASE_MS;
  db.update(duplicateDetectionRuns)
    .set({
      completedAt: Date.now(),
      errorMessage: "Detection run lease expired",
      status: "stale",
    })
    .where(
      and(
        eq(duplicateDetectionRuns.status, "running"),
        lt(duplicateDetectionRuns.startedAt, activeSince)
      )
    )
    .run();
  const running = db
    .select({ id: duplicateDetectionRuns.id })
    .from(duplicateDetectionRuns)
    .where(
      and(
        eq(duplicateDetectionRuns.status, "running"),
        gt(duplicateDetectionRuns.startedAt, activeSince)
      )
    )
    .get();
  if (running) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      "Duplicate detection is still running; review results after it completes"
    );
  }
}

function assertCurrentDetectionFingerprint(
  fingerprint: string,
  context: string
): void {
  if (fingerprint === "legacy") {
    return;
  }
  const current = getSetting("duplicates.scannedSignature");
  if (current !== fingerprint) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate detection result is stale for ${context}; scan again`
    );
  }
}

export interface DuplicateCleanupPlanGroupInput {
  deletePhotoIds: number[];
  groupKey: string;
  groupVersion: string;
  keepPhotoIds: number[];
  matchType: "exact" | "similar";
  reviewRevision: number;
}

interface FileSnapshot {
  fileIdentity: string;
  fileSize: number;
  fullSha256: string;
  modifiedAt: number;
  path: string;
}

interface PlanItemSnapshot extends FileSnapshot {
  canonicalPath: string;
  contentRevision: number;
  decision: "KEEP" | "DELETE";
  groupKey: string;
  groupVersion: string;
  matchType: "exact" | "similar";
  photoId: number;
  reviewRevision: number;
}

interface ReviewMemberRow {
  contentRevision: number;
  decision: string;
  needsReview: boolean;
  photoId: number;
}

function uniqueIds(ids: number[]): number[] {
  return [...new Set(ids)];
}

function sameIds(left: number[], right: number[]): boolean {
  const a = [...new Set(left)].sort((x, y) => x - y);
  const b = [...new Set(right)].sort((x, y) => x - y);
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

function parseMemberIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter(
          (id): id is number =>
            typeof id === "number" && Number.isSafeInteger(id) && id > 0
        )
      : [];
  } catch {
    return [];
  }
}

function fileIdentity(stat: fs.Stats): string {
  return stat.dev || stat.ino ? `${stat.dev}:${stat.ino}` : "";
}

function sameFileSnapshot(
  expected: Pick<
    FileSnapshot,
    "fileIdentity" | "fileSize" | "modifiedAt" | "path"
  >,
  actual: Pick<
    FileSnapshot,
    "fileIdentity" | "fileSize" | "modifiedAt" | "path"
  >
): boolean {
  return (
    expected.path === actual.path &&
    expected.fileIdentity === actual.fileIdentity &&
    expected.fileSize === actual.fileSize &&
    expected.modifiedAt === actual.modifiedAt
  );
}

async function captureFileSnapshot(filePath: string): Promise<FileSnapshot> {
  let before: fs.Stats;
  try {
    before = await fs.promises.stat(filePath);
  } catch {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      `Original file does not exist: ${filePath}`
    );
  }
  if (!before.isFile()) {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      `Original path is not a file: ${filePath}`
    );
  }
  const fullSha256 = await computeFullFileHash(filePath);
  if (!fullSha256) {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      `File could not be read consistently: ${filePath}`
    );
  }
  let after: fs.Stats;
  try {
    after = await fs.promises.stat(filePath);
  } catch {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      `File disappeared while being verified: ${filePath}`
    );
  }
  const snapshot = {
    fileIdentity: fileIdentity(before),
    fileSize: before.size,
    fullSha256,
    modifiedAt: before.mtimeMs,
    path: filePath,
  };
  if (
    !sameFileSnapshot(snapshot, {
      fileIdentity: fileIdentity(after),
      fileSize: after.size,
      modifiedAt: after.mtimeMs,
      path: filePath,
    })
  ) {
    throw new DuplicateCleanupPlanError(
      "FILE_CHANGED",
      `File changed while being verified: ${filePath}`
    );
  }
  return snapshot;
}

function assertCurrentDuplicateGroup(
  db: ReturnType<typeof getDatabase>,
  groupKey: string,
  expectedPhotoIds: number[]
): "exact" | "similar" {
  const sequenceMember = db
    .select({ photoId: photoSequenceMembers.photoId })
    .from(photoSequenceMembers)
    .where(inArray(photoSequenceMembers.photoId, expectedPhotoIds))
    .get();
  if (sequenceMember) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Photo ${sequenceMember.photoId} is managed by a photo sequence`
    );
  }
  const persistedPairs = db.select().from(duplicatePairs).all();
  if (persistedPairs.length === 0) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group is no longer part of the current scan: ${groupKey}`
    );
  }
  const photoIds = new Set(
    persistedPairs.flatMap((pair) => [pair.photoAId, pair.photoBId])
  );
  const photoRows = db
    .select({
      createdAt: photos.createdAt,
      fileDate: photos.fileDate,
      fileSize: photos.fileSize,
      filename: photos.filename,
      height: photos.height,
      id: photos.id,
      path: photos.path,
      thumbnailPath: photos.thumbnailPath,
      width: photos.width,
    })
    .from(photos)
    .where(and(inArray(photos.id, [...photoIds]), isNull(photos.deletedAt)))
    .all();
  const photoById = new Map(photoRows.map((photo) => [photo.id, photo]));
  const pairs: DuplicatePairRecord[] = persistedPairs
    .map((pair) => {
      const photoA = photoById.get(pair.photoAId);
      const photoB = photoById.get(pair.photoBId);
      if (!(photoA && photoB)) {
        return null;
      }
      return {
        clipSimilarity: pair.clipSimilarity,
        distance: pair.phashDistance ?? 0,
        matchType: pair.matchType as DuplicatePairRecord["matchType"],
        pairId: pair.id,
        photoA,
        photoB,
        status: pair.status as DuplicatePairRecord["status"],
      } satisfies DuplicatePairRecord;
    })
    .filter((pair): pair is DuplicatePairRecord => pair !== null);
  const currentGroup = groupDuplicatePairs(pairs).find(
    (group) => group.groupKey === groupKey
  );
  if (
    !(
      currentGroup &&
      sameIds(
        currentGroup.photos.map((photo) => photo.id),
        expectedPhotoIds
      )
    )
  ) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group changed since it was reviewed: ${groupKey}`
    );
  }
  return currentGroup.matchType;
}

function validateSelection(
  input: DuplicateCleanupPlanGroupInput,
  members: ReviewMemberRow[],
  group: typeof duplicateReviewGroups.$inferSelect
): void {
  if (group.groupVersion !== input.groupVersion) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group ${input.groupKey} changed since it was reviewed`
    );
  }
  if (group.reviewRevision !== input.reviewRevision) {
    throw new DuplicateCleanupPlanError(
      "STALE_REVIEW",
      `Duplicate review ${input.groupKey} changed since it was loaded`
    );
  }
  if (group.ignoreState !== "ACTIVE") {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `Ignored duplicate group cannot be cleaned: ${input.groupKey}`
    );
  }
  if (!group.complete || group.needsReview) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Duplicate group still contains an unreviewed member: ${input.groupKey}`
    );
  }

  const keepPhotoIds = uniqueIds(input.keepPhotoIds);
  const deletePhotoIds = uniqueIds(input.deletePhotoIds);
  if (
    keepPhotoIds.length !== input.keepPhotoIds.length ||
    deletePhotoIds.length !== input.deletePhotoIds.length ||
    keepPhotoIds.length === 0
  ) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `Duplicate group contains repeated or empty decisions: ${input.groupKey}`
    );
  }
  if (deletePhotoIds.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `A deletion plan requires at least one DELETE member: ${input.groupKey}`
    );
  }
  if (keepPhotoIds.some((id) => deletePhotoIds.includes(id))) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      `KEEP and DELETE overlap in duplicate group: ${input.groupKey}`
    );
  }

  const memberIds = members.map((member) => member.photoId);
  if (!sameIds([...keepPhotoIds, ...deletePhotoIds], memberIds)) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Submitted decisions do not cover every group member: ${input.groupKey}`
    );
  }
  const decisionsByPhoto = new Map(
    members.map((member) => [member.photoId, member.decision])
  );
  for (const photoId of keepPhotoIds) {
    if (decisionsByPhoto.get(photoId) !== "KEEP") {
      throw new DuplicateCleanupPlanError(
        "STALE_REVIEW",
        `KEEP decision is not persisted for photo ${photoId}`
      );
    }
  }
  for (const photoId of deletePhotoIds) {
    if (decisionsByPhoto.get(photoId) !== "DELETE") {
      throw new DuplicateCleanupPlanError(
        "STALE_REVIEW",
        `DELETE decision is not persisted for photo ${photoId}`
      );
    }
  }
  if (
    members.some(
      (member) =>
        member.decision === "UNDECIDED" ||
        member.needsReview ||
        !decisionsByPhoto.has(member.photoId)
    )
  ) {
    throw new DuplicateCleanupPlanError(
      "UNDECIDED_MEMBERS",
      `Duplicate group contains an undecided member: ${input.groupKey}`
    );
  }
  const storedMemberIds = parseMemberIds(group.memberIdsJson);
  if (!sameIds(storedMemberIds, memberIds)) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group membership changed: ${input.groupKey}`
    );
  }
}

function getReviewRows(
  db: ReturnType<typeof getDatabase>,
  groupKey: string
): {
  group: typeof duplicateReviewGroups.$inferSelect;
  members: ReviewMemberRow[];
} {
  const group = db
    .select()
    .from(duplicateReviewGroups)
    .where(eq(duplicateReviewGroups.groupKey, groupKey))
    .get();
  if (!group) {
    throw new DuplicateCleanupPlanError(
      "STALE_GROUP",
      `Duplicate group was not found: ${groupKey}`
    );
  }
  const members = db
    .select({
      contentRevision: duplicateReviewMembers.contentRevision,
      decision: duplicateReviewMembers.decision,
      needsReview: duplicateReviewMembers.needsReview,
      photoId: duplicateReviewMembers.photoId,
    })
    .from(duplicateReviewMembers)
    .where(eq(duplicateReviewMembers.groupKey, groupKey))
    .all();
  return { group, members };
}

function getPhotoRows(db: ReturnType<typeof getDatabase>, photoIds: number[]) {
  return db
    .select({
      deletionBatchId: photos.deletionBatchId,
      deletedAt: photos.deletedAt,
      fileSize: photos.fileSize,
      folderId: photos.folderId,
      id: photos.id,
      path: photos.path,
    })
    .from(photos)
    .where(inArray(photos.id, photoIds))
    .all();
}

function planResult(
  plan: typeof duplicateCleanupPlans.$inferSelect,
  items: PlanItemSnapshot[]
) {
  const groups = new Map<
    string,
    {
      deleteBytes: number;
      deletePhotoIds: number[];
      groupKey: string;
      keepPhotoIds: number[];
      matchType: "exact" | "similar";
    }
  >();
  for (const item of items) {
    const group = groups.get(item.groupKey) ?? {
      deleteBytes: 0,
      deletePhotoIds: [],
      groupKey: item.groupKey,
      keepPhotoIds: [],
      matchType: item.matchType,
    };
    if (item.decision === "DELETE") {
      group.deletePhotoIds.push(item.photoId);
      group.deleteBytes += item.fileSize;
    } else if (item.decision === "KEEP") {
      group.keepPhotoIds.push(item.photoId);
    }
    groups.set(item.groupKey, group);
  }
  return {
    batchId: plan.batchId,
    createdAt: plan.createdAt,
    deleteBytes: items
      .filter((item) => item.decision === "DELETE")
      .reduce((total, item) => total + item.fileSize, 0),
    deleteCount: items.filter((item) => item.decision === "DELETE").length,
    expiresAt: plan.expiresAt,
    groups: [...groups.values()],
    planId: plan.id,
    status: plan.status as DuplicateCleanupPlanStatus,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Plan creation intentionally performs the complete review, file, and snapshot validation before writing a plan.
export async function createDuplicateCleanupPlan(
  input: { groups: DuplicateCleanupPlanGroupInput[] },
  db = getDatabase()
) {
  assertNoDuplicateScanRunning(db);
  if (input.groups.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "At least one reviewed duplicate group is required"
    );
  }
  const groupKeys = input.groups.map((group) => group.groupKey);
  if (new Set(groupKeys).size !== groupKeys.length) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "A duplicate group was submitted more than once"
    );
  }

  const itemSnapshots: PlanItemSnapshot[] = [];
  const configFingerprints = new Set<string>();
  for (const groupInput of input.groups) {
    const { group, members } = getReviewRows(db, groupInput.groupKey);
    configFingerprints.add(group.detectionFingerprint);
    assertCurrentDetectionFingerprint(
      group.detectionFingerprint,
      groupInput.groupKey
    );
    const currentMatchType = assertCurrentDuplicateGroup(
      db,
      groupInput.groupKey,
      members.map((member) => member.photoId)
    );
    if (currentMatchType !== groupInput.matchType) {
      throw new DuplicateCleanupPlanError(
        "STALE_GROUP",
        `Duplicate group match type changed: ${groupInput.groupKey}`
      );
    }
    validateSelection(groupInput, members, group);
    const memberIds = members.map((member) => member.photoId);
    const photoRows = getPhotoRows(db, memberIds);
    const photoById = new Map(photoRows.map((photo) => [photo.id, photo]));
    if (photoRows.length !== memberIds.length) {
      throw new DuplicateCleanupPlanError(
        "SOURCE_MISSING",
        `A duplicate group member no longer exists: ${groupInput.groupKey}`
      );
    }
    const memberById = new Map(
      members.map((member) => [member.photoId, member])
    );
    for (const photoId of memberIds) {
      const photo = photoById.get(photoId);
      const member = memberById.get(photoId);
      if (!(photo && member) || photo.deletedAt !== null) {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Duplicate group contains a deleted photo: ${photoId}`
        );
      }
      const snapshot = await captureFileSnapshot(photo.path);
      const fingerprint = db
        .select()
        .from(duplicatePhotoFingerprints)
        .where(eq(duplicatePhotoFingerprints.photoId, photoId))
        .get();
      const fingerprintMatches = Boolean(
        fingerprint?.fullSha256 &&
          fingerprint.contentRevision === member.contentRevision &&
          fingerprint.path === photo.path &&
          fingerprint.fileSize === snapshot.fileSize &&
          fingerprint.modifiedAt === snapshot.modifiedAt &&
          fingerprint.fullSha256 === snapshot.fullSha256
      );
      if (!fingerprintMatches) {
        throw new DuplicateCleanupPlanError(
          "STALE_REVIEW",
          `Photo ${photoId} changed since its duplicate review was saved`
        );
      }
      const canonicalPath = await fs.promises.realpath(photo.path).catch(() => {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Original file cannot be resolved: ${photo.path}`
        );
      });
      itemSnapshots.push({
        ...snapshot,
        canonicalPath,
        contentRevision: member.contentRevision,
        decision: groupInput.keepPhotoIds.includes(photoId) ? "KEEP" : "DELETE",
        groupKey: groupInput.groupKey,
        groupVersion: groupInput.groupVersion,
        matchType: currentMatchType,
        photoId,
        reviewRevision: groupInput.reviewRevision,
      });
    }
  }
  if (configFingerprints.size > 1) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "A deletion plan cannot combine results from different detection runs"
    );
  }
  const configFingerprint = [...configFingerprints][0] ?? "legacy";

  const canonicalPaths = new Set<string>();
  const fileIdentities = new Set<string>();
  const photoIds = new Set<number>();
  for (const item of itemSnapshots) {
    if (photoIds.has(item.photoId)) {
      throw new DuplicateCleanupPlanError(
        "INVALID_SELECTION",
        `Photo ${item.photoId} appears in more than one duplicate group`
      );
    }
    photoIds.add(item.photoId);
    const normalizedCanonicalPath = item.canonicalPath.toLowerCase();
    if (
      canonicalPaths.has(normalizedCanonicalPath) ||
      (item.fileIdentity && fileIdentities.has(item.fileIdentity))
    ) {
      throw new DuplicateCleanupPlanError(
        "INVALID_SELECTION",
        `Duplicate plan contains the same underlying file more than once: ${item.path}`
      );
    }
    canonicalPaths.add(normalizedCanonicalPath);
    if (item.fileIdentity) {
      fileIdentities.add(item.fileIdentity);
    }
  }
  for (const groupInput of input.groups) {
    if (groupInput.matchType !== "exact") {
      continue;
    }
    const exactItems = itemSnapshots.filter(
      (item) => item.groupKey === groupInput.groupKey
    );
    const representative = exactItems[0];
    if (
      !representative ||
      exactItems.some((item) => item.fullSha256 !== representative.fullSha256)
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Exact duplicate group contains different file bytes: ${groupInput.groupKey}`
      );
    }
    for (const item of exactItems.slice(1)) {
      if (!(await filesHaveSameBytes(representative.path, item.path))) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Exact duplicate group failed byte verification: ${groupInput.groupKey}`
        );
      }
    }
  }

  const now = Date.now();
  const planId = randomUUID();
  const expiresAt = now + DUPLICATE_CLEANUP_PLAN_TTL_MS;
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Plan publication repeats every review, scan, sequence, and fingerprint guard inside one transaction.
  const plan = db.transaction((tx) => {
    for (const groupInput of input.groups) {
      const activeScan = tx
        .select({ id: duplicateDetectionRuns.id })
        .from(duplicateDetectionRuns)
        .where(
          and(
            eq(duplicateDetectionRuns.status, "running"),
            gt(
              duplicateDetectionRuns.startedAt,
              Date.now() - DUPLICATE_SCAN_LEASE_MS
            )
          )
        )
        .get();
      if (activeScan || hasActiveDuplicateScan()) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          "Duplicate detection started while the deletion plan was being validated"
        );
      }
      const group = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupInput.groupKey))
        .get();
      if (!group) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate group was removed while creating the plan: ${groupInput.groupKey}`
        );
      }
      if (group.detectionFingerprint !== configFingerprint) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate detection run changed: ${groupInput.groupKey}`
        );
      }
      assertCurrentDetectionFingerprint(
        group.detectionFingerprint,
        groupInput.groupKey
      );
      const members = tx
        .select({
          contentRevision: duplicateReviewMembers.contentRevision,
          decision: duplicateReviewMembers.decision,
          needsReview: duplicateReviewMembers.needsReview,
          photoId: duplicateReviewMembers.photoId,
        })
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.groupKey, groupInput.groupKey))
        .all();
      const sequenceMember = tx
        .select({ photoId: photoSequenceMembers.photoId })
        .from(photoSequenceMembers)
        .where(
          inArray(
            photoSequenceMembers.photoId,
            members.map((member) => member.photoId)
          )
        )
        .get();
      if (sequenceMember) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Photo ${sequenceMember.photoId} is managed by a photo sequence`
        );
      }
      validateSelection(groupInput, members, group);
      for (const item of itemSnapshots.filter(
        (candidate) => candidate.groupKey === groupInput.groupKey
      )) {
        const photo = tx
          .select({
            deletedAt: photos.deletedAt,
            fileSize: photos.fileSize,
            id: photos.id,
            path: photos.path,
          })
          .from(photos)
          .where(eq(photos.id, item.photoId))
          .get();
        if (
          !photo ||
          photo.deletedAt !== null ||
          photo.path !== item.path ||
          (photo.fileSize ?? 0) !== item.fileSize
        ) {
          throw new DuplicateCleanupPlanError(
            "FILE_CHANGED",
            `Photo changed while creating the deletion plan: ${item.photoId}`
          );
        }
        const fingerprint = tx
          .select()
          .from(duplicatePhotoFingerprints)
          .where(eq(duplicatePhotoFingerprints.photoId, item.photoId))
          .get();
        if (
          !fingerprint ||
          fingerprint.contentRevision !== item.contentRevision ||
          fingerprint.path !== item.path ||
          fingerprint.fileSize !== item.fileSize ||
          fingerprint.modifiedAt !== item.modifiedAt ||
          fingerprint.fullSha256 !== item.fullSha256
        ) {
          throw new DuplicateCleanupPlanError(
            "STALE_REVIEW",
            `Photo review changed while creating the deletion plan: ${item.photoId}`
          );
        }
      }
    }
    tx.insert(duplicateCleanupPlans)
      .values({
        configFingerprint,
        createdAt: now,
        expiresAt,
        id: planId,
        status: "READY",
        updatedAt: now,
      })
      .run();
    tx.insert(duplicateCleanupPlanItems)
      .values(
        itemSnapshots.map((item) => ({
          contentRevision: item.contentRevision,
          createdAt: now,
          decision: item.decision,
          fileIdentity: item.fileIdentity,
          fileSize: item.fileSize,
          fullSha256: item.fullSha256,
          groupKey: item.groupKey,
          groupVersion: item.groupVersion,
          matchType: item.matchType,
          modifiedAt: item.modifiedAt,
          path: item.path,
          photoId: item.photoId,
          planId,
          reviewRevision: item.reviewRevision,
        }))
      )
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        detailsJson: JSON.stringify({
          deleteCount: itemSnapshots.filter(
            (item) => item.decision === "DELETE"
          ).length,
          keepCount: itemSnapshots.filter((item) => item.decision === "KEEP")
            .length,
        }),
        eventType: "PLAN_CREATED",
        planId,
      })
      .run();
    return tx
      .select()
      .from(duplicateCleanupPlans)
      .where(eq(duplicateCleanupPlans.id, planId))
      .get() as typeof duplicateCleanupPlans.$inferSelect;
  });

  return planResult(plan, itemSnapshots);
}

function assertItemsStillMatch(
  db: ReturnType<typeof getDatabase>,
  items: (typeof duplicateCleanupPlanItems.$inferSelect)[]
): void {
  const photoIds = items.map((item) => item.photoId);
  const rows = getPhotoRows(db, photoIds);
  const byId = new Map(rows.map((row) => [row.id, row]));
  if (rows.length !== photoIds.length) {
    throw new DuplicateCleanupPlanError(
      "SOURCE_MISSING",
      "A photo in the deletion plan no longer exists"
    );
  }
  for (const item of items) {
    const row = byId.get(item.photoId);
    if (
      !row ||
      row.deletedAt !== null ||
      row.path !== item.path ||
      (row.fileSize ?? 0) !== item.fileSize
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Photo ${item.photoId} changed after the deletion plan was created`
      );
    }
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Execution is a single safety gate that must validate every group before the transaction can write any deletion.
export async function executeDuplicateCleanupPlan(
  input: { planId: string },
  db = getDatabase()
) {
  const plan = db
    .select()
    .from(duplicateCleanupPlans)
    .where(eq(duplicateCleanupPlans.id, input.planId))
    .get();
  if (!plan) {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_FOUND",
      "Deletion plan not found"
    );
  }
  if (plan.status === "EXECUTED" && plan.batchId) {
    return {
      alreadyExecuted: true,
      batchId: plan.batchId,
      deletedCount: plan.deletedCount,
      planId: plan.id,
      status: plan.status as DuplicateCleanupPlanStatus,
    };
  }
  assertCurrentDetectionFingerprint(plan.configFingerprint, plan.id);
  assertNoDuplicateScanRunning(db);
  if (plan.status !== "READY") {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_READY",
      `Deletion plan is ${plan.status.toLowerCase()}`
    );
  }
  if (plan.expiresAt <= Date.now()) {
    db.update(duplicateCleanupPlans)
      .set({ status: "EXPIRED", updatedAt: Date.now() })
      .where(
        and(
          eq(duplicateCleanupPlans.id, plan.id),
          eq(duplicateCleanupPlans.status, "READY")
        )
      )
      .run();
    throw new DuplicateCleanupPlanError(
      "PLAN_EXPIRED",
      "Deletion plan has expired"
    );
  }

  const items = db
    .select()
    .from(duplicateCleanupPlanItems)
    .where(eq(duplicateCleanupPlanItems.planId, plan.id))
    .all();
  if (items.length === 0) {
    throw new DuplicateCleanupPlanError(
      "INVALID_SELECTION",
      "Deletion plan is empty"
    );
  }
  const deleteItems = items.filter((item) => item.decision === "DELETE");
  const keepItems = items.filter((item) => item.decision === "KEEP");
  const groups = new Set(items.map((item) => item.groupKey));
  const matchTypeByGroup = new Map<string, "exact" | "similar">();
  for (const groupKey of groups) {
    const groupItems = items.filter((item) => item.groupKey === groupKey);
    if (
      !(
        groupItems.some((item) => item.decision === "KEEP") &&
        groupItems.some((item) => item.decision === "DELETE")
      )
    ) {
      throw new DuplicateCleanupPlanError(
        "NO_KEEPER",
        `Deletion plan group has an invalid keep/delete split: ${groupKey}`
      );
    }
    const review = getReviewRows(db, groupKey);
    const matchType = assertCurrentDuplicateGroup(
      db,
      groupKey,
      review.members.map((member) => member.photoId)
    );
    matchTypeByGroup.set(groupKey, matchType);
    validateSelection(
      {
        deletePhotoIds: groupItems
          .filter((item) => item.decision === "DELETE")
          .map((item) => item.photoId),
        groupKey,
        groupVersion: groupItems[0]?.groupVersion ?? "",
        keepPhotoIds: groupItems
          .filter((item) => item.decision === "KEEP")
          .map((item) => item.photoId),
        matchType: matchTypeByGroup.get(groupKey) ?? "similar",
        reviewRevision: groupItems[0]?.reviewRevision ?? -1,
      },
      review.members,
      review.group
    );
  }
  assertItemsStillMatch(db, items);
  const fingerprints = db
    .select()
    .from(duplicatePhotoFingerprints)
    .where(
      inArray(
        duplicatePhotoFingerprints.photoId,
        items.map((item) => item.photoId)
      )
    )
    .all();
  const fingerprintById = new Map(
    fingerprints.map((fingerprint) => [fingerprint.photoId, fingerprint])
  );
  for (const item of items) {
    const current = await captureFileSnapshot(item.path);
    const fingerprint = fingerprintById.get(item.photoId);
    if (
      item.fileIdentity === null ||
      item.fullSha256 === null ||
      !sameFileSnapshot(
        {
          fileIdentity: item.fileIdentity,
          fileSize: item.fileSize,
          modifiedAt: item.modifiedAt,
          path: item.path,
        },
        current
      ) ||
      current.fullSha256 !== item.fullSha256 ||
      !fingerprint ||
      fingerprint.contentRevision !== item.contentRevision ||
      fingerprint.path !== item.path ||
      fingerprint.fileSize !== item.fileSize ||
      fingerprint.modifiedAt !== item.modifiedAt ||
      fingerprint.fullSha256 !== item.fullSha256
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Photo ${item.photoId} changed after the deletion plan was created`
      );
    }
  }
  for (const groupKey of groups) {
    if (matchTypeByGroup.get(groupKey) !== "exact") {
      continue;
    }
    const groupItems = items.filter((item) => item.groupKey === groupKey);
    const representative = groupItems[0];
    if (
      !representative ||
      groupItems.some((item) => item.fullSha256 !== representative.fullSha256)
    ) {
      throw new DuplicateCleanupPlanError(
        "FILE_CHANGED",
        `Exact duplicate group contains different file bytes: ${groupKey}`
      );
    }
    for (const item of groupItems.slice(1)) {
      if (!(await filesHaveSameBytes(representative.path, item.path))) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Exact duplicate group failed byte verification: ${groupKey}`
        );
      }
    }
  }

  const now = Date.now();
  const batchId = randomUUID();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: The transaction repeats every safety check before applying the all-or-nothing soft delete.
  const execution = db.transaction((tx) => {
    const currentPlan = tx
      .select()
      .from(duplicateCleanupPlans)
      .where(eq(duplicateCleanupPlans.id, plan.id))
      .get();
    if (!currentPlan) {
      throw new DuplicateCleanupPlanError(
        "PLAN_NOT_FOUND",
        "Deletion plan not found"
      );
    }
    if (currentPlan.status === "EXECUTED" && currentPlan.batchId) {
      return {
        alreadyExecuted: true,
        batchId: currentPlan.batchId,
        deletedCount: currentPlan.deletedCount,
      };
    }
    assertCurrentDetectionFingerprint(
      currentPlan.configFingerprint,
      currentPlan.id
    );
    if (currentPlan.status !== "READY") {
      throw new DuplicateCleanupPlanError(
        "PLAN_NOT_READY",
        "Deletion plan is no longer ready"
      );
    }
    if (currentPlan.expiresAt <= now) {
      tx.update(duplicateCleanupPlans)
        .set({ status: "EXPIRED", updatedAt: now })
        .where(eq(duplicateCleanupPlans.id, currentPlan.id))
        .run();
      throw new DuplicateCleanupPlanError(
        "PLAN_EXPIRED",
        "Deletion plan has expired"
      );
    }
    const activeScan = tx
      .select({ id: duplicateDetectionRuns.id })
      .from(duplicateDetectionRuns)
      .where(
        and(
          eq(duplicateDetectionRuns.status, "running"),
          gt(
            duplicateDetectionRuns.startedAt,
            Date.now() - DUPLICATE_SCAN_LEASE_MS
          )
        )
      )
      .get();
    if (activeScan || hasActiveDuplicateScan()) {
      throw new DuplicateCleanupPlanError(
        "STALE_GROUP",
        "Duplicate detection is still running; execute the plan after it completes"
      );
    }
    const livePairs = tx
      .select({
        photoAId: duplicatePairs.photoAId,
        photoBId: duplicatePairs.photoBId,
      })
      .from(duplicatePairs)
      .all();
    for (const groupKey of groups) {
      const groupItems = items.filter((item) => item.groupKey === groupKey);
      const review = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupKey))
        .get();
      const members = tx
        .select({
          contentRevision: duplicateReviewMembers.contentRevision,
          decision: duplicateReviewMembers.decision,
          needsReview: duplicateReviewMembers.needsReview,
          photoId: duplicateReviewMembers.photoId,
        })
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.groupKey, groupKey))
        .all();
      if (!review) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate review is missing: ${groupKey}`
        );
      }
      const groupVersion = groupItems[0]?.groupVersion ?? "";
      const reviewRevision = groupItems[0]?.reviewRevision ?? -1;
      validateSelection(
        {
          deletePhotoIds: groupItems
            .filter((item) => item.decision === "DELETE")
            .map((item) => item.photoId),
          groupKey,
          groupVersion,
          keepPhotoIds: groupItems
            .filter((item) => item.decision === "KEEP")
            .map((item) => item.photoId),
          matchType: groupItems[0]?.matchType === "exact" ? "exact" : "similar",
          reviewRevision,
        },
        members,
        review
      );
      const memberIds = members.map((member) => member.photoId);
      const adjacency = new Map<number, number[]>();
      for (const pair of livePairs) {
        adjacency.set(pair.photoAId, [
          ...(adjacency.get(pair.photoAId) ?? []),
          pair.photoBId,
        ]);
        adjacency.set(pair.photoBId, [
          ...(adjacency.get(pair.photoBId) ?? []),
          pair.photoAId,
        ]);
      }
      const expectedMemberIds = new Set(memberIds);
      const seed = memberIds[0];
      const component = new Set<number>();
      if (seed !== undefined) {
        const queue = [seed];
        while (queue.length > 0) {
          const current = queue.pop();
          if (current === undefined || component.has(current)) {
            continue;
          }
          component.add(current);
          queue.push(...(adjacency.get(current) ?? []));
        }
      }
      if (
        component.size !== expectedMemberIds.size ||
        [...component].some((photoId) => !expectedMemberIds.has(photoId))
      ) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Duplicate group changed while executing the deletion plan: ${groupKey}`
        );
      }
      const sequenceMember = tx
        .select({ photoId: photoSequenceMembers.photoId })
        .from(photoSequenceMembers)
        .where(inArray(photoSequenceMembers.photoId, memberIds))
        .get();
      if (sequenceMember) {
        throw new DuplicateCleanupPlanError(
          "STALE_GROUP",
          `Photo ${sequenceMember.photoId} is managed by a photo sequence`
        );
      }
    }
    const currentPhotos = tx
      .select({
        deletedAt: photos.deletedAt,
        fileSize: photos.fileSize,
        folderId: photos.folderId,
        id: photos.id,
        path: photos.path,
      })
      .from(photos)
      .where(
        inArray(
          photos.id,
          items.map((item) => item.photoId)
        )
      )
      .all();
    const currentPhotoById = new Map(
      currentPhotos.map((photo) => [photo.id, photo])
    );
    const currentFingerprints = tx
      .select()
      .from(duplicatePhotoFingerprints)
      .where(
        inArray(
          duplicatePhotoFingerprints.photoId,
          items.map((item) => item.photoId)
        )
      )
      .all();
    const currentFingerprintById = new Map(
      currentFingerprints.map((fingerprint) => [
        fingerprint.photoId,
        fingerprint,
      ])
    );
    for (const item of items) {
      const photo = currentPhotoById.get(item.photoId);
      const fingerprint = currentFingerprintById.get(item.photoId);
      if (
        !photo ||
        photo.deletedAt !== null ||
        photo.path !== item.path ||
        (photo.fileSize ?? 0) !== item.fileSize ||
        !fingerprint ||
        fingerprint.contentRevision !== item.contentRevision ||
        fingerprint.path !== item.path ||
        fingerprint.fileSize !== item.fileSize ||
        fingerprint.modifiedAt !== item.modifiedAt ||
        fingerprint.fullSha256 !== item.fullSha256
      ) {
        throw new DuplicateCleanupPlanError(
          "FILE_CHANGED",
          `Photo ${item.photoId} changed while executing the deletion plan`
        );
      }
    }
    const activeDeleteIds: number[] = [];
    const folderCounts = new Map<number, number>();
    for (const item of deleteItems) {
      const photo = currentPhotoById.get(item.photoId);
      if (!photo || photo.deletedAt !== null) {
        throw new DuplicateCleanupPlanError(
          "SOURCE_MISSING",
          `Photo ${item.photoId} is no longer active`
        );
      }
      activeDeleteIds.push(photo.id);
      if (photo.folderId !== null) {
        folderCounts.set(
          photo.folderId,
          (folderCounts.get(photo.folderId) ?? 0) + 1
        );
      }
    }
    tx.update(photos)
      .set({ deletionBatchId: batchId, deletedAt: now })
      .where(inArray(photos.id, activeDeleteIds))
      .run();
    for (const [folderId, count] of folderCounts) {
      tx.update(folders)
        .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
        .where(eq(folders.id, folderId))
        .run();
    }
    tx.update(duplicateCleanupPlans)
      .set({
        batchId,
        deletedCount: activeDeleteIds.length,
        executedAt: now,
        status: "EXECUTED",
        updatedAt: now,
      })
      .where(
        and(
          eq(duplicateCleanupPlans.id, currentPlan.id),
          eq(duplicateCleanupPlans.status, "READY")
        )
      )
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        batchId,
        detailsJson: JSON.stringify({
          deletedPhotoIds: activeDeleteIds,
          keepPhotoIds: keepItems.map((item) => item.photoId),
        }),
        eventType: "EXECUTED",
        planId: currentPlan.id,
      })
      .run();
    return {
      alreadyExecuted: false,
      batchId,
      deletedCount: activeDeleteIds.length,
    };
  });

  if (!execution.alreadyExecuted) {
    cleanupDeletedPhotoSequenceMembers(db);
    notifySequencesChanged(undefined, "manual");
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
  }
  return {
    alreadyExecuted: execution.alreadyExecuted,
    batchId: execution.batchId,
    deletedCount: execution.deletedCount,
    planId: plan.id,
    status: "EXECUTED" as const,
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Batch restoration validates every item and records partial outcomes atomically.
export function restoreDuplicateCleanupBatch(
  input: { batchId: string },
  db = getDatabase()
) {
  const plan = db
    .select()
    .from(duplicateCleanupPlans)
    .where(eq(duplicateCleanupPlans.batchId, input.batchId))
    .get();
  if (!plan) {
    throw new DuplicateCleanupPlanError(
      "PLAN_NOT_FOUND",
      "Cleanup batch not found"
    );
  }
  if (plan.status === "RESTORED") {
    return {
      batchId: input.batchId,
      failed: [],
      restoredIds: [],
      status: plan.status,
    };
  }
  if (plan.status !== "EXECUTED" && plan.status !== "RESTORE_PARTIAL") {
    throw new DuplicateCleanupPlanError(
      "RESTORE_FAILED",
      `Cleanup batch cannot be restored from ${plan.status}`
    );
  }
  const items = db
    .select()
    .from(duplicateCleanupPlanItems)
    .where(
      and(
        eq(duplicateCleanupPlanItems.planId, plan.id),
        eq(duplicateCleanupPlanItems.decision, "DELETE")
      )
    )
    .all();
  const rows = getPhotoRows(
    db,
    items.map((item) => item.photoId)
  );
  const rowById = new Map(rows.map((row) => [row.id, row]));
  const failed: Array<{ id: number; filename: string; message: string }> = [];
  const restorable: Array<{ folderId: number | null; id: number }> = [];
  const alreadyRestoredIds: number[] = [];
  const validFolderIds = new Set(
    db
      .select({ id: folders.id })
      .from(folders)
      .all()
      .map((folder) => folder.id)
  );
  for (const item of items) {
    const row = rowById.get(item.photoId);
    if (!row) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Photo record no longer exists",
      });
      continue;
    }
    if (!fs.existsSync(row.path)) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Original file no longer exists",
      });
      continue;
    }
    if (row.deletedAt === null) {
      alreadyRestoredIds.push(row.id);
      continue;
    }
    if (row.deletionBatchId !== input.batchId) {
      failed.push({
        id: item.photoId,
        filename: path.basename(item.path),
        message: "Photo was deleted by a different batch",
      });
      continue;
    }
    restorable.push({ folderId: row.folderId, id: row.id });
  }
  const restoreIds = restorable.map((photo) => photo.id);
  const folderCounts = new Map<number, number>();
  const idsWithFolders: number[] = [];
  const idsWithoutFolders: number[] = [];
  for (const photo of restorable) {
    if (photo.folderId !== null && validFolderIds.has(photo.folderId)) {
      idsWithFolders.push(photo.id);
      folderCounts.set(
        photo.folderId,
        (folderCounts.get(photo.folderId) ?? 0) + 1
      );
    } else {
      idsWithoutFolders.push(photo.id);
    }
  }
  db.transaction((tx) => {
    if (idsWithFolders.length > 0) {
      tx.update(photos)
        .set({ deletionBatchId: null, deletedAt: null })
        .where(inArray(photos.id, idsWithFolders))
        .run();
      for (const [folderId, count] of folderCounts) {
        tx.update(folders)
          .set({ photoCount: sql`photo_count + ${count}` })
          .where(eq(folders.id, folderId))
          .run();
      }
    }
    if (idsWithoutFolders.length > 0) {
      tx.update(photos)
        .set({ deletionBatchId: null, deletedAt: null, folderId: null })
        .where(inArray(photos.id, idsWithoutFolders))
        .run();
    }
    const restoredGroupKeys = new Set(
      items
        .filter((item) => restoreIds.includes(item.photoId))
        .map((item) => item.groupKey)
    );
    for (const groupKey of restoredGroupKeys) {
      const restoredMembers = restoreIds.filter((photoId) =>
        items.some(
          (item) => item.groupKey === groupKey && item.photoId === photoId
        )
      );
      if (restoredMembers.length === 0) {
        continue;
      }
      tx.update(duplicateReviewMembers)
        .set({
          decision: "UNDECIDED",
          needsReview: true,
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(duplicateReviewMembers.groupKey, groupKey),
            inArray(duplicateReviewMembers.photoId, restoredMembers)
          )
        )
        .run();
      const reviewGroup = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, groupKey))
        .get();
      if (reviewGroup) {
        const nextRevision = reviewGroup.reviewRevision + 1;
        tx.update(duplicateReviewGroups)
          .set({
            complete: false,
            needsReview: true,
            reviewRevision: nextRevision,
            updatedAt: Date.now(),
          })
          .where(eq(duplicateReviewGroups.groupKey, groupKey))
          .run();
        tx.insert(duplicateReviewEvents)
          .values(
            restoredMembers.map((photoId) => ({
              contentRevision: items.find((item) => item.photoId === photoId)
                ?.contentRevision,
              decision: "UNDECIDED",
              eventType: "RESTORED_REQUIRES_REVIEW",
              groupKey,
              groupVersion: reviewGroup.groupVersion,
              photoId,
              reviewRevision: nextRevision,
            }))
          )
          .run();
      }
    }
    tx.update(duplicateCleanupPlans)
      .set({
        status: failed.length === 0 ? "RESTORED" : "RESTORE_PARTIAL",
        updatedAt: Date.now(),
      })
      .where(eq(duplicateCleanupPlans.id, plan.id))
      .run();
    tx.insert(duplicateCleanupEvents)
      .values({
        batchId: input.batchId,
        detailsJson: JSON.stringify({ failed, restoredIds: restoreIds }),
        eventType: "RESTORED",
        planId: plan.id,
      })
      .run();
  });
  if (restoreIds.length > 0) {
    cleanupDeletedPhotoSequenceMembers(db);
    notifySequencesChanged(undefined, "manual");
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
  }
  return {
    batchId: input.batchId,
    failed,
    alreadyRestoredIds,
    restoredIds: restoreIds,
    status: (failed.length === 0 ? "RESTORED" : "RESTORE_PARTIAL") as
      | "RESTORED"
      | "RESTORE_PARTIAL",
  };
}
