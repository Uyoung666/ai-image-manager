import { createHash } from "node:crypto";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { getDatabase } from "@/db";
import {
  duplicatePhotoFingerprints,
  duplicateReviewEvents,
  duplicateReviewGroups,
  duplicateReviewMembers,
  photos,
} from "@/db/schema";
import {
  type DuplicateGroup,
  rankDuplicatePhotos,
} from "@/services/duplicate-groups";

export const DUPLICATE_REVIEW_DECISIONS = [
  "KEEP",
  "DELETE",
  "UNDECIDED",
] as const;
export type DuplicateReviewDecision =
  (typeof DUPLICATE_REVIEW_DECISIONS)[number];
export type DuplicateReviewIgnoreState = "ACTIVE" | "IGNORED";

export interface DuplicateReviewMemberState {
  contentRevision: number;
  decision: DuplicateReviewDecision;
  needsReview: boolean;
  photoId: number;
}

export interface DuplicateReviewState {
  complete: boolean;
  groupKey: string;
  groupVersion: string;
  ignoreState: DuplicateReviewIgnoreState;
  members: DuplicateReviewMemberState[];
  needsReview: boolean;
  reviewRevision: number;
}

export type DuplicateReviewTransaction = Parameters<
  ReturnType<typeof getDatabase>["transaction"]
>[0] extends (arg: infer T) => unknown
  ? T
  : never;

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

export function createDuplicateGroupVersion(
  group: Pick<DuplicateGroup, "groupKey" | "matchType" | "pairIds" | "photos">,
  contentRevisions: ReadonlyMap<number, number> = new Map(),
  detectionFingerprint = "legacy"
): string {
  const payload = {
    detectionFingerprint:
      duplicateReviewConfigFingerprint(detectionFingerprint),
    groupKey: group.groupKey,
    matchType: group.matchType,
    photos: group.photos
      .map((photo) => ({
        contentRevision: contentRevisions.get(photo.id) ?? 0,
        id: photo.id,
      }))
      .sort((left, right) => left.id - right.id),
  };
  return createHash("sha256").update(stableJson(payload)).digest("hex");
}

// A library/run revision invalidates a scan, not an unchanged group's review.
function duplicateReviewConfigFingerprint(fingerprint: string): unknown {
  try {
    const config = JSON.parse(fingerprint);
    return {
      algorithmVersion: config.algorithmVersion,
      hashVersion: config.hashVersion,
      phashVersion: config.phashVersion,
      phashThreshold: config.phashThreshold,
      embeddingThreshold: config.embeddingThreshold,
      embeddingModelVersion: config.embeddingModelVersion,
      thresholdProfile: config.thresholdProfile,
    };
  } catch {
    return fingerprint;
  }
}

function parseMemberIds(value: string): number[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (photoId): photoId is number =>
        typeof photoId === "number" && Number.isSafeInteger(photoId)
    );
  } catch {
    return [];
  }
}

function isDecision(value: string): value is DuplicateReviewDecision {
  return (DUPLICATE_REVIEW_DECISIONS as readonly string[]).includes(value);
}

function toReviewState(
  group: typeof duplicateReviewGroups.$inferSelect,
  members: (typeof duplicateReviewMembers.$inferSelect)[]
): DuplicateReviewState {
  return {
    complete: group.complete,
    groupKey: group.groupKey,
    groupVersion: group.groupVersion,
    ignoreState: group.ignoreState as DuplicateReviewIgnoreState,
    members: members
      .map((member) => ({
        contentRevision: member.contentRevision,
        decision: isDecision(member.decision) ? member.decision : "UNDECIDED",
        needsReview: member.needsReview,
        photoId: member.photoId,
      }))
      .sort((left, right) => left.photoId - right.photoId),
    needsReview: group.needsReview,
    reviewRevision: group.reviewRevision,
  };
}

function stateNeedsReview(
  members: DuplicateReviewMemberState[],
  ignoreState: DuplicateReviewIgnoreState
): boolean {
  return (
    ignoreState === "ACTIVE" &&
    members.some(
      (member) => member.needsReview || member.decision === "UNDECIDED"
    )
  );
}

