import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
  sql,
} from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { normalizeAdvancedExif } from "@/services/advanced-exif-normalizer";
import { hammingDistance } from "@/services/bk-tree";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import { getSequenceDetectionSettings } from "@/services/sequence-detection-settings";
import { getSetting, setSetting } from "@/services/settings-manager";
import type { SequenceChangeEvent } from "@/types/photo-sequence";
import {
  defaultSequenceDetectionSettings,
  type SequenceDetectionSettings,
} from "@/types/sequence-detection-settings";

const BURST_GAP_MS = 2000;
const MAX_BURST_PHASH_DISTANCE = 12;
const PHOTO_SEQUENCE_REVISION_KEY = "photoSequences.revision";

export interface SequenceDetectionCandidate {
  burstFrameNumber: number | null;
  burstGroupId: string | null;
  camera: string | null;
  capturedAt: number;
  folderId: number | null;
  id: number;
  isContinuousDrive: boolean;
  lens: string | null;
  phash: string | null;
}

function hasCompleteCaptureContext(item: SequenceDetectionCandidate): boolean {
  return Boolean(item.camera?.trim() && item.lens?.trim());
}

function parseCaptureMetadata(metadata: {
  capture?: {
    burstGroupId?: unknown;
    burstFrameNumber?: unknown;
    burstSignalConfidence?: unknown;
    captureTimestampMs?: unknown;
    isContinuousDrive?: unknown;
  };
}) {
  const burstGroupId = metadata.capture?.burstGroupId;
  const burstFrameNumber = metadata.capture?.burstFrameNumber;
  const capturedAt = metadata.capture?.captureTimestampMs;
  return {
    burstGroupId:
      metadata.capture?.burstSignalConfidence === "high" &&
      burstGroupId !== null &&
      burstGroupId !== undefined &&
      String(burstGroupId).trim()
        ? String(burstGroupId).trim()
        : null,
    capturedAt:
      typeof capturedAt === "number" && Number.isFinite(capturedAt)
        ? capturedAt
        : null,
    burstFrameNumber:
      typeof burstFrameNumber === "number" &&
      Number.isSafeInteger(burstFrameNumber) &&
      burstFrameNumber > 0
        ? burstFrameNumber
        : null,
    isContinuousDrive: metadata.capture?.isContinuousDrive === true,
  };
}

export function readCaptureMetadata(
  normalizedJson: string | null,
  vendorRawJson: string | null
) {
  const empty: ReturnType<typeof parseCaptureMetadata> = {
    burstGroupId: null,
    burstFrameNumber: null,
    capturedAt: null,
    isContinuousDrive: false,
  };
  let normalized: ReturnType<typeof parseCaptureMetadata> = empty;
  let vendor: ReturnType<typeof parseCaptureMetadata> = empty;
  if (normalizedJson) {
    try {
      normalized = parseCaptureMetadata(JSON.parse(normalizedJson));
    } catch {
      // Continue with the vendor payload when normalized metadata is invalid.
    }
  }
  if (vendorRawJson) {
    try {
      vendor = parseCaptureMetadata(
        normalizeAdvancedExif(JSON.parse(vendorRawJson))
      );
    } catch {
      // Keep the normalized payload when the vendor payload is invalid.
    }
  }
  return {
    burstGroupId: normalized.burstGroupId ?? vendor.burstGroupId,
    burstFrameNumber: normalized.burstFrameNumber ?? vendor.burstFrameNumber,
    capturedAt: normalized.capturedAt ?? vendor.capturedAt,
    isContinuousDrive: normalized.isContinuousDrive || vendor.isContinuousDrive,
  };
}

function hasContinuousBurstEvidence(item: SequenceDetectionCandidate): boolean {
  return item.isContinuousDrive && item.burstFrameNumber !== null;
}

