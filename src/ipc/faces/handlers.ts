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
  cancelFaceDetection,
  detectFaces,
  getFaceDetectionProgress,
  isFaceDetectionRunning,
  reclusterAllFaces,
  refreshFaceIdentityMetadata,
} from "@/services/face-detector";
import {
  getFaceScanScope,
  resolveFaceScanFolderIds,
  setFaceScanScope,
} from "@/services/face-scan-scope";

const IdSchema = z.object({ id: z.number() });

export const startFaceDetection = os
  .input(
    z.object({
      rescan: z.boolean().optional(),
    })
  )
  .handler(({ input }) => {
    if (isFaceDetectionRunning()) {
      return { started: false, message: "人脸检测已在运行中" };
    }

    const db = getDatabase();
    const scopeFolderIds = resolveFaceScanFolderIds();
    if (scopeFolderIds.length === 0) {
      return {
        started: false,
        requiresScope: true,
        message: "请先选择人脸识别扫描范围",
      };
    }

    const targetPhoto = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        and(
          inArray(photos.folderId, scopeFolderIds),
          isNull(photos.deletedAt)
        )
      )
      .limit(1)
      .get();
    if (!targetPhoto) {
      return { started: false, message: "扫描范围内没有照片" };
    }

    if (input.rescan) {
      const scopedVectorRows = db
        .select({ id: faceVectors.id, photoId: faceVectors.photoId })
        .from(faceVectors)
        .innerJoin(photos, eq(photos.id, faceVectors.photoId))
        .where(
          and(
            inArray(photos.folderId, scopeFolderIds),
            isNull(photos.deletedAt)
          )
        )
        .all();
      const confirmedRows = db
        .select({
          photoId: faceVectors.photoId,
        })
        .from(faceIdentityMembers)
        .innerJoin(
          faceIdentities,
          eq(faceIdentities.id, faceIdentityMembers.identityId)
        )
        .innerJoin(
          faceVectors,
          eq(faceVectors.id, faceIdentityMembers.faceVectorId)
        )
        .innerJoin(photos, eq(photos.id, faceVectors.photoId))
        .where(
          and(
            eq(faceIdentities.isConfirmed, true),
            inArray(photos.folderId, scopeFolderIds),
            isNull(photos.deletedAt)
          )
        )
        .all();
      const preservedPhotoIds = new Set(
        confirmedRows.map((row) => row.photoId)
      );
      const removableVectorIds = scopedVectorRows
        .filter((row) => !preservedPhotoIds.has(row.photoId))
        .map((row) => row.id);
      const affectedIdentityIds = new Set<number>();
      for (let index = 0; index < removableVectorIds.length; index += 500) {
        const chunk = removableVectorIds.slice(index, index + 500);
        for (const row of db
          .select({ id: faceIdentityMembers.identityId })
          .from(faceIdentityMembers)
          .where(inArray(faceIdentityMembers.faceVectorId, chunk))
          .all()) {
          affectedIdentityIds.add(row.id);
        }
      }

      db.transaction(() => {
        for (let index = 0; index < removableVectorIds.length; index += 500) {
          const chunk = removableVectorIds.slice(index, index + 500);
          db.delete(faceVectors)
            .where(inArray(faceVectors.id, chunk))
            .run();
        }

        db.update(photos)
          .set({ isFaceProcessed: false })
          .where(
            and(
              inArray(photos.folderId, scopeFolderIds),
              isNull(photos.deletedAt)
            )
          )
          .run();
        const preservedIds = [...preservedPhotoIds];
        for (let index = 0; index < preservedIds.length; index += 500) {
          db.update(photos)
            .set({ isFaceProcessed: true })
            .where(inArray(photos.id, preservedIds.slice(index, index + 500)))
            .run();
        }

        for (const identityId of affectedIdentityIds) {
          const identity = db
            .select({ isConfirmed: faceIdentities.isConfirmed })
            .from(faceIdentities)
            .where(eq(faceIdentities.id, identityId))
            .get();
          const remainingMember = db
            .select({ id: faceIdentityMembers.id })
            .from(faceIdentityMembers)
            .where(eq(faceIdentityMembers.identityId, identityId))
            .get();
          if (identity && !identity.isConfirmed && !remainingMember) {
            db.delete(faceIdentities)
              .where(eq(faceIdentities.id, identityId))
              .run();
          } else {
            refreshFaceIdentityMetadata(identityId);
          }
        }
      });
    }

    const ids = db
      .select({ id: photos.id })
      .from(photos)
      .where(
        and(
          inArray(photos.folderId, scopeFolderIds),
          eq(photos.isFaceProcessed, false),
          isNull(photos.deletedAt)
        )
      )
      .all()
      .map((photo) => photo.id);

    if (!ids.length) {
      return { started: false, message: "没有需要检测的照片" };
    }

    // Fire and forget — detection runs async with progress pushed to renderer
    detectFaces(ids, (progress) => {
      const { BrowserWindow } = require("electron");
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("face-detection-progress", progress);
      }
    })
      .then((totalFaces) => {
        const { BrowserWindow } = require("electron");
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("face-detection-done", { totalFaces });
        }
      })
      .catch((err) => {
        console.error("[Faces] Detection error:", err);
        const { BrowserWindow } = require("electron");
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("face-detection-done", {
            error: err?.message || "Unknown error",
          });
        }
      });

    return { started: true, photoCount: ids.length };
  });

