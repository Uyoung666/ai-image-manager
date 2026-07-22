import { and, asc, eq, inArray, isNull, notInArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";

const MIN_FRAMES = 3;
const MIN_TIMELAPSE_FRAMES = 5;
const BURST_GAP_MS = 1500;
const TIMELAPSE_MIN_GAP_MS = 5000;
const TIMELAPSE_MAX_GAP_MS = 10 * 60_000;

type Candidate = {
  id: number;
  folderId: number | null;
  capturedAt: number;
  hasBurstSignal: boolean;
  camera: string | null;
  lens: string | null;
};

function hasCompleteCaptureContext(item: Candidate): boolean {
  return Boolean(item.camera?.trim() && item.lens?.trim());
}

function hasExplicitBurstSequence(normalizedJson: string | null): boolean {
  if (!normalizedJson) {
    return false;
  }
  try {
    const metadata = JSON.parse(normalizedJson) as {
      capture?: { burstSequence?: unknown };
    };
    const value = metadata.capture?.burstSequence;
    return value !== null && value !== undefined && String(value).trim() !== "";
  } catch {
    return false;
  }
}

function contiguous(items: Candidate[], maxGap: number) {
  const groups: Candidate[][] = [];
  let current: Candidate[] = [];
  for (const item of items) {
    const previous = current.at(-1);
    const compatible =
      previous &&
      hasCompleteCaptureContext(previous) &&
      hasCompleteCaptureContext(item) &&
      item.capturedAt - previous.capturedAt <= maxGap &&
      item.camera === previous.camera &&
      item.lens === previous.lens;
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

function stableInterval(items: Candidate[]) {
  if (
    items.length < MIN_TIMELAPSE_FRAMES ||
    items.some((item) => !hasCompleteCaptureContext(item))
  ) {
    return false;
  }
  const gaps = items
    .slice(1)
    .map((item, index) => item.capturedAt - items[index].capturedAt);
  const average = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  return (
    average >= TIMELAPSE_MIN_GAP_MS &&
    average <= TIMELAPSE_MAX_GAP_MS &&
    gaps.every(
      (gap) => Math.abs(gap - average) <= Math.max(1000, average * 0.25)
    )
  );
}

/** Rebuilds only automatic, unlocked sequences. Safe to call after EXIF enrichment. */
export function detectPhotoSequences(folderId?: number): number {
  const db = getDatabase();
  const excludedIds = db
    .select({ photoId: photoSequenceExclusions.photoId })
    .from(photoSequenceExclusions)
    .all()
    .map((row) => row.photoId);
  const conditions = [isNull(photos.deletedAt)];
  if (folderId != null) {
    conditions.push(eq(photos.folderId, folderId));
  }
  if (excludedIds.length) {
    conditions.push(notInArray(photos.id, excludedIds));
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
  const candidates: Candidate[] = rows
    .map((row) => ({
      id: row.id,
      folderId: row.folderId,
      // File timestamps can be rewritten during import/copy. Automatic grouping
      // is intentionally EXIF-only to prevent false positives.
      capturedAt: row.dateTaken ?? 0,
      camera: row.camera,
      lens: row.lens,
      // Drive mode alone means only that the camera supports continuous drive;
      // it is not evidence that this individual frame belongs to a burst.
      hasBurstSignal: hasExplicitBurstSequence(row.normalizedJson),
    }))
    .filter((row) => row.capturedAt > 0);

  db.transaction(() => {
    const unlocked = db
      .select({ id: photoSequences.id })
      .from(photoSequences)
      .where(
        and(
          eq(photoSequences.source, "auto"),
          eq(photoSequences.userLocked, false)
        )
      )
      .all()
      .map((row) => row.id);
    if (unlocked.length) {
      db.delete(photoSequences)
        .where(inArray(photoSequences.id, unlocked))
        .run();
    }
    const byFolder = new Map<number | null, Candidate[]>();
    for (const candidate of candidates) {
      byFolder.set(candidate.folderId, [
        ...(byFolder.get(candidate.folderId) ?? []),
        candidate,
      ]);
    }
    for (const [candidateFolderId, entries] of byFolder) {
      const claimed = new Set<number>();
      const burstCandidates = entries.filter(
        (entry) => entry.hasBurstSignal && hasCompleteCaptureContext(entry)
      );
      const detected: Array<{
        type: "burst" | "timelapse";
        members: Candidate[];
      }> = [];
      for (const group of contiguous(burstCandidates, BURST_GAP_MS)) {
        if (group.length >= MIN_FRAMES) {
          detected.push({ type: "burst", members: group });
        }
      }
      for (const group of contiguous(
        entries.filter((entry) => !claimed.has(entry.id)),
        TIMELAPSE_MAX_GAP_MS
      )) {
        if (
          group.length >= MIN_TIMELAPSE_FRAMES &&
          stableInterval(group) &&
          !group.some((entry) => burstCandidates.includes(entry))
        ) {
          detected.push({ type: "timelapse", members: group });
        }
      }
      for (const sequence of detected) {
        if (sequence.members.some((member) => claimed.has(member.id))) {
          continue;
        }
        const first = sequence.members[0];
        const last = sequence.members.at(-1)!;
        const inserted = db
          .insert(photoSequences)
          .values({
            folderId: candidateFolderId,
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
        sequence.members.forEach((member) => claimed.add(member.id));
      }
    }
  });
  return candidates.length;
}