function stateComplete(
  members: DuplicateReviewMemberState[],
  ignoreState: DuplicateReviewIgnoreState
): boolean {
  if (ignoreState !== "ACTIVE" || members.length === 0) {
    return false;
  }
  const hasDelete = members.some((member) => member.decision === "DELETE");
  const hasKeep = members.some((member) => member.decision === "KEEP");
  return (
    hasKeep &&
    (!hasDelete || members.every((member) => !member.needsReview)) &&
    members.every((member) => member.decision !== "UNDECIDED")
  );
}

type ReviewQueryDb = Pick<ReturnType<typeof getDatabase>, "select">;

function getContentRevisions(
  db: ReviewQueryDb,
  photoIds: number[]
): Map<number, number> {
  if (photoIds.length === 0) {
    return new Map();
  }
  const fingerprints = db
    .select({
      contentRevision: duplicatePhotoFingerprints.contentRevision,
      photoId: duplicatePhotoFingerprints.photoId,
    })
    .from(duplicatePhotoFingerprints)
    .where(inArray(duplicatePhotoFingerprints.photoId, photoIds))
    .all();
  return new Map(
    fingerprints.map((fingerprint) => [
      fingerprint.photoId,
      fingerprint.contentRevision,
    ])
  );
}

function getReviewStateInTransaction(
  tx: Parameters<ReturnType<typeof getDatabase>["transaction"]>[0] extends (
    arg: infer T
  ) => unknown
    ? T
    : never,
  groupKey: string
): DuplicateReviewState | null {
  const group = tx
    .select()
    .from(duplicateReviewGroups)
    .where(eq(duplicateReviewGroups.groupKey, groupKey))
    .get();
  if (!group) {
    return null;
  }
  const members = tx
    .select()
    .from(duplicateReviewMembers)
    .where(eq(duplicateReviewMembers.groupKey, groupKey))
    .all();
  return toReviewState(group, members);
}

export function getDuplicateReviewState(
  db: ReturnType<typeof getDatabase>,
  groupKey: string
): DuplicateReviewState | null {
  const group = db
    .select()
    .from(duplicateReviewGroups)
    .where(eq(duplicateReviewGroups.groupKey, groupKey))
    .get();
  if (!group) {
    return null;
  }
  const members = db
    .select()
    .from(duplicateReviewMembers)
    .where(eq(duplicateReviewMembers.groupKey, groupKey))
    .all();
  return toReviewState(group, members);
}

