import { os } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  faceIdentities,
  faceIdentityMembers,
  faceVectors,
  photos,
} from "@/db/schema";
import {
  detectFaces,
  getFaceDetectionProgress,
  isFaceDetectionRunning,
  reclusterAllFaces,
} from "@/services/face-detector";

const IdSchema = z.object({ id: z.number() });

export const startFaceDetection = os
  .input(
    z.object({
      photoIds: z.array(z.number()).optional(),
      rescan: z.boolean().optional(),
    })
  )
  .handler(async ({ input }) => {
    if (isFaceDetectionRunning()) {
      return { started: false, message: "人脸检测已在运行中" };
    }

    const db = getDatabase();
    let ids = input.photoIds;

    if (input.rescan) {
      // Preserve confirmed identities, re-detect everything else
      const confirmedIds = db
        .select({ id: faceIdentities.id })
        .from(faceIdentities)
        .where(eq(faceIdentities.isConfirmed, true))
        .all()
        .map((r) => r.id);

      if (confirmedIds.length > 0) {
        const unconfirmedIdentities = db
          .select({ id: faceIdentities.id })
          .from(faceIdentities)
          .where(eq(faceIdentities.isConfirmed, false))
          .all();
        for (const ui of unconfirmedIdentities) {
          db.delete(faceIdentityMembers)
            .where(eq(faceIdentityMembers.identityId, ui.id))
            .run();
        }
        db.delete(faceIdentities)
          .where(eq(faceIdentities.isConfirmed, false))
          .run();
        // Keep confirmed identities + their members + their face vectors
        const confirmedFaceVectorIds = db
          .select({ faceVectorId: faceIdentityMembers.faceVectorId })
          .from(faceIdentityMembers)
          .all()
          .map((r) => r.faceVectorId);
        const allFaceVectors = db
          .select({ id: faceVectors.id })
          .from(faceVectors)
          .all();
        for (const fv of allFaceVectors) {
          if (!confirmedFaceVectorIds.includes(fv.id)) {
            db.delete(faceVectors).where(eq(faceVectors.id, fv.id)).run();
          }
        }
        // Reset isFaceProcessed for photos whose face vectors were removed
        const remainingFaceVectorPhotoIds = db
          .select({ photoId: faceVectors.photoId })
          .from(faceVectors)
          .all()
          .map((r) => r.photoId);
        const allPhotoIds = db
          .select({ id: photos.id })
          .from(photos)
          .all()
          .map((r) => r.id);
        for (const pid of allPhotoIds) {
          if (!remainingFaceVectorPhotoIds.includes(pid)) {
            db.update(photos)
              .set({ isFaceProcessed: false })
              .where(eq(photos.id, pid))
              .run();
          }
        }
      } else {
        // No confirmed identities — clear everything
        db.delete(faceIdentityMembers).run();
        db.delete(faceIdentities).run();
        db.delete(faceVectors).run();
        db.update(photos).set({ isFaceProcessed: false }).run();
      }

      const all = db.select({ id: photos.id }).from(photos).all();
      ids = all.map((p) => p.id);
    } else if (!(ids && ids.length)) {
      // Default: detect faces in all unprocessed photos
      const unprocessed = db
        .select({ id: photos.id })
        .from(photos)
        .where(and(eq(photos.isFaceProcessed, false), isNull(photos.deletedAt)))
        .all();
      ids = unprocessed.map((p) => p.id);
    }

    if (!ids.length) {
      return { started: false, message: "没有需要检测的照片" };
    }

    // Fire and forget — detection runs async
    detectFaces(ids).catch((err) =>
      console.error("[Faces] Detection error:", err)
    );

    return { started: true, photoCount: ids.length };
  });

export const getDetectionProgress = os.handler(() => {
  return getFaceDetectionProgress();
});

export const listFaceIdentities = os.handler(() => {
  const db = getDatabase();
  const identities = db
    .select()
    .from(faceIdentities)
    .orderBy(desc(faceIdentities.faceCount))
    .all();

  const result = [];
  for (const identity of identities) {
    let coverPath: string | null = null;
    let coverPhotoPath: string | null = null;
    let coverBbox: {
      x: number;
      y: number;
      width: number;
      height: number;
    } | null = null;
    let coverPhotoWidth: number | null = null;
    let coverPhotoHeight: number | null = null;

    if (identity.representativePhotoId) {
      const photo = db
        .select({
          thumbnailPath: photos.thumbnailPath,
          path: photos.path,
          width: photos.width,
          height: photos.height,
        })
        .from(photos)
        .where(eq(photos.id, identity.representativePhotoId))
        .get();
      coverPath = photo?.thumbnailPath || photo?.path || null;
      coverPhotoPath = photo?.path ?? null;
      coverPhotoWidth = photo?.width ?? null;
      coverPhotoHeight = photo?.height ?? null;

      const memberFace = db
        .select({
          bboxX: faceVectors.bboxX,
          bboxY: faceVectors.bboxY,
          bboxWidth: faceVectors.bboxWidth,
          bboxHeight: faceVectors.bboxHeight,
        })
        .from(faceIdentityMembers)
        .innerJoin(
          faceVectors,
          eq(faceIdentityMembers.faceVectorId, faceVectors.id)
        )
        .where(eq(faceIdentityMembers.identityId, identity.id))
        .limit(1)
        .get();

      if (memberFace) {
        coverBbox = {
          x: memberFace.bboxX,
          y: memberFace.bboxY,
          width: memberFace.bboxWidth,
          height: memberFace.bboxHeight,
        };
      }
    }
    result.push({
      ...identity,
      coverThumbnailPath: coverPath,
      coverPhotoPath,
      coverBbox,
      coverPhotoWidth,
      coverPhotoHeight,
    });
  }

  return result;
});

