import { os } from "@orpc/server";
import { asc, desc, eq, sql } from "drizzle-orm";
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
} from "@/services/face-detector";

const IdSchema = z.object({ id: z.number() });

export const startFaceDetection = os
  .input(z.object({ photoIds: z.array(z.number()).optional() }))
  .handler(async ({ input }) => {
    if (isFaceDetectionRunning()) {
      return { started: false, message: "人脸检测已在运行中" };
    }

    const db = getDatabase();
    let ids = input.photoIds;

    if (!ids || !ids.length) {
      // Default: detect faces in all unprocessed photos
      const processed = db
        .select({ photoId: faceVectors.photoId })
        .from(faceVectors)
        .all();
      const processedSet = new Set(processed.map((r) => r.photoId));
      const all = db.select({ id: photos.id }).from(photos).all();
      ids = all
        .filter((p) => !processedSet.has(p.id))
        .map((p) => p.id);
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

  // Load representative photo thumbnails
  const result = [];
  for (const identity of identities) {
    let coverPath: string | null = null;
    if (identity.representativePhotoId) {
      const photo = db
        .select({ thumbnailPath: photos.thumbnailPath })
        .from(photos)
        .where(eq(photos.id, identity.representativePhotoId))
        .get();
      coverPath = photo?.thumbnailPath ?? null;
    }
    result.push({
      ...identity,
      coverThumbnailPath: coverPath,
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
  if (!identity) throw new Error("人物不存在");

  // Get all face vectors for this identity
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
        .where(sql`${faceVectors.id} IN (${faceIds.join(",")})`)
        .all()
    : [];

  // Get associated photos
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
        .where(sql`${photos.id} IN (${photoIds.join(",")})`)
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
      .set({ name: input.name })
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
    // Move all face members from source identities to target
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
      // Update face count on target
      db.update(faceIdentities)
        .set({
          faceCount: sql`(SELECT COUNT(*) FROM ${faceIdentityMembers} WHERE ${faceIdentityMembers.identityId} = ${input.targetId})`,
        })
        .where(eq(faceIdentities.id, input.targetId))
        .run();
      // Delete source identity
      db.delete(faceIdentities).where(eq(faceIdentities.id, srcId)).run();
    }
    return { ok: true };
  });