export const getScanScope = os.handler(() => getFaceScanScope());

export const setScanScope = os
  .input(
    z.object({
      folderIds: z.array(z.number().int().positive()).min(1),
    })
  )
  .handler(({ input }) => setFaceScanScope(input.folderIds));

export const getDetectionProgress = os.handler(() => {
  return getFaceDetectionProgress();
});

export const listFaceIdentities = os.handler(() => {
  const db = getDatabase();

  // 1. Fetch all identities ordered by faceCount DESC
  const identities = db
    .select()
    .from(faceIdentities)
    .orderBy(desc(faceIdentities.faceCount))
    .all();

  if (identities.length === 0) {
    return [];
  }

  // 2. Batch-fetch cover photos (single IN query)
  const photoIds = [
    ...new Set(
      identities
        .map((i) => i.representativePhotoId)
        .filter((id): id is number => id != null)
    ),
  ];
  const photoMap = new Map<
    number,
    {
      thumbnailPath: string | null;
      path: string;
      width: number | null;
      height: number | null;
    }
  >();
  if (photoIds.length > 0) {
    const photoRows = db
      .select({
        id: photos.id,
        thumbnailPath: photos.thumbnailPath,
        path: photos.path,
        width: photos.width,
        height: photos.height,
      })
      .from(photos)
      .where(inArray(photos.id, photoIds))
      .all();
    for (const p of photoRows) {
      photoMap.set(p.id, p);
    }
  }

  // 3. Batch-fetch face bbox per identity + unique photo count
  // JOIN photos to exclude soft-deleted photos from face count & bbox
  // Include vectorId so we can look up the exact bbox for representative_vector_id
  const bboxMap = new Map<
    number,
    { x: number; y: number; width: number; height: number }
  >();
  const vectorBboxMap = new Map<
    number,
    { x: number; y: number; width: number; height: number }
  >();
  const uniquePhotoCountMap = new Map<number, Set<number>>();
  const allMembers = db
    .select({
      identityId: faceIdentityMembers.identityId,
      photoId: faceVectors.photoId,
      vectorId: faceVectors.id,
      bboxX: faceVectors.bboxX,
      bboxY: faceVectors.bboxY,
      bboxWidth: faceVectors.bboxWidth,
      bboxHeight: faceVectors.bboxHeight,
    })
    .from(faceIdentityMembers)
    .innerJoin(
      faceVectors,
      eq(faceVectors.id, faceIdentityMembers.faceVectorId)
    )
    .innerJoin(photos, eq(photos.id, faceVectors.photoId))
    .where(isNull(photos.deletedAt))
    .all();
  for (const m of allMembers) {
    if (!bboxMap.has(m.identityId)) {
      bboxMap.set(m.identityId, {
        x: m.bboxX,
        y: m.bboxY,
        width: m.bboxWidth,
        height: m.bboxHeight,
      });
    }
    // Build per-vector-id bbox map for representative_vector_id override
    vectorBboxMap.set(m.vectorId, {
      x: m.bboxX,
      y: m.bboxY,
      width: m.bboxWidth,
      height: m.bboxHeight,
    });
    if (!uniquePhotoCountMap.has(m.identityId)) {
      uniquePhotoCountMap.set(m.identityId, new Set());
    }
    uniquePhotoCountMap.get(m.identityId)!.add(m.photoId);
  }

  // 4. Assemble results (pure in-memory)
  // Override faceCount with unique photo count per identity
  return identities.map((identity) => {
    const photo = identity.representativePhotoId
      ? photoMap.get(identity.representativePhotoId)
      : undefined;
    const uniquePhotos = uniquePhotoCountMap.get(identity.id);
    // Use the exact face vector's bbox when representative_vector_id is set
    let coverBbox = bboxMap.get(identity.id) ?? null;
    if (identity.representativeVectorId != null) {
      const repId = Number(identity.representativeVectorId);
      if (!Number.isNaN(repId)) {
        const specificBbox = vectorBboxMap.get(repId);
        if (specificBbox) {
          coverBbox = specificBbox;
        }
      }
    }
    return {
      ...identity,
      faceCount: uniquePhotos?.size ?? 0,
      coverThumbnailPath: photo?.thumbnailPath || photo?.path || null,
      coverPhotoPath: photo?.path ?? null,
      coverPhotoWidth: photo?.width ?? null,
      coverPhotoHeight: photo?.height ?? null,
      coverBbox,
    };
  });
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

  // Exclude faces from soft-deleted photos
  const allPhotoIds = [...new Set(faces.map((f) => f.photoId))];
  const validPhotoSet = new Set<number>();
  if (allPhotoIds.length > 0) {
    const rows = db
      .select({ id: photos.id })
      .from(photos)
      .where(and(inArray(photos.id, allPhotoIds), isNull(photos.deletedAt)))
      .all();
    for (const r of rows) {
      validPhotoSet.add(r.id);
    }
  }
  const validFaces = faces.filter((f) => validPhotoSet.has(f.photoId));

  const photoIds = [...new Set(validFaces.map((f) => f.photoId))];
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

  return { ...identity, faces: validFaces, photos: photoRows };
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
    let faceCount = 0;
    if (input.faceVectorIds?.length) {
      const photoIds = db
        .select({ photoId: faceVectors.photoId })
        .from(faceVectors)
        .where(inArray(faceVectors.id, input.faceVectorIds))
        .all();
      faceCount = new Set(photoIds.map((p) => p.photoId)).size;
    }
    const result = db
      .insert(faceIdentities)
      .values({
        name: input.name,
        faceCount,
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
      representativePhotoId: z.number().optional().nullable(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const setData: Record<string, unknown> = {};
    if (input.name !== undefined) {
      setData.name = input.name;
      setData.isConfirmed = true;
    }
    if (input.representativePhotoId !== undefined) {
      setData.representativePhotoId = input.representativePhotoId;
      if (input.representativePhotoId === null) {
        setData.representativeVectorId = null;
      } else {
        // Find the face_vector in the chosen photo that belongs to this identity
        const memberFace = db
          .select({
            vectorId: faceVectors.id,
            confidence: faceVectors.confidence,
          })
          .from(faceIdentityMembers)
          .innerJoin(
            faceVectors,
            eq(faceVectors.id, faceIdentityMembers.faceVectorId)
          )
          .where(
            and(
              eq(faceIdentityMembers.identityId, input.id),
              eq(faceVectors.photoId, input.representativePhotoId)
            )
          )
          .orderBy(desc(faceVectors.confidence))
          .limit(1)
          .get();
        setData.representativeVectorId =
          memberFace?.vectorId == null ? null : String(memberFace.vectorId);
      }
    }
    db.update(faceIdentities)
      .set(setData)
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
        faceCount: sql`(SELECT COUNT(DISTINCT ${faceVectors.photoId}) FROM ${faceIdentityMembers} INNER JOIN ${faceVectors} ON ${faceVectors.id} = ${faceIdentityMembers.faceVectorId} WHERE ${faceIdentityMembers.identityId} = ${input.targetId})`,
      })
      .where(eq(faceIdentities.id, input.targetId))
      .run();

    // Fix representative_vector_id after merge: the default bbox (first face_vector
    // per identity) may now come from a merged source's photo with different dimensions.
    // Look up the correct face_vector in the current representative photo.
    const target = db
      .select({
        representativePhotoId: faceIdentities.representativePhotoId,
      })
      .from(faceIdentities)
      .where(eq(faceIdentities.id, input.targetId))
      .get();

    if (target?.representativePhotoId) {
      const bestFace = db
        .select({ vectorId: faceVectors.id })
        .from(faceIdentityMembers)
        .innerJoin(
          faceVectors,
          eq(faceVectors.id, faceIdentityMembers.faceVectorId)
        )
        .where(
          and(
            eq(faceIdentityMembers.identityId, input.targetId),
            eq(faceVectors.photoId, target.representativePhotoId)
          )
        )
        .orderBy(desc(faceVectors.confidence))
        .limit(1)
        .get();

      db.update(faceIdentities)
        .set({
          representativeVectorId:
            bestFace?.vectorId == null ? null : String(bestFace.vectorId),
        })
        .where(eq(faceIdentities.id, input.targetId))
        .run();
    }

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
      .select({ count: sql<number>`COUNT(DISTINCT ${faceVectors.photoId})` })
      .from(faceIdentityMembers)
      .innerJoin(
        faceVectors,
        eq(faceVectors.id, faceIdentityMembers.faceVectorId)
      )
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

export const cancelFaceDetection_h = os.handler(() => {
  if (!isFaceDetectionRunning()) {
    return { cancelled: false, message: "没有正在运行的人脸检测" };
  }
  cancelFaceDetection();
  return { cancelled: true };
});

export const recluster = os.handler(async () => {
  if (isFaceDetectionRunning()) {
    return { ok: false, message: "人脸检测正在运行中，请稍后再试" };
  }
  const result = await reclusterAllFaces();
  return { ok: true, identityCount: result.merged };
});