export const getFaceIdentity = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const identity = db
    .select()
    .from(faceIdentities)
    .where(eq(faceIdentities.id, input.id))
    .get();
  if (!identity) {
    throw new Error("人物不存在");
  }

  const members = db
    .select({
      faceVectorId: faceIdentityMembers.faceVectorId,
    })
    .from(faceIdentityMembers)
    .where(eq(faceIdentityMembers.identityId, input.id))
    .all();

  const faceIds = members.map((m) => m.faceVectorId);

  const faces = faceIds.length
    ? db
        .select()
        .from(faceVectors)
        .where(inArray(faceVectors.id, faceIds))
        .all()
    : [];

  const photoIds = [...new Set(faces.map((f) => f.photoId))];
  const photoRows = photoIds.length
    ? db
        .select({
          id: photos.id,
          filename: photos.filename,
          path: photos.path,
          width: photos.width,
          height: photos.height,
          fileSize: photos.fileSize,
          thumbnailPath: photos.thumbnailPath,
          fileDate: photos.fileDate,
        })
        .from(photos)
        .where(inArray(photos.id, photoIds))
        .orderBy(desc(photos.fileDate))
        .all()
    : [];

  return { ...identity, faces, photos: photoRows };
});

export const createFaceIdentity = os
  .input(
    z.object({
      name: z.string().min(1),
      faceVectorIds: z.array(z.number()).optional(),
    })
  )
  .handler(async ({ input }) => {
    const db = getDatabase();
    const result = db
      .insert(faceIdentities)
      .values({
        name: input.name,
        faceCount: input.faceVectorIds?.length ?? 0,
      })
      .returning({ insertedId: faceIdentities.id })
      .get();

    if (result && input.faceVectorIds?.length) {
      for (const fvId of input.faceVectorIds) {
        db.insert(faceIdentityMembers)
          .values({ identityId: result.insertedId, faceVectorId: fvId })
          .onConflictDoNothing()
          .run();
      }
    }

    return db
      .select()
      .from(faceIdentities)
      .where(eq(faceIdentities.id, result!.insertedId))
      .get();
  });

export const updateFaceIdentity = os
  .input(
    z.object({
      id: z.number(),
      name: z.string().optional(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(faceIdentities)
      .set({ name: input.name, isConfirmed: true })
      .where(eq(faceIdentities.id, input.id))
      .run();
    return db
      .select()
      .from(faceIdentities)
      .where(eq(faceIdentities.id, input.id))
      .get();
  });

export const mergeIdentities = os
  .input(
    z.object({
      targetId: z.number(),
      sourceIds: z.array(z.number()),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    for (const srcId of input.sourceIds) {
      const members = db
        .select()
        .from(faceIdentityMembers)
        .where(eq(faceIdentityMembers.identityId, srcId))
        .all();
      for (const m of members) {
        db.update(faceIdentityMembers)
          .set({ identityId: input.targetId })
          .where(eq(faceIdentityMembers.id, m.id))
          .run();
      }
      db.delete(faceIdentities).where(eq(faceIdentities.id, srcId)).run();
    }
    // Update face count and mark as confirmed (user manually merged)
    db.update(faceIdentities)
      .set({
        isConfirmed: true,
        faceCount: sql`(SELECT COUNT(*) FROM ${faceIdentityMembers} WHERE ${faceIdentityMembers.identityId} = ${input.targetId})`,
      })
      .where(eq(faceIdentities.id, input.targetId))
      .run();
    return { ok: true };
  });

export const deleteFaceIdentity = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  // Mark associated face vectors as rejected first
  db.update(faceVectors)
    .set({ isRejected: true })
    .where(
      inArray(
        faceVectors.id,
        db
          .select({ faceVectorId: faceIdentityMembers.faceVectorId })
          .from(faceIdentityMembers)
          .where(eq(faceIdentityMembers.identityId, input.id))
      )
    )
    .run();
  // Remove face identity members first (FK constraint)
  db.delete(faceIdentityMembers)
    .where(eq(faceIdentityMembers.identityId, input.id))
    .run();
  db.delete(faceIdentities).where(eq(faceIdentities.id, input.id)).run();
  return { ok: true };
});

export const removeFaceFromIdentity = os
  .input(z.object({ identityId: z.number(), faceVectorId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();

    // Mark face vector as rejected before removing from identity
    db.update(faceVectors)
      .set({ isRejected: true })
      .where(eq(faceVectors.id, input.faceVectorId))
      .run();

    db.delete(faceIdentityMembers)
      .where(
        sql`${faceIdentityMembers.identityId} = ${input.identityId} AND ${faceIdentityMembers.faceVectorId} = ${input.faceVectorId}`
      )
      .run();

    const remaining = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(faceIdentityMembers)
      .where(eq(faceIdentityMembers.identityId, input.identityId))
      .get();

    const count = remaining?.count ?? 0;
    if (count === 0) {
      // No faces left — delete the identity
      db.delete(faceIdentities)
        .where(eq(faceIdentities.id, input.identityId))
        .run();
    } else {
      db.update(faceIdentities)
        .set({ faceCount: count })
        .where(eq(faceIdentities.id, input.identityId))
        .run();
    }

    return { ok: true, remainingCount: count };
  });

export const recluster = os.handler(async () => {
  if (isFaceDetectionRunning()) {
    return { ok: false, message: "人脸检测正在运行中，请稍后再试" };
  }
  const result = await reclusterAllFaces();
  return { ok: true, identityCount: result.merged };
});