export function syncDuplicateReviewStates(
  db: ReturnType<typeof getDatabase>,
  groups: readonly DuplicateGroup[],
  detectionFingerprint = "legacy",
  legacyIgnoredMemberSignatures: ReadonlySet<string> = new Set(),
  transaction?: DuplicateReviewTransaction
): Map<string, DuplicateReviewState> {
  const states = new Map<string, DuplicateReviewState>();
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Review synchronization keeps inheritance, content revisions, and append-only events atomic.
  const sync = (tx: DuplicateReviewTransaction) => {
    for (const group of groups) {
      const photoIds = group.photos
        .map((photo) => photo.id)
        .sort((a, b) => a - b);
      const revisions = getContentRevisions(tx, photoIds);
      const groupVersion = createDuplicateGroupVersion(
        group,
        revisions,
        detectionFingerprint
      );
      const previous = tx
        .select()
        .from(duplicateReviewGroups)
        .where(eq(duplicateReviewGroups.groupKey, group.groupKey))
        .get();
      const previousMembers = tx
        .select()
        .from(duplicateReviewMembers)
        .where(eq(duplicateReviewMembers.groupKey, group.groupKey))
        .all();
      const previousByPhoto = new Map(
        previousMembers.map((member) => [member.photoId, member])
      );
      if (!previous && photoIds.length > 0) {
        // A split or merge gets a fresh group key. Carry forward only the
        // latest per-photo decision; DELETE must be reviewed again, while a
        // KEEP remains a protective choice for unchanged content.
        const historicalMembers = tx
          .select()
          .from(duplicateReviewMembers)
          .where(inArray(duplicateReviewMembers.photoId, photoIds))
          .all()
          .sort((left, right) => right.updatedAt - left.updatedAt);
        for (const member of historicalMembers) {
          if (!previousByPhoto.has(member.photoId)) {
            previousByPhoto.set(member.photoId, member);
          }
        }
      }
      const memberIdsChanged =
        !previous ||
        JSON.stringify(parseMemberIds(previous.memberIdsJson)) !==
          JSON.stringify(photoIds);
      const groupChanged = !previous || previous.groupVersion !== groupVersion;
      const members: DuplicateReviewMemberState[] = photoIds.map((photoId) => {
        const previousMember = previousByPhoto.get(photoId);
        const contentRevision = revisions.get(photoId) ?? 0;
        if (
          !previousMember ||
          previousMember.contentRevision !== contentRevision
        ) {
          return {
            contentRevision,
            decision: "UNDECIDED",
            needsReview: true,
            photoId,
          };
        }
        const previousDecision = isDecision(previousMember.decision)
          ? previousMember.decision
          : "UNDECIDED";
        return {
          contentRevision,
          decision: previousDecision,
          needsReview:
            groupChanged && previousDecision === "DELETE"
              ? true
              : previousMember.needsReview,
          photoId,
        };
      });
      let ignoreState: DuplicateReviewIgnoreState = "ACTIVE";
      if (previous && !memberIdsChanged && !groupChanged) {
        ignoreState = previous.ignoreState as DuplicateReviewIgnoreState;
      } else if (
        !previous &&
        legacyIgnoredMemberSignatures.has(JSON.stringify(photoIds))
      ) {
        ignoreState = "IGNORED";
      }
      const complete = stateComplete(members, ignoreState);
      const needsReview = stateNeedsReview(members, ignoreState);
      const changed =
        !previous ||
        groupChanged ||
        memberIdsChanged ||
        previous.complete !== complete ||
        previous.needsReview !== needsReview ||
        previous.ignoreState !== ignoreState ||
        previousMembers.some((previousMember) => {
          const current = members.find(
            (member) => member.photoId === previousMember.photoId
          );
          return (
            !current ||
            current.decision !== previousMember.decision ||
            current.contentRevision !== previousMember.contentRevision ||
            current.needsReview !== previousMember.needsReview
          );
        });
      const reviewRevision = previous
        ? previous.reviewRevision + (changed ? 1 : 0)
        : 0;
      if (previous) {
        tx.update(duplicateReviewGroups)
          .set({
            complete,
            detectionFingerprint,
            groupVersion,
            ignoreState,
            memberIdsJson: JSON.stringify(photoIds),
            needsReview,
            reviewRevision,
            updatedAt: Date.now(),
          })
          .where(eq(duplicateReviewGroups.groupKey, group.groupKey))
          .run();
        const staleMembers = tx.delete(duplicateReviewMembers);
        if (photoIds.length > 0) {
          staleMembers
            .where(
              and(
                eq(duplicateReviewMembers.groupKey, group.groupKey),
                sqlNotInPhotoIds(photoIds)
              )
            )
            .run();
        } else {
          staleMembers
            .where(eq(duplicateReviewMembers.groupKey, group.groupKey))
            .run();
        }
      } else {
        tx.insert(duplicateReviewGroups)
          .values({
            complete,
            detectionFingerprint,
            groupKey: group.groupKey,
            groupVersion,
            ignoreState,
            memberIdsJson: JSON.stringify(photoIds),
            needsReview,
            reviewRevision,
          })
          .run();
      }
      for (const member of members) {
        tx.insert(duplicateReviewMembers)
          .values({
            contentRevision: member.contentRevision,
            decision: member.decision,
            groupKey: group.groupKey,
            needsReview: member.needsReview,
            photoId: member.photoId,
          })
          .onConflictDoUpdate({
            set: {
              contentRevision: member.contentRevision,
              decision: member.decision,
              needsReview: member.needsReview,
              updatedAt: Date.now(),
            },
            target: [
              duplicateReviewMembers.groupKey,
              duplicateReviewMembers.photoId,
            ],
          })
          .run();
      }
      if (changed) {
        tx.insert(duplicateReviewEvents)
          .values({
            detailsJson: JSON.stringify({
              groupChanged,
              memberIdsChanged,
            }),
            eventType: previous ? "SCAN_RECONCILED" : "CREATED",
            groupKey: group.groupKey,
            groupVersion,
            reviewRevision,
          })
          .run();
      }
      states.set(
        group.groupKey,
        getReviewStateInTransaction(tx, group.groupKey) as DuplicateReviewState
      );
    }
  };
  if (transaction) {
    sync(transaction);
  } else {
    db.transaction(sync);
  }
  return states;
}