function isConsecutiveBurstFrame(
  previous: SequenceDetectionCandidate,
  item: SequenceDetectionCandidate
): boolean {
  const previousFrameNumber = previous.burstFrameNumber;
  return (
    hasContinuousBurstEvidence(previous) &&
    hasContinuousBurstEvidence(item) &&
    previousFrameNumber !== null &&
    item.burstFrameNumber === previousFrameNumber + 1
  );
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function isCompatible(
  previous: SequenceDetectionCandidate,
  item: SequenceDetectionCandidate,
  minGap: number,
  maxGap: number,
  burstMode: "group-id" | "continuous-drive" | null,
  timelapsePHashDistance: number
): boolean {
  const gap = item.capturedAt - previous.capturedAt;
  return (
    hasCompleteCaptureContext(previous) &&
    hasCompleteCaptureContext(item) &&
    previous.phash !== null &&
    item.phash !== null &&
    gap >= minGap &&
    gap <= maxGap &&
    item.camera === previous.camera &&
    item.lens === previous.lens &&
    hammingDistance(previous.phash, item.phash) <=
      (burstMode ? MAX_BURST_PHASH_DISTANCE : timelapsePHashDistance) &&
    (!burstMode ||
      burstMode === "continuous-drive" ||
      (previous.burstGroupId !== null &&
        previous.burstGroupId === item.burstGroupId)) &&
    (burstMode !== "continuous-drive" ||
      isConsecutiveBurstFrame(previous, item))
  );
}

function contiguous(
  items: SequenceDetectionCandidate[],
  minGap: number,
  maxGap: number,
  burstMode: "group-id" | "continuous-drive" | null = null,
  timelapsePHashDistance = defaultSequenceDetectionSettings.timelapsePHashDistance
) {
  const groups: SequenceDetectionCandidate[][] = [];
  let current: SequenceDetectionCandidate[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    const compatible =
      previous &&
      isCompatible(
        previous,
        item,
        minGap,
        maxGap,
        burstMode,
        timelapsePHashDistance
      );
    if (!compatible && current.length) {
      groups.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function stableInterval(
  items: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings
) {
  if (
    items.length < settings.timelapseMinFrames ||
    items.some((item) => !hasCompleteCaptureContext(item))
  ) {
    return false;
  }
  const gaps = items
    .slice(1)
    .map((item, index) => item.capturedAt - items[index].capturedAt);
  const interval = median(gaps);
  return (
    interval >= settings.minTimelapseGapMs &&
    interval <= settings.maxTimelapseGapMs &&
    gaps.every((gap) => isTimelapseGap(gap, interval, settings))
  );
}

function isTimelapseGap(
  gap: number,
  interval: number,
  settings: SequenceDetectionSettings
): boolean {
  const multiple = Math.round(gap / interval);
  return (
    multiple >= 1 &&
    multiple <= settings.maxMissingFrames + 1 &&
    Math.abs(gap - interval * multiple) <=
      Math.max(1000, interval * settings.rhythmTolerance)
  );
}

function stableTimelapseGroups(
  items: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings
): SequenceDetectionCandidate[][] {
  const groups: SequenceDetectionCandidate[][] = [];
  let current: SequenceDetectionCandidate[] = [];
  let gaps: number[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    if (!previous) {
      current.push(item);
      continue;
    }
    const gap = item.capturedAt - previous.capturedAt;
    const interval = gaps.length ? median(gaps) : gap;
    const intervalIsStable = isTimelapseGap(gap, interval, settings);
    if (!intervalIsStable) {
      groups.push(current);
      current = [item];
      gaps = [];
      continue;
    }
    gaps.push(gap);
    current.push(item);
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

function detectCaptureContextCandidates(
  entries: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings = defaultSequenceDetectionSettings
) {
  const sortedEntries = [...entries].sort(
    (left, right) => left.capturedAt - right.capturedAt
  );
  const burstCandidates = sortedEntries.filter(
    (entry) => entry.burstGroupId !== null && hasCompleteCaptureContext(entry)
  );
  const detected: Array<{
    type: "burst" | "timelapse";
    members: SequenceDetectionCandidate[];
  }> = [];
  for (const group of contiguous(
    burstCandidates,
    0,
    BURST_GAP_MS,
    "group-id"
  )) {
    if (group.length >= settings.burstMinFrames) {
      detected.push({ type: "burst", members: group });
    }
  }
  const continuousDriveCandidates = sortedEntries.filter(
    (entry) => entry.burstGroupId === null && hasContinuousBurstEvidence(entry)
  );
  for (const group of contiguous(
    continuousDriveCandidates,
    0,
    BURST_GAP_MS,
    "continuous-drive"
  )) {
    if (group.length >= settings.burstMinFrames) {
      detected.push({ type: "burst", members: group });
    }
  }
  for (const contiguousGroup of contiguous(
    sortedEntries.filter(
      (entry) =>
        entry.burstGroupId === null && !hasContinuousBurstEvidence(entry)
    ),
    settings.minTimelapseGapMs,
    settings.maxTimelapseGapMs,
    null,
    settings.timelapsePHashDistance
  )) {
    for (const group of stableTimelapseGroups(contiguousGroup, settings)) {
      if (
        group.length >= settings.timelapseMinFrames &&
        stableInterval(group, settings)
      ) {
        detected.push({ type: "timelapse", members: group });
      }
    }
  }
  return detected;
}

/** Independent capture contexts cannot interrupt or join one another. */
export function detectSequenceCandidates(
  entries: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings = defaultSequenceDetectionSettings
) {
  const groups = new Map<string, SequenceDetectionCandidate[]>();
  for (const entry of entries) {
    if (
      !(
        hasCompleteCaptureContext(entry) && Number.isFinite(entry.capturedAt)
      ) ||
      entry.capturedAt <= 0
    ) {
      continue;
    }
    const key = JSON.stringify([entry.folderId, entry.camera, entry.lens]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  return [...groups.values()].flatMap((group) =>
    detectCaptureContextCandidates(group, settings)
  );
}

type Database = ReturnType<typeof getDatabase>;

/** Remove soft-deleted members and keep persisted sequence metadata accurate. */
export function cleanupDeletedPhotoSequenceMembers(db: Database): boolean {
  return db.transaction(() => cleanupSequenceMembers(db));
}

function cleanupSequenceMembers(db: Database): boolean {
  const deletedMemberIds = db
    .select({ id: photoSequenceMembers.id })
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .where(isNotNull(photos.deletedAt))
    .all()
    .map((member) => member.id);
  if (deletedMemberIds.length > 0) {
    db.delete(photoSequenceMembers)
      .where(inArray(photoSequenceMembers.id, deletedMemberIds))
      .run();
  }

  let changed = deletedMemberIds.length > 0;
  const sequences = db
    .select({
      frameCount: photoSequences.frameCount,
      id: photoSequences.id,
      representativePhotoId: photoSequences.representativePhotoId,
      startedAt: photoSequences.startedAt,
      endedAt: photoSequences.endedAt,
    })
    .from(photoSequences)
    .all();
  for (const sequence of sequences) {
    const members = db
      .select({
        id: photoSequenceMembers.id,
        position: photoSequenceMembers.position,
        photoId: photoSequenceMembers.photoId,
        dateTaken: exifData.dateTaken,
        normalizedJson: advancedExifData.normalizedJson,
        vendorRawJson: advancedExifData.vendorRawJson,
      })
      .from(photoSequenceMembers)
      .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
      .leftJoin(exifData, eq(exifData.photoId, photos.id))
      .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
      .where(
        and(
          eq(photoSequenceMembers.sequenceId, sequence.id),
          isNull(photos.deletedAt)
        )
      )
      .orderBy(asc(photoSequenceMembers.position))
      .all();
    if (members.length < 2) {
      db.delete(photoSequences).where(eq(photoSequences.id, sequence.id)).run();
      changed = true;
      continue;
    }
    const representativePhotoId = members.some(
      (member) => member.photoId === sequence.representativePhotoId
    )
      ? sequence.representativePhotoId
      : (members[0]?.photoId ?? null);
    const times = members.flatMap((member) => {
      const time =
        readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
          .capturedAt ?? member.dateTaken;
      return time != null && Number.isFinite(time) ? [time] : [];
    });
    const startedAt = times.length ? Math.min(...times) : sequence.startedAt;
    const endedAt = times.length ? Math.max(...times) : sequence.endedAt;
    if (members.some((member, index) => member.position !== index)) {
      const offset =
        Math.max(...members.map((member) => member.position)) +
        members.length +
        1;
      db.update(photoSequenceMembers)
        .set({ position: sql`${photoSequenceMembers.position} + ${offset}` })
        .where(eq(photoSequenceMembers.sequenceId, sequence.id))
        .run();
      for (const [position, member] of members.entries()) {
        db.update(photoSequenceMembers)
          .set({ position })
          .where(eq(photoSequenceMembers.id, member.id))
          .run();
      }
      changed = true;
    }
    if (
      sequence.startedAt !== startedAt ||
      sequence.endedAt !== endedAt ||
      sequence.frameCount !== members.length ||
      sequence.representativePhotoId !== representativePhotoId
    ) {
      db.update(photoSequences)
        .set({
          startedAt,
          endedAt,
          frameCount: members.length,
          representativePhotoId,
          updatedAt: Date.now(),
        })
        .where(eq(photoSequences.id, sequence.id))
        .run();
      changed = true;
    }
  }
  return changed;
}

export type SequenceChangeReason = SequenceChangeEvent["reason"];

/** Notify only after the owning transaction commits. */
export function notifySequencesChanged(
  folderId: number | undefined,
  reason: SequenceChangeReason,
  details?: Partial<
    Pick<
      SequenceChangeEvent,
      | "orderedMemberIds"
      | "sequenceId"
      | "affectedSequenceIds"
      | "deletedSequenceIds"
      | "replacementSequenceIds"
    >
  >
): number {
  invalidateCountCache();
  const revision = bumpPhotoSequenceRevision();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("sequences-changed", {
        folderId,
        reason,
        ...details,
        revision,
        version: revision,
      });
    }
  }
  return revision;
}

export function getPhotoSequenceRevision(): number {
  const value = Number.parseInt(
    getSetting(PHOTO_SEQUENCE_REVISION_KEY) ?? "0",
    10
  );
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function bumpPhotoSequenceRevision(): number {
  const next = getPhotoSequenceRevision() + 1;
  setSetting(PHOTO_SEQUENCE_REVISION_KEY, String(next));
  return next;
}

export function getSequenceFolderIds(db: Database, folderId?: number) {
  return folderId == null
    ? undefined
    : getFolderSubtreeIds(
        db
          .select({ id: folders.id, parentId: folders.parentId })
          .from(folders)
          .all(),
        folderId
      );
}

function automaticSequences(db: Database, folderId?: number) {
  const folderIds = getSequenceFolderIds(db, folderId);
  return db
    .select()
    .from(photoSequences)
    .where(
      and(
        eq(photoSequences.source, "auto"),
        eq(photoSequences.userLocked, false),
        folderIds ? inArray(photoSequences.folderId, folderIds) : undefined
      )
    )
    .all();
}

function persistDetectedSequences(
  db: Database,
  candidates: SequenceDetectionCandidate[],
  folderId?: number
) {
  const detected = detectSequenceCandidates(
    candidates,
    getSequenceDetectionSettings()
  );
  const existing = automaticSequences(db, folderId);
  const existingIds = existing.map((sequence) => sequence.id);
  const memberRows = existingIds.length
    ? db
        .select()
        .from(photoSequenceMembers)
        .where(inArray(photoSequenceMembers.sequenceId, existingIds))
        .orderBy(asc(photoSequenceMembers.position))
        .all()
    : [];
  const idsBySequence = new Map<number, number[]>();
  for (const member of memberRows) {
    const ids = idsBySequence.get(member.sequenceId) ?? [];
    ids.push(member.photoId);
    idsBySequence.set(member.sequenceId, ids);
  }
  const key = (type: string, ids: number[]) => `${type}:${ids.join(",")}`;
  const byKey = new Map(
    existing.map((sequence) => [
      key(sequence.type, idsBySequence.get(sequence.id) ?? []),
      sequence,
    ])
  );
  const retained = new Set<number>();
  for (const sequence of detected) {
    const match = byKey.get(
      key(
        sequence.type,
        sequence.members.map((member) => member.id)
      )
    );
    if (match) {
      retained.add(match.id);
    }
  }
  const deletedSequenceIds = existingIds.filter((id) => !retained.has(id));
  if (deletedSequenceIds.length) {
    db.delete(photoSequences)
      .where(inArray(photoSequences.id, deletedSequenceIds))
      .run();
  }
  const replacementSequenceIds: number[] = [];
  for (const sequence of detected) {
    const first = sequence.members[0];
    const last = sequence.members.at(-1);
    if (!last) {
      continue;
    }
    const match = byKey.get(
      key(
        sequence.type,
        sequence.members.map((member) => member.id)
      )
    );
    if (match) {
      if (
        match.startedAt !== first.capturedAt ||
        match.endedAt !== last.capturedAt
      ) {
        db.update(photoSequences)
          .set({
            startedAt: first.capturedAt,
            endedAt: last.capturedAt,
            updatedAt: Date.now(),
          })
          .where(eq(photoSequences.id, match.id))
          .run();
      }
      continue;
    }
    const inserted = db
      .insert(photoSequences)
      .values({
        folderId: first.folderId,
        type: sequence.type,
        representativePhotoId: first.id,
        startedAt: first.capturedAt,
        endedAt: last.capturedAt,
        frameCount: sequence.members.length,
        updatedAt: Date.now(),
      })
      .returning({ id: photoSequences.id })
      .get();
    db.insert(photoSequenceMembers)
      .values(
        sequence.members.map((member, position) => ({
          sequenceId: inserted.id,
          photoId: member.id,
          position,
        }))
      )
      .run();
    replacementSequenceIds.push(inserted.id);
  }
  return {
    deletedSequenceIds,
    replacementSequenceIds,
    nextAutomatic: detected.length,
    timelapseSegments: detected.filter(
      (sequence) => sequence.type === "timelapse"
    ).length,
  };
}

function loadSequenceCandidates(db: Database, folderId?: number) {
  const excludedIds = db
    .select({ photoId: photoSequenceExclusions.photoId })
    .from(photoSequenceExclusions)
    .all()
    .map((row) => row.photoId);
  const lockedSequencePhotoIds = db
    .select({ photoId: photoSequenceMembers.photoId })
    .from(photoSequenceMembers)
    .innerJoin(
      photoSequences,
      eq(photoSequences.id, photoSequenceMembers.sequenceId)
    )
    .where(eq(photoSequences.userLocked, true))
    .all()
    .map((row) => row.photoId);
  const unavailableIds = [
    ...new Set([...excludedIds, ...lockedSequencePhotoIds]),
  ];
  const conditions = [isNull(photos.deletedAt)];
  if (folderId != null) {
    conditions.push(
      inArray(photos.folderId, getSequenceFolderIds(db, folderId) ?? [folderId])
    );
  }
  if (unavailableIds.length) {
    conditions.push(notInArray(photos.id, unavailableIds));
  }
  const rows = db
    .select({
      id: photos.id,
      folderId: photos.folderId,
      dateTaken: exifData.dateTaken,
      camera: exifData.cameraModel,
      lens: exifData.lensModel,
      normalizedJson: advancedExifData.normalizedJson,
      vendorRawJson: advancedExifData.vendorRawJson,
      phash: photos.phash,
    })
    .from(photos)
    .leftJoin(exifData, eq(exifData.photoId, photos.id))
    .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
    .where(and(...conditions))
    .orderBy(
      asc(photos.folderId),
      asc(exifData.dateTaken),
      asc(photos.fileDate)
    )
    .all();
  const skipped = { missingCaptureTime: 0, missingDevice: 0, missingHash: 0 };
  const candidates = rows
    .map((row) => {
      const metadata = readCaptureMetadata(
        row.normalizedJson,
        row.vendorRawJson
      );
      return {
        id: row.id,
        folderId: row.folderId,
        // File timestamps can be rewritten during import/copy. Automatic grouping
        // is intentionally EXIF-only to prevent false positives.
        capturedAt: metadata.capturedAt ?? 0,
        camera: row.camera,
        lens: row.lens,
        phash: row.phash,
        burstGroupId: metadata.burstGroupId,
        burstFrameNumber: metadata.burstFrameNumber,
        isContinuousDrive: metadata.isContinuousDrive,
      };
    })
    .filter((row) => {
      if (row.capturedAt <= 0) {
        skipped.missingCaptureTime += 1;
        return false;
      }
      if (!hasCompleteCaptureContext(row)) {
        skipped.missingDevice += 1;
        return false;
      }
      if (!row.phash) {
        skipped.missingHash += 1;
        return false;
      }
      return true;
    });
  return { candidates, skipped };
}

export function previewPhotoSequences(folderId?: number) {
  const db = getDatabase();
  const { candidates, skipped } = loadSequenceCandidates(db, folderId);
  const detected = detectSequenceCandidates(
    candidates,
    getSequenceDetectionSettings()
  );
  return {
    candidatePhotos: candidates.length,
    skipped,
    existingAutomatic: automaticSequences(db, folderId).length,
    nextAutomatic: detected.length,
    timelapseSegments: detected.filter(
      (sequence) => sequence.type === "timelapse"
    ).length,
  };
}

export function rebuildPhotoSequences(
  folderId?: number,
  reason: SequenceChangeReason = "rebuild",
  notify = true
) {
  const started = Date.now();
  const db = getDatabase();
  const { candidates, skipped } = loadSequenceCandidates(db, folderId);
  const result = db.transaction(() =>
    persistDetectedSequences(db, candidates, folderId)
  );
  const revision = notify
    ? notifySequencesChanged(folderId, reason, result)
    : getPhotoSequenceRevision();
  console.info("[Sequences] detection", {
    folderId,
    candidates: candidates.length,
    sequences: result.nextAutomatic,
    skipped,
    elapsedMs: Date.now() - started,
  });
  return { ...result, processed: candidates.length, skipped, revision };
}

/** Deferred EXIF enrichment calls one complete rebuild for each affected scope. */
export function detectPhotoSequences(
  folderId?: number,
  reason: SequenceChangeReason = "detection"
): number {
  return rebuildPhotoSequences(folderId, reason).processed;
}
