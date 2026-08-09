import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  notInArray,
} from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";
import { normalizeAdvancedExif } from "@/services/advanced-exif-normalizer";
import { hammingDistance } from "@/services/bk-tree";
import {
  defaultSequenceDetectionSettings,
  getSequenceDetectionSettings,
  type SequenceDetectionSettings,
} from "@/services/sequence-detection-settings";
import { getSetting, setSetting } from "@/services/settings-manager";

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
  for (const item of items) {
    const previous = current.at(-1);
    if (!previous) {
      current.push(item);
      continue;
    }
    const gaps = current
      .slice(1)
      .map((entry, index) => entry.capturedAt - current[index].capturedAt);
    const gap = item.capturedAt - previous.capturedAt;
    const interval = gaps.length ? median(gaps) : gap;
    const intervalIsStable = isTimelapseGap(gap, interval, settings);
    if (!intervalIsStable) {
      groups.push(current);
      current = [item];
      continue;
    }
    current.push(item);
  }
  if (current.length) {
    groups.push(current);
  }
  return groups;
}

export function detectSequenceCandidates(
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

type Database = ReturnType<typeof getDatabase>;

/** Remove soft-deleted members and keep persisted sequence metadata accurate. */
export function cleanupDeletedPhotoSequenceMembers(db: Database): boolean {
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
    })
    .from(photoSequences)
    .all();
  for (const sequence of sequences) {
    const members = db
      .select({ photoId: photoSequenceMembers.photoId })
      .from(photoSequenceMembers)
      .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
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
    if (
      sequence.frameCount !== members.length ||
      sequence.representativePhotoId !== representativePhotoId
    ) {
      db.update(photoSequences)
        .set({
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

export type SequenceChangeReason =
  | "detection"
  | "manual"
  | "rebuild"
  | "restore";

let sequenceVersion = 0;

/** Notify every open renderer after a sequence mutation has committed. */
export function notifySequencesChanged(
  folderId: number | undefined,
  reason: SequenceChangeReason
): void {
  bumpPhotoSequenceRevision();
  sequenceVersion += 1;
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send("sequences-changed", {
        folderId,
        reason,
        version: sequenceVersion,
      });
    }
  }
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

function deleteUnlockedAutomaticSequences(db: Database, folderId?: number) {
  const conditions = [
    eq(photoSequences.source, "auto"),
    eq(photoSequences.userLocked, false),
  ];
  if (folderId != null) {
    conditions.push(eq(photoSequences.folderId, folderId));
  }
  const unlocked = db
    .select({ id: photoSequences.id })
    .from(photoSequences)
    .where(and(...conditions))
    .all()
    .map((row) => row.id);
  if (unlocked.length) {
    db.delete(photoSequences).where(inArray(photoSequences.id, unlocked)).run();
  }
}

function insertDetectedSequences(
  db: Database,
  folderId: number | null,
  entries: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings
) {
  const claimed = new Set<number>();
  for (const sequence of detectSequenceCandidates(entries, settings)) {
    if (sequence.members.some((member) => claimed.has(member.id))) {
      continue;
    }
    const first = sequence.members[0];
    const last = sequence.members.at(-1);
    if (!(first && last)) {
      continue;
    }
    const inserted = db
      .insert(photoSequences)
      .values({
        folderId,
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
    for (const member of sequence.members) {
      claimed.add(member.id);
    }
  }
}

function rebuildDetectedSequences(
  db: Database,
  candidates: SequenceDetectionCandidate[],
  settings: SequenceDetectionSettings
) {
  const byFolder = new Map<number | null, SequenceDetectionCandidate[]>();
  for (const candidate of candidates) {
    byFolder.set(candidate.folderId, [
      ...(byFolder.get(candidate.folderId) ?? []),
      candidate,
    ]);
  }
  for (const [folderId, entries] of byFolder) {
    insertDetectedSequences(db, folderId, entries, settings);
  }
}

function loadSequenceCandidates(
  db: Database,
  folderId?: number
): SequenceDetectionCandidate[] {
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
    conditions.push(eq(photos.folderId, folderId));
  }
  if (unavailableIds.length) {
    conditions.push(notInArray(photos.id, unavailableIds));
  }
  const rows = db
    .select({
      id: photos.id,
      folderId: photos.folderId,
      fileDate: photos.fileDate,
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
  return rows
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
    .filter((row) => row.capturedAt > 0);
}

export function previewPhotoSequences(folderId?: number) {
  const db = getDatabase();
  const candidates = loadSequenceCandidates(db, folderId);
  const detected = detectSequenceCandidates(
    candidates,
    getSequenceDetectionSettings()
  );
  const existingAutomatic = db
    .select({ id: photoSequences.id })
    .from(photoSequences)
    .where(
      and(
        eq(photoSequences.source, "auto"),
        eq(photoSequences.userLocked, false),
        folderId == null ? undefined : eq(photoSequences.folderId, folderId)
      )
    )
    .all().length;
  return {
    candidatePhotos: candidates.length,
    existingAutomatic,
    nextAutomatic: detected.length,
    timelapseSegments: detected.filter(
      (sequence) => sequence.type === "timelapse"
    ).length,
  };
}

/** Rebuilds only automatic, unlocked sequences. Safe to call after EXIF enrichment. */
export function detectPhotoSequences(
  folderId?: number,
  reason: SequenceChangeReason = "detection"
): number {
  const db = getDatabase();
  const candidates = loadSequenceCandidates(db, folderId);

  const settings = getSequenceDetectionSettings();
  db.transaction(() => {
    deleteUnlockedAutomaticSequences(db, folderId);
    rebuildDetectedSequences(db, candidates, settings);
  });
  notifySequencesChanged(folderId, reason);
  return candidates.length;
}