function sqlNotInPhotoIds(photoIds: number[]) {
  return notInArray(duplicateReviewMembers.photoId, photoIds);
}

export function updateDuplicateReviewState(
  db: ReturnType<typeof getDatabase>,
  input: {
    decisions: Array<{
      decision: DuplicateReviewDecision;
      photoId: number;
    }>;
    expectedReviewRevision: number;
    groupKey: string;
    groupVersion: string;
    ignoreState?: DuplicateReviewIgnoreState;
  }
): DuplicateReviewState {
  return db.transaction((tx) => {
    const group = tx
      .select()
      .from(duplicateReviewGroups)
      .where(eq(duplicateReviewGroups.groupKey, input.groupKey))
      .get();
    if (!group) {
      throw new Error("Duplicate review state is missing; rescan first");
    }
    if (group.groupVersion !== input.groupVersion) {
      throw new Error("Duplicate group is stale; rescan before reviewing");
    }
    if (group.reviewRevision !== input.expectedReviewRevision) {
      throw new Error("Duplicate review is stale; refresh before reviewing");
    }
    if (group.ignoreState !== "ACTIVE") {
      throw new Error("Ignored duplicate group cannot be reviewed");
    }
    const currentMembers = tx
      .select()
      .from(duplicateReviewMembers)
      .where(eq(duplicateReviewMembers.groupKey, input.groupKey))
      .all();
    const byPhoto = new Map(
      currentMembers.map((member) => [member.photoId, member])
    );
    const submittedIds = new Set<number>();
    for (const decision of input.decisions) {
      if (submittedIds.has(decision.photoId)) {
        throw new Error("A photo decision was submitted more than once");
      }
      submittedIds.add(decision.photoId);
      const member = byPhoto.get(decision.photoId);
      if (!member) {
        throw new Error("Photo does not belong to the duplicate group");
      }
      tx.update(duplicateReviewMembers)
        .set({
          decision: decision.decision,
          needsReview: decision.decision === "UNDECIDED",
          updatedAt: Date.now(),
        })
        .where(
          and(
            eq(duplicateReviewMembers.groupKey, input.groupKey),
            eq(duplicateReviewMembers.photoId, decision.photoId)
          )
        )
        .run();
      tx.insert(duplicateReviewEvents)
        .values({
          decision: decision.decision,
          eventType: "USER_DECISION",
          groupKey: input.groupKey,
          groupVersion: input.groupVersion,
          photoId: decision.photoId,
          reviewRevision: input.expectedReviewRevision + 1,
        })
        .run();
    }
    const nextMembers = tx
      .select()
      .from(duplicateReviewMembers)
      .where(eq(duplicateReviewMembers.groupKey, input.groupKey))
      .all()
      .map((member) => ({
        contentRevision: member.contentRevision,
        decision: isDecision(member.decision) ? member.decision : "UNDECIDED",
        needsReview: member.needsReview,
        photoId: member.photoId,
      }));
    const ignoreState =
      input.ignoreState ?? (group.ignoreState as DuplicateReviewIgnoreState);
    // Partial progress (including a draft without a keeper) is saveable.
    // stateComplete and deletion-plan validation still require a keeper.
    const nextRevision = input.expectedReviewRevision + 1;
    const result = tx
      .update(duplicateReviewGroups)
      .set({
        complete: stateComplete(nextMembers, ignoreState),
        ignoreState,
        needsReview: stateNeedsReview(nextMembers, ignoreState),
        reviewRevision: nextRevision,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(duplicateReviewGroups.groupKey, input.groupKey),
          eq(duplicateReviewGroups.reviewRevision, input.expectedReviewRevision)
        )
      )
      .run();
    if (result.changes !== 1) {
      throw new Error("Duplicate review is stale; refresh before reviewing");
    }
    return getReviewStateInTransaction(
      tx,
      input.groupKey
    ) as DuplicateReviewState;
  });
}

