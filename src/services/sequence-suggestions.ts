import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  folders,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
} from "@/db/schema";
import { hammingDistance } from "@/services/bk-tree";
import { getFolderSubtreeIds } from "@/services/folder-hierarchy";
import {
  getPhotoSequenceRevision,
  notifySequencesChanged,
  readCaptureMetadata,
} from "@/services/photo-sequences";
import { getSequenceDetectionSettings } from "@/services/sequence-detection-settings";
import { mergeSequencePair } from "@/services/sequence-members";
import type {
  AcceptSequenceSuggestionResult,
  SequenceSuggestion,
  SequenceSuggestionSegment,
} from "@/types/photo-sequence";

type Database = ReturnType<typeof getDatabase>;

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function loadSegments(db: Database, folderId?: number) {
  const folderIds =
    folderId == null
      ? undefined
      : getFolderSubtreeIds(
          db
            .select({ id: folders.id, parentId: folders.parentId })
            .from(folders)
            .all(),
          folderId
        );
  const sequences = db
    .select()
    .from(photoSequences)
    .where(
      and(
        eq(photoSequences.type, "timelapse"),
        folderIds ? inArray(photoSequences.folderId, folderIds) : undefined
      )
    )
    .all();
  if (!sequences.length) {
    return [];
  }
  const rows = db
    .select({
      sequenceId: photoSequenceMembers.sequenceId,
      photo: {
        id: photos.id,
        path: photos.path,
        filename: photos.filename,
        fileSize: photos.fileSize,
        width: photos.width,
        height: photos.height,
        thumbnailPath: photos.thumbnailPath,
        isIndexed: photos.isIndexed,
      },
      cameraModel: exifData.cameraModel,
      lensModel: exifData.lensModel,
      normalizedJson: advancedExifData.normalizedJson,
      vendorRawJson: advancedExifData.vendorRawJson,
      phash: photos.phash,
    })
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .leftJoin(exifData, eq(exifData.photoId, photos.id))
    .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
    .where(
      and(
        inArray(
          photoSequenceMembers.sequenceId,
          sequences.map((sequence) => sequence.id)
        ),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(asc(photoSequenceMembers.position))
    .all();
  const bySequence = new Map<number, typeof rows>();
  for (const row of rows) {
    const group = bySequence.get(row.sequenceId) ?? [];
    group.push(row);
    bySequence.set(row.sequenceId, group);
  }
  const settings = getSequenceDetectionSettings();
  return sequences.flatMap((sequence) => {
    const members = (bySequence.get(sequence.id) ?? []).map((row) => ({
      ...row,
      photo: {
        ...row.photo,
        fileSize: row.photo.fileSize ?? 0,
        width: row.photo.width ?? 0,
        height: row.photo.height ?? 0,
      },
      capturedAt: readCaptureMetadata(row.normalizedJson, row.vendorRawJson)
        .capturedAt,
    }));
    const camera = members[0]?.cameraModel;
    const lens = members[0]?.lensModel;
    if (
      members.length < 2 ||
      members.length !== sequence.frameCount ||
      !camera?.trim() ||
      !lens?.trim() ||
      members.some(
        (member) =>
          member.capturedAt == null ||
          member.capturedAt <= 0 ||
          member.cameraModel !== camera ||
          member.lensModel !== lens
      )
    ) {
      return [];
    }
    members.sort(
      (a, b) =>
        (a.capturedAt ?? 0) - (b.capturedAt ?? 0) || a.photo.id - b.photo.id
    );
    const first = members[0];
    const last = members.at(-1) ?? first;
    const gaps = members
      .slice(1)
      .map(
        (member, index) =>
          (member.capturedAt ?? 0) - (members[index].capturedAt ?? 0)
      );
    const intervalMs = median(gaps);
    if (
      intervalMs < settings.minTimelapseGapMs ||
      intervalMs > settings.maxTimelapseGapMs ||
      gaps.some((gap) => {
        // User-confirmed joins contain pauses; retain the rhythm of their frames.
        if (
          sequence.userLocked &&
          gap >
            intervalMs * (settings.maxMissingFrames + 1) +
              Math.max(1000, intervalMs * settings.rhythmTolerance) &&
          gap <= settings.continuationWindowMs
        ) {
          return false;
        }
        const multiple = Math.round(gap / intervalMs);
        return (
          multiple < 1 ||
          multiple > settings.maxMissingFrames + 1 ||
          Math.abs(gap - intervalMs * multiple) >
            Math.max(1000, intervalMs * settings.rhythmTolerance)
        );
      })
    ) {
      return [];
    }
    const segment: SequenceSuggestionSegment = {
      id: sequence.id,
      cameraModel: camera,
      lensModel: lens,
      startedAt: first.capturedAt ?? 0,
      endedAt: last.capturedAt ?? 0,
      frameCount: members.length,
      intervalMs,
      firstPhoto: first.photo,
      lastPhoto: last.photo,
      representative:
        members.find(
          (member) => member.photo.id === sequence.representativePhotoId
        )?.photo ?? first.photo,
    };
    return [
      {
        segment,
        folderId: sequence.folderId,
        firstHash: first.phash,
        lastHash: last.phash,
      },
    ];
  });
}

function candidateSuggestions(db: Database, folderId?: number) {
  const groups = new Map<string, ReturnType<typeof loadSegments>>();
  for (const entry of loadSegments(db, folderId)) {
    const key = JSON.stringify([
      entry.folderId,
      entry.segment.cameraModel,
      entry.segment.lensModel,
    ]);
    const group = groups.get(key) ?? [];
    group.push(entry);
    groups.set(key, group);
  }
  const settings = getSequenceDetectionSettings();
  const candidates: Omit<SequenceSuggestion, "id">[] = [];
  for (const group of groups.values()) {
    group.sort(
      (a, b) =>
        a.segment.startedAt - b.segment.startedAt || a.segment.id - b.segment.id
    );
    for (let index = 1; index < group.length; index++) {
      const first = group[index - 1];
      const second = group[index];
      const gapMs = second.segment.startedAt - first.segment.endedAt;
      const interval = Math.max(
        first.segment.intervalMs,
        second.segment.intervalMs
      );
      if (
        gapMs <=
          first.segment.intervalMs * (settings.maxMissingFrames + 1) +
            Math.max(
              1000,
              first.segment.intervalMs * settings.rhythmTolerance
            ) ||
        gapMs > settings.continuationWindowMs ||
        Math.abs(first.segment.intervalMs - second.segment.intervalMs) >
          Math.max(1000, interval * settings.rhythmTolerance) ||
        !first.lastHash ||
        !second.firstHash ||
        hammingDistance(first.lastHash, second.firstHash) >
          settings.timelapsePHashDistance
      ) {
        continue;
      }
      candidates.push({
        firstSequenceId: first.segment.id,
        secondSequenceId: second.segment.id,
        first: first.segment,
        second: second.segment,
        gapMs,
        reasonKeys: [
          "sequenceSuggestionSameDevice",
          "sequenceSuggestionSimilarRhythm",
          "sequenceSuggestionSimilarBoundary",
        ],
      });
    }
  }
  return candidates;
}

/** Reconcile pending rows without changing IDs of still-valid suggestions. */
export function refreshSequenceSuggestions(
  folderId?: number
): SequenceSuggestion[] {
  const db = getDatabase();
  return db.transaction(() => {
    const candidates = candidateSuggestions(db, folderId);
    const keys = new Set(
      candidates.map(
        (candidate) =>
          `${candidate.firstSequenceId}:${candidate.secondSequenceId}`
      )
    );
    const folderIds =
      folderId == null
        ? null
        : new Set(
            getFolderSubtreeIds(
              db
                .select({ id: folders.id, parentId: folders.parentId })
                .from(folders)
                .all(),
              folderId
            )
          );
    const sequences = db
      .select({ id: photoSequences.id, folderId: photoSequences.folderId })
      .from(photoSequences)
      .all();
    const activeIds = new Set(sequences.map((sequence) => sequence.id));
    const scopeIds =
      folderIds == null
        ? null
        : new Set(
            sequences
              .filter((sequence) => folderIds.has(sequence.folderId ?? -1))
              .map((sequence) => sequence.id)
          );
    const pending = db
      .select()
      .from(photoSequenceSuggestions)
      .where(eq(photoSequenceSuggestions.status, "pending"))
      .all();
    for (const row of pending) {
      if (
        !(
          activeIds.has(row.firstSequenceId) &&
          activeIds.has(row.secondSequenceId)
        ) ||
        ((scopeIds == null ||
          scopeIds.has(row.firstSequenceId) ||
          scopeIds.has(row.secondSequenceId)) &&
          !keys.has(`${row.firstSequenceId}:${row.secondSequenceId}`))
      ) {
        db.delete(photoSequenceSuggestions)
          .where(eq(photoSequenceSuggestions.id, row.id))
          .run();
      }
    }
    const result: SequenceSuggestion[] = [];
    for (const candidate of candidates) {
      db.insert(photoSequenceSuggestions)
        .values({
          firstSequenceId: candidate.firstSequenceId,
          secondSequenceId: candidate.secondSequenceId,
          confidence: 0.8,
          updatedAt: Date.now(),
        })
        .onConflictDoNothing()
        .run();
      const row = db
        .select({
          id: photoSequenceSuggestions.id,
          status: photoSequenceSuggestions.status,
        })
        .from(photoSequenceSuggestions)
        .where(
          and(
            eq(
              photoSequenceSuggestions.firstSequenceId,
              candidate.firstSequenceId
            ),
            eq(
              photoSequenceSuggestions.secondSequenceId,
              candidate.secondSequenceId
            )
          )
        )
        .get();
      if (row?.status === "pending") {
        result.push({ ...candidate, id: row.id });
      }
    }
    return result.sort(
      (a, b) => a.first.startedAt - b.first.startedAt || a.id - b.id
    );
  });
}

export function acceptSequenceSuggestion(
  suggestionId: number
): AcceptSequenceSuggestionResult {
  const db = getDatabase();
  const result = db.transaction(() => {
    const row = db
      .select()
      .from(photoSequenceSuggestions)
      .where(
        and(
          eq(photoSequenceSuggestions.id, suggestionId),
          eq(photoSequenceSuggestions.status, "pending")
        )
      )
      .get();
    if (!row) {
      return null;
    }
    const candidate = candidateSuggestions(db).find(
      (entry) =>
        entry.firstSequenceId === row.firstSequenceId &&
        entry.secondSequenceId === row.secondSequenceId
    );
    if (!candidate) {
      db.delete(photoSequenceSuggestions)
        .where(eq(photoSequenceSuggestions.id, suggestionId))
        .run();
      return null;
    }
    const merged = mergeSequencePair(db, [
      row.firstSequenceId,
      row.secondSequenceId,
    ]);
    // Explicitly clear dependent suggestions even in fixtures without FK enforcement.
    const related = db
      .select()
      .from(photoSequenceSuggestions)
      .all()
      .filter((entry) =>
        [row.firstSequenceId, row.secondSequenceId].some(
          (id) => entry.firstSequenceId === id || entry.secondSequenceId === id
        )
      );
    if (related.length) {
      db.delete(photoSequenceSuggestions)
        .where(
          inArray(
            photoSequenceSuggestions.id,
            related.map((entry) => entry.id)
          )
        )
        .run();
    }
    refreshSequenceSuggestions(merged.folderId ?? undefined);
    return {
      ...merged,
      deletedSequenceIds: [row.firstSequenceId, row.secondSequenceId],
    };
  });
  if (!result) {
    return { status: "stale", revision: getPhotoSequenceRevision() };
  }
  const revision = notifySequencesChanged(
    result.folderId ?? undefined,
    "manual",
    {
      deletedSequenceIds: result.deletedSequenceIds,
      replacementSequenceIds: [result.id],
    }
  );
  return { status: "merged", id: result.id, revision };
}
