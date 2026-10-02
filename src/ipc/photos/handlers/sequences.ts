import { os } from "@orpc/server";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNull,
  type SQL,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  advancedExifData,
  exifData,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequences,
  photos,
  photoTags,
} from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import {
  getSequenceFolderIds,
  notifySequencesChanged,
  previewPhotoSequences,
  readCaptureMetadata,
  rebuildPhotoSequences,
} from "@/services/photo-sequences";
import {
  insertManualSequence,
  mergeSequencePair,
  sequenceMembers,
} from "@/services/sequence-members";
import { recommendSequenceRepresentative as recommendRepresentative } from "@/services/sequence-representative";
import {
  acceptSequenceSuggestion as acceptSuggestion,
  refreshSequenceSuggestions,
} from "@/services/sequence-suggestions";
import { invalidateSmartAlbumCache } from "@/services/smart-album-engine";
import { invalidateStatsCache } from "./stats";

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
const ManageSequenceMembersSchema = z.object({
  id: z.number().int().positive(),
  photoIds: z.array(z.number().int().positive()).min(1),
});
const KeepSequencePhotosSchema = z.object({
  id: z.number().int().positive(),
  keepPhotoIds: z.array(z.number().int().positive()).min(1),
  scopePhotoIds: z.array(z.number().int().positive()).min(2),
});
const RecommendSequenceRepresentativeSchema = z.object({
  id: z.number().int().positive(),
  photoIds: z.array(z.number().int().positive()).optional(),
});
const ListSequencesSchema = z.object({
  folderId: z.number().int().positive().optional(),
  favoriteOnly: z.boolean().optional(),
  photoIds: z.array(z.number().int().positive()).optional(),
  scope: z.enum(["gallery", "members"]).optional(),
  tagIds: z.array(z.number().int().positive()).optional(),
  tagMode: z.enum(["and", "or"]).optional(),
});
type ListSequencesInput = z.infer<typeof ListSequencesSchema>;

