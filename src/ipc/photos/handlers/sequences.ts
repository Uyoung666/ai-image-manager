import { os } from "@orpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
} from "@/db/schema";
import { hammingDistance } from "@/services/bk-tree";
import {
  detectPhotoSequences,
  previewPhotoSequences,
  readCaptureMetadata,
} from "@/services/photo-sequences";
import { getSequenceDetectionSettings } from "@/services/sequence-detection-settings";

const SequenceIdSchema = z.object({ id: z.number().int().positive() });
const SequenceIdsSchema = z.object({
  sequenceIds: z.array(z.number().int().positive()).length(2),
});
const PhotoIdsSchema = z.object({
  photoIds: z.array(z.number().int().positive()).min(1),
});
const UpdateSequenceMembersSchema = z.object({
  id: z.number().int().positive(),
  photoIds: z.array(z.number().int().positive()).min(2),
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

function sequenceMembers(
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
    .where(eq(photoSequenceMembers.sequenceId, sequenceId))
    .orderBy(asc(photoSequenceMembers.position))
    .all()
    .map((member) => ({
      ...member,
      capturedAt:
        readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
          .capturedAt ?? member.capturedAt,
    }));
}

function insertManualSequence(
  db: ReturnType<typeof getDatabase>,
  type: "burst" | "timelapse",
  members: Array<{
    id: number;
    folderId: number | null;
    capturedAt: number | null;
  }>
) {
  if (
    members.length < 2 ||
    new Set(members.map((member) => member.folderId)).size !== 1
  ) {
    throw new Error(
      "A manual sequence requires at least two active photos from one folder"
    );
  }
  const sorted = [...members].sort(
    (left, right) => (left.capturedAt ?? 0) - (right.capturedAt ?? 0)
  );
  const inserted = db
    .insert(photoSequences)
    .values({
      folderId: sorted[0].folderId,
      type,
      source: "manual",
      userLocked: true,
      representativePhotoId: sorted[0].id,
      startedAt: sorted[0].capturedAt ?? Date.now(),
      endedAt: sorted.at(-1)?.capturedAt ?? Date.now(),
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

function median(values: number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function sequenceEvidence(
  db: ReturnType<typeof getDatabase>,
  sequenceId: number
) {
  const members = db
    .select({
      normalizedJson: advancedExifData.normalizedJson,
      phash: photos.phash,
      position: photoSequenceMembers.position,
      vendorRawJson: advancedExifData.vendorRawJson,
    })
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
    .where(eq(photoSequenceMembers.sequenceId, sequenceId))
    .orderBy(asc(photoSequenceMembers.position))
    .all();
  const captures = members.map(
    (member) =>
      readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
        .capturedAt
  );
  if (captures.some((value) => value === null) || members.length < 2) {
    return null;
  }
  const timestamps = captures as number[];
  return {
    firstHash: members[0]?.phash ?? null,
    interval: median(
      timestamps
        .slice(1)
        .map((timestamp, index) => timestamp - timestamps[index])
    ),
    lastHash: members.at(-1)?.phash ?? null,
  };
}

export function refreshSequenceSuggestions(folderId?: number) {
  const db = getDatabase();
  const settings = getSequenceDetectionSettings();
  const rows = db
    .select({
      id: photoSequences.id,
      folderId: photoSequences.folderId,
      type: photoSequences.type,
      startedAt: photoSequences.startedAt,
      endedAt: photoSequences.endedAt,
      camera: exifData.cameraModel,
      lens: exifData.lensModel,
    })
    .from(photoSequences)
    .leftJoin(
      exifData,
      eq(exifData.photoId, photoSequences.representativePhotoId)
    )
    .where(folderId == null ? undefined : eq(photoSequences.folderId, folderId))
    .orderBy(asc(photoSequences.folderId), asc(photoSequences.startedAt))
    .all();
  for (let index = 1; index < rows.length; index++) {
    const previous = rows[index - 1];
    const current = rows[index];
    const gap = current.startedAt - previous.endedAt;
    if (
      previous.folderId !== current.folderId ||
      previous.type !== "timelapse" ||
      current.type !== "timelapse" ||
      previous.camera !== current.camera ||
      previous.lens !== current.lens ||
      gap < 0 ||
      gap > settings.continuationWindowMs
    ) {
      continue;
    }
    const previousEvidence = sequenceEvidence(db, previous.id);
    const currentEvidence = sequenceEvidence(db, current.id);
    if (
      !(previousEvidence && currentEvidence) ||
      previousEvidence.interval < settings.minTimelapseGapMs ||
      currentEvidence.interval < settings.minTimelapseGapMs ||
      gap <= previousEvidence.interval * 3 ||
      Math.abs(previousEvidence.interval - currentEvidence.interval) >
        Math.max(
          1000,
          Math.max(previousEvidence.interval, currentEvidence.interval) *
            settings.rhythmTolerance
        ) ||
      !previousEvidence.lastHash ||
      !currentEvidence.firstHash ||
      hammingDistance(previousEvidence.lastHash, currentEvidence.firstHash) >
        settings.timelapsePHashDistance
    ) {
      continue;
    }
    db.insert(photoSequenceSuggestions)
      .values({
        firstSequenceId: previous.id,
        secondSequenceId: current.id,
        confidence: 0.8,
        updatedAt: Date.now(),
      })
      .onConflictDoNothing()
      .run();
  }
}

export const listSequences = os
  .input(ListSequencesSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const conditions: ReturnType<typeof eq>[] = [];
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
  const exif = sequence.representativePhotoId
    ? db
        .select({
          cameraModel: exifData.cameraModel,
          lensModel: exifData.lensModel,
        })
        .from(exifData)
        .where(eq(exifData.photoId, sequence.representativePhotoId))
        .get()
    : null;
  return { ...sequence, ...exif, members };
});

export const rebuildSequences = os
  .input(
    z.object({
      dryRun: z.boolean().optional(),
      folderId: z.number().int().positive().optional(),
    })
  )
  .handler(({ input }) => {
    if (input.dryRun) {
      return { dryRun: true, ...previewPhotoSequences(input.folderId) };
    }
    const processed = detectPhotoSequences(input.folderId);
    refreshSequenceSuggestions(input.folderId);
    return { processed };
  });

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
      photoIds: z.array(z.number().int().positive()).min(2),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const members = db
      .select({
        id: photos.id,
        folderId: photos.folderId,
        capturedAt: exifData.dateTaken,
      })
      .from(photos)
      .leftJoin(exifData, eq(exifData.photoId, photos.id))
      .where(and(inArray(photos.id, input.photoIds), isNull(photos.deletedAt)))
      .all();
    return { id: insertManualSequence(db, input.type, members) };
  });

export const mergeSequences = os
  .input(SequenceIdsSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    return db.transaction(() => {
      const sequences = input.sequenceIds.map((id) =>
        db.select().from(photoSequences).where(eq(photoSequences.id, id)).get()
      );
      if (
        sequences.some((sequence) => !sequence) ||
        sequences[0]?.folderId !== sequences[1]?.folderId ||
        sequences[0]?.type !== sequences[1]?.type
      ) {
        throw new Error(
          "Only same-folder sequences of the same type can be merged"
        );
      }
      const members = input.sequenceIds.flatMap((id) =>
        sequenceMembers(db, id)
      );
      db.delete(photoSequences)
        .where(inArray(photoSequences.id, input.sequenceIds))
        .run();
      const merged = {
        id: insertManualSequence(
          db,
          sequences[0]?.type as "burst" | "timelapse",
          members
        ),
      };
      db.update(photoSequenceSuggestions)
        .set({ status: "accepted", updatedAt: Date.now() })
        .where(
          and(
            eq(photoSequenceSuggestions.firstSequenceId, input.sequenceIds[0]),
            eq(photoSequenceSuggestions.secondSequenceId, input.sequenceIds[1])
          )
        )
        .run();
      return merged;
    });
  });

export const splitSequence = os
  .input(
    z.object({
      id: z.number().int().positive(),
      position: z.number().int().positive(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    return db.transaction(() => {
      const sequence = db
        .select()
        .from(photoSequences)
        .where(eq(photoSequences.id, input.id))
        .get();
      const members = sequenceMembers(db, input.id);
      if (
        !(
          sequence &&
          input.position >= 2 &&
          input.position <= members.length - 2
        )
      ) {
        throw new Error("Split must leave at least two photos on each side");
      }
      db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
      return {
        ids: [
          insertManualSequence(
            db,
            sequence.type as "burst" | "timelapse",
            members.slice(0, input.position)
          ),
          insertManualSequence(
            db,
            sequence.type as "burst" | "timelapse",
            members.slice(input.position)
          ),
        ],
      };
    });
  });

export const setSequenceRepresentative = os
  .input(
    z.object({
      id: z.number().int().positive(),
      photoId: z.number().int().positive(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const isMember = db
      .select({ id: photoSequenceMembers.id })
      .from(photoSequenceMembers)
      .where(
        and(
          eq(photoSequenceMembers.sequenceId, input.id),
          eq(photoSequenceMembers.photoId, input.photoId)
        )
      )
      .get();
    if (!isMember) {
      throw new Error("Representative must belong to the sequence");
    }
    db.update(photoSequences)
      .set({
        representativePhotoId: input.photoId,
        source: "manual",
        userLocked: true,
        updatedAt: Date.now(),
      })
      .where(eq(photoSequences.id, input.id))
      .run();
    return { ok: true };
  });

export const updateSequenceMembers = os
  .input(UpdateSequenceMembersSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    return db.transaction(() => {
      const sequence = db
        .select()
        .from(photoSequences)
        .where(eq(photoSequences.id, input.id))
        .get();
      if (!sequence) {
        throw new Error("Sequence not found");
      }
      const members = db
        .select({
          id: photos.id,
          folderId: photos.folderId,
          capturedAt: exifData.dateTaken,
          normalizedJson: advancedExifData.normalizedJson,
          vendorRawJson: advancedExifData.vendorRawJson,
        })
        .from(photos)
        .leftJoin(exifData, eq(exifData.photoId, photos.id))
        .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
        .where(
          and(inArray(photos.id, input.photoIds), isNull(photos.deletedAt))
        )
        .all()
        .map((member) => ({
          ...member,
          capturedAt:
            readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
              .capturedAt ?? member.capturedAt,
        }));
      db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
      return {
        id: insertManualSequence(
          db,
          sequence.type as "burst" | "timelapse",
          members
        ),
      };
    });
  });

export const deleteManualSequence = os
  .input(SequenceIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const sequence = db
      .select()
      .from(photoSequences)
      .where(eq(photoSequences.id, input.id))
      .get();
    if (!sequence?.userLocked) {
      throw new Error("Only manual sequences can be deleted");
    }
    db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
    return { ok: true };
  });

export const restoreAutomaticSequence = os
  .input(SequenceIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const sequence = db
      .select()
      .from(photoSequences)
      .where(eq(photoSequences.id, input.id))
      .get();
    if (!sequence) {
      return { ok: true };
    }
    const members = sequenceMembers(db, input.id);
    db.transaction(() => {
      db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
      if (members.length) {
        db.delete(photoSequenceExclusions)
          .where(
            inArray(
              photoSequenceExclusions.photoId,
              members.map((member) => member.id)
            )
          )
          .run();
      }
      detectPhotoSequences(sequence.folderId ?? undefined);
      refreshSequenceSuggestions(sequence.folderId ?? undefined);
    });
    return { ok: true };
  });

export const listSequenceSuggestions = os
  .input(z.object({ folderId: z.number().int().positive().optional() }))
  .handler(({ input }) => {
    refreshSequenceSuggestions(input.folderId);
    const db = getDatabase();
    const suggestions = db
      .select()
      .from(photoSequenceSuggestions)
      .where(eq(photoSequenceSuggestions.status, "pending"))
      .all();
    if (input.folderId == null) {
      return suggestions;
    }
    const sequenceIds = new Set(
      db
        .select({ id: photoSequences.id })
        .from(photoSequences)
        .where(eq(photoSequences.folderId, input.folderId))
        .all()
        .map((sequence) => sequence.id)
    );
    return suggestions.filter((suggestion) =>
      sequenceIds.has(suggestion.firstSequenceId)
    );
  });
