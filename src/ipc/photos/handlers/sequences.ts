import { os } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequences,
  photos,
} from "@/db/schema";
import { detectPhotoSequences } from "@/services/photo-sequences";

const SequenceIdSchema = z.object({ id: z.number().int().positive() });
const PhotoIdsSchema = z.object({
  photoIds: z.array(z.number().int().positive()).min(1),
});
const ListSequencesSchema = z.object({
  folderId: z.number().int().positive().optional(),
  photoIds: z.array(z.number().int().positive()).optional(),
});

const photoFields = {
  id: photos.id,
  path: photos.path,
  filename: photos.filename,
  fileSize: photos.fileSize,
  fileDate: photos.fileDate,
  width: photos.width,
  height: photos.height,
  thumbnailPath: photos.thumbnailPath,
  dominantColors: photos.dominantColors,
  isFavorite: photos.isFavorite,
  isIndexed: photos.isIndexed,
};
const sequenceFields = {
  id: photoSequences.id,
  folderId: photoSequences.folderId,
  type: photoSequences.type,
  source: photoSequences.source,
  representativePhotoId: photoSequences.representativePhotoId,
  startedAt: photoSequences.startedAt,
  endedAt: photoSequences.endedAt,
  frameCount: photoSequences.frameCount,
  userLocked: photoSequences.userLocked,
};

export const listSequences = os
  .input(ListSequencesSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const conditions = [];
    if (input.folderId != null) {
      conditions.push(eq(photoSequences.folderId, input.folderId));
    }
    const sequences = db
      .select({ ...sequenceFields, photo: { ...photoFields } })
      .from(photoSequences)
      .innerJoin(photos, eq(photos.id, photoSequences.representativePhotoId))
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(photoSequences.startedAt))
      .all();
    const memberRows = sequences.length
      ? db
          .select({
            sequenceId: photoSequenceMembers.sequenceId,
            photoId: photoSequenceMembers.photoId,
          })
          .from(photoSequenceMembers)
          .where(
            inArray(
              photoSequenceMembers.sequenceId,
              sequences.map((sequence) => sequence.id)
            )
          )
          .all()
      : [];
    const withMembers = sequences.map((sequence) => ({
      ...sequence,
      memberPhotoIds: memberRows
        .filter((row) => row.sequenceId === sequence.id)
        .map((row) => row.photoId),
    }));
    if (!input.photoIds?.length) {
      return withMembers;
    }
    const matched = new Set(
      db
        .select({ sequenceId: photoSequenceMembers.sequenceId })
        .from(photoSequenceMembers)
        .where(inArray(photoSequenceMembers.photoId, input.photoIds))
        .all()
        .map((row) => row.sequenceId)
    );
    return withMembers.filter((sequence) => matched.has(sequence.id));
  });

export const getSequence = os.input(SequenceIdSchema).handler(({ input }) => {
  const db = getDatabase();
  const sequence = db
    .select()
    .from(photoSequences)
    .where(eq(photoSequences.id, input.id))
    .get();
  if (!sequence) {
    return null;
  }
  const members = db
    .select(photoFields)
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .where(
      and(
        eq(photoSequenceMembers.sequenceId, input.id),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(asc(photoSequenceMembers.position))
    .all();
  return { ...sequence, members };
});

export const rebuildSequences = os
  .input(z.object({ folderId: z.number().int().positive().optional() }))
  .handler(({ input }) => ({
    processed: detectPhotoSequences(input.folderId),
  }));

export const ignoreSequencePhotos = os
  .input(PhotoIdsSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    db.transaction(() => {
      for (const photoId of input.photoIds) {
        db.insert(photoSequenceExclusions)
          .values({ photoId })
          .onConflictDoNothing()
          .run();
      }
      const memberships = db
        .select({ sequenceId: photoSequenceMembers.sequenceId })
        .from(photoSequenceMembers)
        .where(inArray(photoSequenceMembers.photoId, input.photoIds))
        .all();
      if (memberships.length) {
        db.delete(photoSequences)
          .where(
            inArray(photoSequences.id, [
              ...new Set(memberships.map((row) => row.sequenceId)),
            ])
          )
          .run();
      }
    });
    return { success: true };
  });

export const createSequence = os
  .input(
    z.object({
      type: z.enum(["burst", "timelapse"]),
      photoIds: z.array(z.number().int().positive()).min(3),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const members = db
      .select({ ...photoFields, folderId: photos.folderId })
      .from(photos)
      .where(and(inArray(photos.id, input.photoIds), isNull(photos.deletedAt)))
      .orderBy(asc(photos.fileDate))
      .all();
    if (
      members.length < 3 ||
      new Set(members.map((member) => member.folderId)).size !== 1
    ) {
      throw new Error(
        "A sequence requires at least three active photos from one folder"
      );
    }
    const inserted = db
      .insert(photoSequences)
      .values({
        folderId: members[0].folderId,
        type: input.type,
        source: "manual",
        userLocked: true,
        representativePhotoId: members[0].id,
        startedAt: members[0].fileDate ?? Date.now(),
        endedAt: members.at(-1)?.fileDate ?? Date.now(),
        frameCount: members.length,
        updatedAt: Date.now(),
      })
      .returning({ id: photoSequences.id })
      .get();
    db.insert(photoSequenceMembers)
      .values(
        members.map((member, position) => ({
          sequenceId: inserted.id,
          photoId: member.id,
          position,
        }))
      )
      .run();
    return { id: inserted.id };
  });