function getGalleryPhotoConditions(
  input: ListSequencesInput,
  folderIds: number[] | undefined
) {
  const conditions: SQL[] = [isNull(photos.deletedAt)];
  if (input.folderId != null) {
    conditions.push(
      folderIds?.length
        ? inArray(photos.folderId, folderIds)
        : eq(photos.folderId, input.folderId)
    );
  }
  if (input.favoriteOnly) {
    conditions.push(eq(photos.isFavorite, true));
  }
  if (input.tagIds?.length && input.tagMode === "and") {
    for (const tagId of input.tagIds) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM ${photoTags} WHERE ${photoTags.photoId} = ${photos.id} AND ${photoTags.tagId} = ${tagId})`
      );
    }
  } else if (input.tagIds?.length) {
    conditions.push(
      sql`${photos.id} IN (SELECT ${photoTags.photoId} FROM ${photoTags} WHERE ${inArray(photoTags.tagId, input.tagIds)})`
    );
  }
  return conditions;
}

function getVisiblePhotoIds(
  db: ReturnType<typeof getDatabase>,
  input: ListSequencesInput,
  folderIds: number[] | undefined
) {
  const scope = input.scope ?? (input.photoIds?.length ? "members" : "gallery");
  if (scope === "members") {
    return new Set(input.photoIds ?? []);
  }
  return new Set(
    db
      .select({ id: photos.id })
      .from(photos)
      .where(and(...getGalleryPhotoConditions(input, folderIds)))
      .all()
      .map((row) => row.id)
  );
}

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

function activeSequenceMemberIds(
  db: ReturnType<typeof getDatabase>,
  sequenceId: number
) {
  return db
    .select({ id: photos.id })
    .from(photoSequenceMembers)
    .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
    .where(
      and(
        eq(photoSequenceMembers.sequenceId, sequenceId),
        isNull(photos.deletedAt)
      )
    )
    .orderBy(asc(photoSequenceMembers.position))
    .all()
    .map((member) => member.id);
}

export function updateSequenceMembersInPlace(
  db: ReturnType<typeof getDatabase>,
  sequenceId: number,
  orderedPhotoIds: number[]
) {
  const sequence = db
    .select()
    .from(photoSequences)
    .where(eq(photoSequences.id, sequenceId))
    .get();
  if (!sequence) {
    throw new Error("Sequence not found");
  }
  const uniqueIds = [...new Set(orderedPhotoIds)];
  if (uniqueIds.length !== orderedPhotoIds.length) {
    throw new Error("Sequence members must be unique");
  }
  if (uniqueIds.length < 2) {
    db.delete(photoSequences).where(eq(photoSequences.id, sequenceId)).run();
    return { dissolved: true, id: sequenceId };
  }
  const rows = db
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
    .where(and(inArray(photos.id, uniqueIds), isNull(photos.deletedAt)))
    .all();
  if (
    rows.length !== uniqueIds.length ||
    rows.some((row) => row.folderId !== sequence.folderId)
  ) {
    throw new Error("Sequence members must be active photos from one folder");
  }
  const conflicts = db
    .select({
      photoId: photoSequenceMembers.photoId,
      sequenceId: photoSequenceMembers.sequenceId,
    })
    .from(photoSequenceMembers)
    .where(inArray(photoSequenceMembers.photoId, uniqueIds))
    .all();
  if (conflicts.some((member) => member.sequenceId !== sequenceId)) {
    throw new Error("Photo already belongs to another sequence");
  }
  const byId = new Map(
    rows.map((row) => [
      row.id,
      {
        ...row,
        capturedAt:
          readCaptureMetadata(row.normalizedJson, row.vendorRawJson)
            .capturedAt ?? row.capturedAt,
      },
    ])
  );
  const ordered = uniqueIds.flatMap((id) => {
    const member = byId.get(id);
    return member ? [member] : [];
  });
  const captureTimes = ordered
    .map((member) => member.capturedAt)
    .filter((value): value is number => value != null);
  const representativePhotoId = uniqueIds.includes(
    sequence.representativePhotoId ?? -1
  )
    ? sequence.representativePhotoId
    : uniqueIds[0];
  db.delete(photoSequenceMembers)
    .where(eq(photoSequenceMembers.sequenceId, sequenceId))
    .run();
  db.insert(photoSequenceMembers)
    .values(
      uniqueIds.map((photoId, position) => ({
        photoId,
        position,
        sequenceId,
      }))
    )
    .run();
  db.update(photoSequences)
    .set({
      endedAt: captureTimes.length
        ? Math.max(...captureTimes)
        : sequence.endedAt,
      frameCount: uniqueIds.length,
      representativePhotoId,
      source: "manual",
      startedAt: captureTimes.length
        ? Math.min(...captureTimes)
        : sequence.startedAt,
      updatedAt: Date.now(),
      userLocked: true,
    })
    .where(eq(photoSequences.id, sequenceId))
    .run();
  return { dissolved: false, id: sequenceId };
}

export function querySequences(input: ListSequencesInput) {
  const db = getDatabase();
  const conditions: SQL[] = [];
  const folderIds = getSequenceFolderIds(db, input.folderId);
  if (input.folderId != null) {
    conditions.push(
      folderIds?.length
        ? inArray(photoSequences.folderId, folderIds)
        : eq(photoSequences.folderId, input.folderId)
    );
  }
  const sequences = db
    .select({ ...sequenceFields, photo: { ...photoFields } })
    .from(photoSequences)
    .leftJoin(photos, eq(photos.id, photoSequences.representativePhotoId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(photoSequences.startedAt))
    .all();
  const memberRows = sequences.length
    ? db
        .select({
          sequenceId: photoSequenceMembers.sequenceId,
          photoId: photoSequenceMembers.photoId,
          position: photoSequenceMembers.position,
        })
        .from(photoSequenceMembers)
        .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
        .where(
          and(
            inArray(
              photoSequenceMembers.sequenceId,
              sequences.map((sequence) => sequence.id)
            ),
            isNull(photos.deletedAt)
          )
        )
        .orderBy(
          asc(photoSequenceMembers.sequenceId),
          asc(photoSequenceMembers.position)
        )
        .all()
    : [];
  const visiblePhotoIds = getVisiblePhotoIds(db, input, folderIds);
  const activeMemberIds = [
    ...new Set(memberRows.map((member) => member.photoId)),
  ];
  const activePhotos = activeMemberIds.length
    ? db
        .select(photoFields)
        .from(photos)
        .where(
          and(inArray(photos.id, activeMemberIds), isNull(photos.deletedAt))
        )
        .all()
    : [];
  const activePhotoById = new Map(
    activePhotos.map((photo) => [photo.id, photo])
  );
  return sequences
    .map((sequence) => {
      const memberPhotoIds = memberRows
        .filter((row) => row.sequenceId === sequence.id)
        .map((row) => row.photoId);
      const matchedPhotoIds = memberPhotoIds.filter((id) =>
        visiblePhotoIds.has(id)
      );
      const representative =
        activePhotoById.get(sequence.representativePhotoId ?? -1) ??
        activePhotoById.get(memberPhotoIds[0]);
      const matchedPhoto = activePhotoById.get(matchedPhotoIds[0]);
      if (!representative) {
        return null;
      }
      return {
        ...sequence,
        frameCount: memberPhotoIds.length,
        matchedCount: matchedPhotoIds.length,
        matchedPhoto,
        matchedPhotoIds,
        memberPhotoIds,
        photo: representative,
      };
    })
    .filter(
      (sequence): sequence is NonNullable<typeof sequence> =>
        sequence !== null && sequence.matchedCount > 0
    );
}

export const listSequences = os
  .input(ListSequencesSchema)
  .handler(({ input }) => querySequences(input));

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
  const representativePhotoId = members.some(
    (member) => member.id === sequence.representativePhotoId
  )
    ? sequence.representativePhotoId
    : (members[0]?.id ?? null);
  return {
    ...sequence,
    ...exif,
    frameCount: members.length,
    members,
    representativePhotoId,
  };
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
    const result = rebuildPhotoSequences(input.folderId, "rebuild", false);
    refreshSequenceSuggestions(input.folderId);
    const revision = notifySequencesChanged(input.folderId, "rebuild", result);
    return { ...result, revision };
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
    notifySequencesChanged(undefined, "manual");
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
        normalizedJson: advancedExifData.normalizedJson,
        vendorRawJson: advancedExifData.vendorRawJson,
      })
      .from(photos)
      .leftJoin(exifData, eq(exifData.photoId, photos.id))
      .leftJoin(advancedExifData, eq(advancedExifData.photoId, photos.id))
      .where(and(inArray(photos.id, input.photoIds), isNull(photos.deletedAt)))
      .all();
    if (
      new Set(input.photoIds).size !== input.photoIds.length ||
      members.length !== input.photoIds.length
    ) {
      throw new Error("All requested photos must be active and unique");
    }
    const normalized = members.map((member) => ({
      ...member,
      capturedAt:
        readCaptureMetadata(member.normalizedJson, member.vendorRawJson)
          .capturedAt ?? member.capturedAt,
    }));
    const id = db.transaction(() =>
      insertManualSequence(db, input.type, normalized)
    );
    notifySequencesChanged(members[0]?.folderId ?? undefined, "manual");
    return { id };
  });

export const acceptSequenceSuggestion = os
  .input(z.object({ suggestionId: z.number().int().positive() }))
  .handler(({ input }) => acceptSuggestion(input.suggestionId));

export const mergeSequences = os
  .input(SequenceIdsSchema)
  .handler(({ input }) => {
    const result = getDatabase().transaction(() =>
      mergeSequencePair(getDatabase(), input.sequenceIds)
    );
    refreshSequenceSuggestions(result.folderId ?? undefined);
    const revision = notifySequencesChanged(
      result.folderId ?? undefined,
      "manual",
      {
        deletedSequenceIds: input.sequenceIds,
        replacementSequenceIds: [result.id],
      }
    );
    return { id: result.id, revision };
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
    const result = db.transaction(() => {
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
            members.slice(0, input.position),
            true
          ),
          insertManualSequence(
            db,
            sequence.type as "burst" | "timelapse",
            members.slice(input.position),
            true
          ),
        ],
      };
    });
    notifySequencesChanged(undefined, "manual", {
      deletedSequenceIds: [input.id],
      replacementSequenceIds: result.ids,
    });
    return result;
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
      .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
      .where(
        and(
          eq(photoSequenceMembers.sequenceId, input.id),
          eq(photoSequenceMembers.photoId, input.photoId),
          isNull(photos.deletedAt)
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
    notifySequencesChanged(undefined, "manual");
    return { ok: true };
  });

export const updateSequenceMembers = os
  .input(UpdateSequenceMembersSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const oldMemberIds = activeSequenceMemberIds(db, input.id);
    const retainedIds = new Set(input.photoIds);
    const removedIds = oldMemberIds.filter((id) => !retainedIds.has(id));
    const result = db.transaction(() => {
      const updated = updateSequenceMembersInPlace(
        db,
        input.id,
        input.photoIds
      );
      if (removedIds.length) {
        db.insert(photoSequenceExclusions)
          .values(removedIds.map((photoId) => ({ photoId })))
          .onConflictDoNothing()
          .run();
      }
      return updated;
    });
    const pureReorder =
      oldMemberIds.length === input.photoIds.length &&
      oldMemberIds.every((id) => retainedIds.has(id));
    notifySequencesChanged(undefined, pureReorder ? "reorder" : "manual", {
      orderedMemberIds: input.photoIds,
      sequenceId: input.id,
    });
    return result;
  });

export const removeSequenceMembers = os
  .input(ManageSequenceMembersSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const removeIds = new Set(input.photoIds);
    const currentIds = activeSequenceMemberIds(db, input.id);
    if (!input.photoIds.every((id) => currentIds.includes(id))) {
      throw new Error("Only current sequence members can be removed");
    }
    const remainingIds = currentIds.filter((id) => !removeIds.has(id));
    const result = db.transaction(() => {
      const updated = updateSequenceMembersInPlace(db, input.id, remainingIds);
      db.insert(photoSequenceExclusions)
        .values(input.photoIds.map((photoId) => ({ photoId })))
        .onConflictDoNothing()
        .run();
      return updated;
    });
    notifySequencesChanged(undefined, "manual");
    return result;
  });

export const dissolveSequence = os
  .input(SequenceIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const sequence = db
      .select({ folderId: photoSequences.folderId })
      .from(photoSequences)
      .where(eq(photoSequences.id, input.id))
      .get();
    if (!sequence) {
      return { ok: true };
    }
    db.transaction(() => {
      db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
    });
    notifySequencesChanged(sequence.folderId ?? undefined, "manual");
    return { ok: true };
  });

export const dissolveAndExcludeSequence = os
  .input(SequenceIdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const sequence = db
      .select({ folderId: photoSequences.folderId })
      .from(photoSequences)
      .where(eq(photoSequences.id, input.id))
      .get();
    if (!sequence) {
      return { ok: true };
    }
    const memberIds = activeSequenceMemberIds(db, input.id);
    db.transaction(() => {
      if (memberIds.length) {
        db.insert(photoSequenceExclusions)
          .values(memberIds.map((photoId) => ({ photoId })))
          .onConflictDoNothing()
          .run();
      }
      db.delete(photoSequences).where(eq(photoSequences.id, input.id)).run();
    });
    notifySequencesChanged(sequence.folderId ?? undefined, "manual");
    return { ok: true };
  });

export const clearSequenceExclusions = os
  .input(z.object({}).optional())
  .handler(() => {
    const db = getDatabase();
    const result = db.delete(photoSequenceExclusions).run();
    notifySequencesChanged(undefined, "manual");
    return { cleared: result.changes };
  });

export const keepSequencePhotos = os
  .input(KeepSequencePhotosSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const memberIds = activeSequenceMemberIds(db, input.id);
    const memberIdSet = new Set(memberIds);
    const scopeIds = [...new Set(input.scopePhotoIds)];
    const keepIds = [...new Set(input.keepPhotoIds)];
    if (
      scopeIds.some((id) => !memberIdSet.has(id)) ||
      keepIds.some((id) => !scopeIds.includes(id))
    ) {
      throw new Error("Keep and scope photos must belong to this sequence");
    }
    const keepIdSet = new Set(keepIds);
    const deleteIds = scopeIds.filter((id) => !keepIdSet.has(id));
    if (deleteIds.length === 0) {
      return { deleted: 0, dissolved: false, id: input.id };
    }
    const targetPhotos = db
      .select({ folderId: photos.folderId, id: photos.id })
      .from(photos)
      .where(and(inArray(photos.id, deleteIds), isNull(photos.deletedAt)))
      .all();
    const activeDeleteIds = targetPhotos.map((photo) => photo.id);
    const remainingIds = memberIds.filter(
      (id) => !new Set(activeDeleteIds).has(id)
    );
    const countsByFolder = new Map<number, number>();
    for (const photo of targetPhotos) {
      if (photo.folderId != null) {
        countsByFolder.set(
          photo.folderId,
          (countsByFolder.get(photo.folderId) ?? 0) + 1
        );
      }
    }
    const result = db.transaction(() => {
      db.update(photos)
        .set({ deletionBatchId: null, deletedAt: Date.now() })
        .where(inArray(photos.id, activeDeleteIds))
        .run();
      for (const [folderId, count] of countsByFolder) {
        db.update(folders)
          .set({ photoCount: sql`MAX(0, photo_count - ${count})` })
          .where(eq(folders.id, folderId))
          .run();
      }
      const updated = updateSequenceMembersInPlace(db, input.id, remainingIds);
      return { ...updated, deleted: activeDeleteIds.length };
    });
    invalidateCountCache();
    invalidateStatsCache();
    invalidateSmartAlbumCache();
    notifySequencesChanged(undefined, "manual");
    return result;
  });

export const recommendSequenceRepresentative = os
  .input(RecommendSequenceRepresentativeSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    const candidates = db
      .select({
        height: photos.height,
        id: photos.id,
        isFavorite: photos.isFavorite,
        path: photos.path,
        thumbnailPath: photos.thumbnailPath,
        width: photos.width,
      })
      .from(photoSequenceMembers)
      .innerJoin(photos, eq(photos.id, photoSequenceMembers.photoId))
      .where(
        and(
          eq(photoSequenceMembers.sequenceId, input.id),
          isNull(photos.deletedAt),
          input.photoIds?.length
            ? inArray(photos.id, input.photoIds)
            : undefined
        )
      )
      .orderBy(asc(photoSequenceMembers.position))
      .all();
    return recommendRepresentative(candidates);
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
    notifySequencesChanged(sequence.folderId ?? undefined, "manual");
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
      rebuildPhotoSequences(sequence.folderId ?? undefined, "restore", false);
      refreshSequenceSuggestions(sequence.folderId ?? undefined);
    });
    notifySequencesChanged(sequence.folderId ?? undefined, "restore", {
      deletedSequenceIds: [input.id],
    });
    return { ok: true };
  });

export const listSequenceSuggestions = os
  .input(z.object({ folderId: z.number().int().positive().optional() }))
  .handler(({ input }) => refreshSequenceSuggestions(input.folderId));