export function applyDuplicateKeepCount(
  db: ReturnType<typeof getDatabase>,
  input: {
    count: number;
    expectedReviewRevision: number;
    groupKey: string;
    groupVersion: string;
  }
): DuplicateReviewState {
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Bulk keep-count review validates and records every member atomically.
  return db.transaction((tx) => {
    const group = tx
      .select()
      .from(duplicateReviewGroups)
      .where(eq(duplicateReviewGroups.groupKey, input.groupKey))
      .get();
    if (!group) {
      throw new Error("Duplicate review state is missing; rescan first");
    }
    if (group.groupVersion !== input.groupVersion) {
      throw new Error("Duplicate group is stale; rescan before reviewing");
    }
    if (group.reviewRevision !== input.expectedReviewRevision) {
      throw new Error("Duplicate review is stale; refresh before reviewing");
    }
    if (group.ignoreState !== "ACTIVE") {
      throw new Error("Ignored duplicate group cannot be reviewed");
    }
    const currentMembers = tx
      .select()
      .from(duplicateReviewMembers)
      .where(eq(duplicateReviewMembers.groupKey, input.groupKey))
      .all();
    if (
      !Number.isSafeInteger(input.count) ||
      input.count < 1 ||
      input.count > currentMembers.length
    ) {
      throw new Error("Keep count must be between 1 and the group size");
    }
    const memberIds = currentMembers.map((member) => member.photoId);
    const memberPhotos = tx
      .select()
      .from(photos)
      .where(inArray(photos.id, memberIds))
      .all();
    if (
      memberPhotos.length !== memberIds.length ||
      memberPhotos.some((photo) => photo.deletedAt !== null)
    ) {
      throw new Error("Duplicate group changed; rescan before reviewing");
    }
    const ranked = rankDuplicatePhotos(memberPhotos);
    const keepIds = new Set(
      ranked.slice(0, input.count).map((photo) => photo.id)
    );
    const nextRevision = input.expectedReviewRevision + 1;
    for (const member of currentMembers) {
      const decision = keepIds.has(member.photoId) ? "KEEP" : "DELETE";
      tx.update(duplicateReviewMembers)
        .set({ decision, needsReview: false, updatedAt: Date.now() })
        .where(
          and(
            eq(duplicateReviewMembers.groupKey, input.groupKey),
            eq(duplicateReviewMembers.photoId, member.photoId)
          )
        )
        .run();
      tx.insert(duplicateReviewEvents)
        .values({
          decision,
          eventType: "USER_BULK_KEEP_COUNT",
          groupKey: input.groupKey,
          groupVersion: input.groupVersion,
          photoId: member.photoId,
          reviewRevision: nextRevision,
        })
        .run();
    }
    const updated = tx
      .update(duplicateReviewGroups)
      .set({
        complete: true,
        ignoreState: "ACTIVE",
        needsReview: false,
        reviewRevision: nextRevision,
        updatedAt: Date.now(),
      })
      .where(
        and(
          eq(duplicateReviewGroups.groupKey, input.groupKey),
          eq(duplicateReviewGroups.reviewRevision, input.expectedReviewRevision)
        )
      )
      .run();
    if (updated.changes !== 1) {
      throw new Error("Duplicate review is stale; refresh before reviewing");
    }
    return getReviewStateInTransaction(
      tx,
      input.groupKey
    ) as DuplicateReviewState;
  });
}
