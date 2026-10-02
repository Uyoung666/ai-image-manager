import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";
import { readCaptureMetadata } from "@/services/photo-sequences";

export function sequenceMembers(
  db: ReturnType<typeof getDatabase>,
  sequenceId: number
) {
  return db
    .select({
      id: photos.id,
      folderId: photos.folderId,
      capturedAt: exifData.dateTaken,
      normalizedJson: advancedExifData.normalizedJson,
      vendorRawJson: advancedExifData.vendorRawJson,
    })
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .leftJoin(exifData, eq(exifData.photoId, photos.id))
    .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
    .where(
      and(
        eq(photoSequenceMembers.sequenceId, sequenceId),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(asc(photoSequenceMembers.position))
    .all()
    .map((member) => ({
      ...member,
      capturedAt:
        readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
          .capturedAt ?? member.capturedAt,
    }));
}

export function insertManualSequence(
  db: ReturnType<typeof getDatabase>,
  type: "burst" | "timelapse",
  members: Array<{
    id: number;
    folderId: number | null;
    capturedAt: number | null;
  }>,
  preserveOrder = false
) {
  if (
    members.length < 2 ||
    new Set(members.map((member) => member.id)).size !== members.length ||
    new Set(members.map((member) => member.folderId)).size !== 1
  ) {
    throw new Error(
      "A manual sequence requires at least two active photos from one folder"
    );
  }
  const ids = members.map((member) => member.id);
  const active = db
    .select({ id: photos.id })
    .from(photos)
    .where(and(inArray(photos.id, ids), isNull(photos.deletedAt)))
    .all();
  const claimed = db
    .select({ id: photoSequenceMembers.photoId })
    .from(photoSequenceMembers)
    .where(inArray(photoSequenceMembers.photoId, ids))
    .all();
  if (active.length !== ids.length || claimed.length) {
    throw new Error("Sequence members must be active and unclaimed");
  }
  const sorted = preserveOrder
    ? [...members]
    : [...members].sort(
        (left, right) =>
          (left.capturedAt ?? 0) - (right.capturedAt ?? 0) || left.id - right.id
      );
  const times = members.flatMap((member) =>
    member.capturedAt != null && Number.isFinite(member.capturedAt)
      ? [member.capturedAt]
      : []
  );
  const startedAt = times.length ? Math.min(...times) : Date.now();
  const endedAt = times.length ? Math.max(...times) : startedAt;
  const inserted = db
    .insert(photoSequences)
    .values({
      folderId: sorted[0].folderId,
      type,
      source: "manual",
      userLocked: true,
      representativePhotoId: sorted[0].id,
      startedAt,
      endedAt,
      frameCount: sorted.length,
      updatedAt: Date.now(),
    })
    .returning({ id: photoSequences.id })
    .get();
  db.insert(photoSequenceMembers)
    .values(
      sorted.map((member, position) => ({
        sequenceId: inserted.id,
        photoId: member.id,
        position,
      }))
    )
    .run();
  return inserted.id;
}

/** Called inside the owning transaction; no renderer notification before commit. */
export function mergeSequencePair(
  db: ReturnType<typeof getDatabase>,
  sequenceIds: number[]
) {
  if (sequenceIds.length !== 2 || sequenceIds[0] === sequenceIds[1]) {
    throw new Error("Two distinct sequences are required");
  }
  const sequences = sequenceIds.map((id) =>
    db.select().from(photoSequences).where(eq(photoSequences.id, id)).get()
  );
  const first = sequences[0];
  const second = sequences[1];
  if (
    !(first && second) ||
    first.folderId !== second.folderId ||
    first.type !== second.type
  ) {
    throw new Error(
      "Only same-folder sequences of the same type can be merged"
    );
  }
  const members = sequenceIds.flatMap((id) => sequenceMembers(db, id));
  if (
    members.length !== first.frameCount + second.frameCount ||
    new Set(members.map((member) => member.id)).size !== members.length
  ) {
    throw new Error("Sequence members changed before merge");
  }
  db.delete(photoSequences)
    .where(inArray(photoSequences.id, sequenceIds))
    .run();
  return {
    id: insertManualSequence(db, first.type as "burst" | "timelapse", members),
    folderId: first.folderId,
  };
}
