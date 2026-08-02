import { os } from "@orpc/server";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  photos,
} from "@/db/schema";
import { getActiveFaceModel } from "@/services/ai/face-model-config";
import {
  cancelFaceDetection,
  cosineSimilarity,
  detectFaces,
  getFaceDetectionProgress,
  isFaceDetectionRunning,
  isFaceModelMismatch,
  reclusterAllFaces,
  refreshFaceIdentityMetadata,
  resetFaceDataForModelSwitch,
} from "@/services/face-detector";
import {
  getFaceScanScope,
  resolveFaceScanFolderIds,
  setFaceScanScope,
} from "@/services/face-scan-scope";

const IdSchema = z.object({ id: z.number() });

function parseNumericVector(value: string | null): number[] | null {
  if (!value) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) &&
      parsed.every((item) => typeof item === "number")
      ? parsed
      : null;
  } catch {
    return null;
  }
}

const ReviewCategorySchema = z.enum([
  "all",
  "unmatched",
  "low_confidence",
  "removed_from_identity",
  "ignored",
]);

type ReviewCategory = z.infer<typeof ReviewCategorySchema>;

function upsertReviewDecision(
  db: ReturnType<typeof getDatabase>,
  input: {
    decision: "rejected" | "removed_from_identity";
    faceIndex: number;
    photoId: number;
    sourceIdentityId?: number | null;
    sourceIdentityName?: string | null;
  }
): void {
  db.delete(faceReviewDecisions)
    .where(
      and(
        eq(faceReviewDecisions.photoId, input.photoId),
        eq(faceReviewDecisions.faceIndex, input.faceIndex)
      )
    )
    .run();
  db.insert(faceReviewDecisions)
    .values({
      decision: input.decision,
      faceIndex: input.faceIndex,
      photoId: input.photoId,
      sourceIdentityId: input.sourceIdentityId ?? null,
      sourceIdentityName: input.sourceIdentityName ?? null,
      updatedAt: Date.now(),
    })
    .run();
}

function clearReviewDecision(
  db: ReturnType<typeof getDatabase>,
  photoId: number,
  faceIndex: number
): void {
  db.delete(faceReviewDecisions)
    .where(
      and(
        eq(faceReviewDecisions.photoId, photoId),
        eq(faceReviewDecisions.faceIndex, faceIndex)
      )
    )
    .run();
}

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

    // Stored vectors belong to a different model kind than the active one —
    // they cannot be compared. Ask the renderer to reset before detecting.
    if (isFaceModelMismatch()) {
      return {
        started: false,
        requiresModelReset: true,
        message: "人脸识别模型已变更，需重置人脸数据后重新检测",
      };
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
        and(inArray(photos.folderId, scopeFolderIds), isNull(photos.deletedAt))
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
          db.delete(faceVectors).where(inArray(faceVectors.id, chunk)).run();
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
    .where(
      and(
        sql`${faceIdentities.faceCount} > 0`,
        eq(faceIdentities.isHidden, false)
      )
    )
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

  let centroid: number[] | null = null;
  if (identity.centroidEmbedding) {
    try {
      const parsed: unknown = JSON.parse(identity.centroidEmbedding);
      if (
        Array.isArray(parsed) &&
        parsed.every((value) => typeof value === "number")
      ) {
        centroid = parsed;
      }
    } catch {
      centroid = null;
    }
  }

  const faceViews = validFaces.map((face) => {
    let identitySimilarity: number | null = null;
    if (centroid && face.embedding) {
      try {
        const embedding: unknown = JSON.parse(face.embedding);
        if (
          Array.isArray(embedding) &&
          embedding.every((value) => typeof value === "number") &&
          embedding.length === centroid.length
        ) {
          identitySimilarity = cosineSimilarity(embedding, centroid);
        }
      } catch {
        identitySimilarity = null;
      }
    }
    return {
      id: face.id,
      photoId: face.photoId,
      faceIndex: face.faceIndex,
      bboxX: face.bboxX,
      bboxY: face.bboxY,
      bboxWidth: face.bboxWidth,
      bboxHeight: face.bboxHeight,
      detectionConfidence: face.confidence,
      identitySimilarity,
      isRejected: face.isRejected,
    };
  });

  return { ...identity, faces: faceViews, photos: photoRows };
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
    let insertedId: number | undefined;
    db.transaction(() => {
      const result = db
        .insert(faceIdentities)
        .values({ name: input.name, isConfirmed: true })
        .returning({ insertedId: faceIdentities.id })
        .get();
      insertedId = result?.insertedId;
      if (!(insertedId && input.faceVectorIds?.length)) {
        return;
      }
      for (const fvId of input.faceVectorIds) {
        const vector = db
          .select({
            faceIndex: faceVectors.faceIndex,
            id: faceVectors.id,
            isRejected: faceVectors.isRejected,
            photoId: faceVectors.photoId,
          })
          .from(faceVectors)
          .where(eq(faceVectors.id, fvId))
          .get();
        if (!vector || vector.isRejected) {
          continue;
        }
        db.delete(faceIdentityMembers)
          .where(eq(faceIdentityMembers.faceVectorId, fvId))
          .run();
        db.delete(faceIdentityExclusions)
          .where(eq(faceIdentityExclusions.faceVectorId, fvId))
          .run();
        clearReviewDecision(db, vector.photoId, vector.faceIndex);
        db.insert(faceIdentityMembers)
          .values({ identityId: insertedId, faceVectorId: fvId })
          .onConflictDoNothing()
          .run();
      }
      refreshFaceIdentityMetadata(insertedId);
    });
    if (!insertedId) {
      throw new Error("Failed to create face identity");
    }

    return db
      .select()
      .from(faceIdentities)
      .where(eq(faceIdentities.id, insertedId))
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
    if (input.sourceIds.includes(input.targetId)) {
      throw new Error("Target identity cannot also be a source identity");
    }
    const target = db
      .select({ id: faceIdentities.id })
      .from(faceIdentities)
      .where(eq(faceIdentities.id, input.targetId))
      .get();
    if (!target) {
      throw new Error("Target identity not found");
    }

    db.transaction(() => {
      for (const srcId of new Set(input.sourceIds)) {
        const exclusions = db
          .select({ faceVectorId: faceIdentityExclusions.faceVectorId })
          .from(faceIdentityExclusions)
          .where(eq(faceIdentityExclusions.identityId, srcId))
          .all();

        // A face vector can have only one membership. Inserting the target
        // membership before deleting the source conflicts with that invariant
        // and would drop every source member when the source is cascaded.
        db.update(faceIdentityMembers)
          .set({ identityId: input.targetId })
          .where(eq(faceIdentityMembers.identityId, srcId))
          .run();
        for (const exclusion of exclusions) {
          const alreadyMember = db
            .select({ id: faceIdentityMembers.id })
            .from(faceIdentityMembers)
            .where(
              and(
                eq(faceIdentityMembers.identityId, input.targetId),
                eq(faceIdentityMembers.faceVectorId, exclusion.faceVectorId)
              )
            )
            .get();
          if (!alreadyMember) {
            db.insert(faceIdentityExclusions)
              .values({
                identityId: input.targetId,
                faceVectorId: exclusion.faceVectorId,
              })
              .onConflictDoNothing()
              .run();
          }
        }
        db.delete(faceIdentities).where(eq(faceIdentities.id, srcId)).run();
      }
      db.update(faceIdentities)
        .set({ isConfirmed: true })
        .where(eq(faceIdentities.id, input.targetId))
        .run();
      refreshFaceIdentityMetadata(input.targetId);
    });

    return { ok: true };
  });

export const deleteFaceIdentity = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const identity = db
    .select({ id: faceIdentities.id })
    .from(faceIdentities)
    .where(eq(faceIdentities.id, input.id))
    .get();
  if (!identity) {
    throw new Error("Identity not found");
  }
  // Hiding a person must not turn valid face detections into global rejects.
  // Keep memberships and vectors so the user can restore the person later.
  db.update(faceIdentities)
    .set({ isHidden: true, isConfirmed: true })
    .where(eq(faceIdentities.id, input.id))
    .run();
  return { ok: true };
});

// Explicit name for the recoverable archive action. Keep the old route for compatibility.
export const hideFaceIdentity = deleteFaceIdentity;

export const listHiddenFaceIdentities = os.handler(() => {
  const db = getDatabase();
  return db
    .select({
      coverPhotoPath: photos.path,
      coverThumbnailPath: photos.thumbnailPath,
      createdAt: faceIdentities.createdAt,
      faceCount: faceIdentities.faceCount,
      id: faceIdentities.id,
      name: faceIdentities.name,
    })
    .from(faceIdentities)
    .leftJoin(photos, eq(photos.id, faceIdentities.representativePhotoId))
    .where(eq(faceIdentities.isHidden, true))
    .orderBy(desc(faceIdentities.faceCount))
    .all();
});

export const restoreHiddenFaceIdentity = os
  .input(IdSchema)
  .handler(({ input }) => {
    const db = getDatabase();
    db.update(faceIdentities)
      .set({ isHidden: false })
      .where(eq(faceIdentities.id, input.id))
      .run();
    return { ok: true };
  });

export const removeFaceFromIdentity = os
  .input(z.object({ identityId: z.number(), faceVectorId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    let remainingCount = 0;
    db.transaction(() => {
      const member = db
        .select({ id: faceIdentityMembers.id })
        .from(faceIdentityMembers)
        .where(
          and(
            eq(faceIdentityMembers.identityId, input.identityId),
            eq(faceIdentityMembers.faceVectorId, input.faceVectorId)
          )
        )
        .get();
      const identity = db
        .select({ name: faceIdentities.name })
        .from(faceIdentities)
        .where(eq(faceIdentities.id, input.identityId))
        .get();
      const vector = db
        .select({
          faceIndex: faceVectors.faceIndex,
          photoId: faceVectors.photoId,
        })
        .from(faceVectors)
        .where(eq(faceVectors.id, input.faceVectorId))
        .get();
      if (!(member && identity && vector)) {
        throw new Error("Face is not a member of this identity");
      }

      db.delete(faceIdentityMembers)
        .where(eq(faceIdentityMembers.id, member.id))
        .run();
      db.delete(faceIdentityExclusions)
        .where(
          and(
            eq(faceIdentityExclusions.identityId, input.identityId),
            eq(faceIdentityExclusions.faceVectorId, input.faceVectorId)
          )
        )
        .run();
      db.insert(faceIdentityExclusions)
        .values({
          identityId: input.identityId,
          faceVectorId: input.faceVectorId,
        })
        .onConflictDoNothing()
        .run();
      upsertReviewDecision(db, {
        decision: "removed_from_identity",
        faceIndex: vector.faceIndex,
        photoId: vector.photoId,
        sourceIdentityId: input.identityId,
        sourceIdentityName: identity.name,
      });

      const remaining = db
        .select({ count: sql<number>`COUNT(DISTINCT ${faceVectors.photoId})` })
        .from(faceIdentityMembers)
        .innerJoin(
          faceVectors,
          eq(faceVectors.id, faceIdentityMembers.faceVectorId)
        )
        .where(eq(faceIdentityMembers.identityId, input.identityId))
        .get();
      remainingCount = remaining?.count ?? 0;
      if (remainingCount === 0) {
        db.delete(faceIdentities)
          .where(eq(faceIdentities.id, input.identityId))
          .run();
      } else {
        refreshFaceIdentityMetadata(input.identityId);
      }
    });
    return { ok: true, remainingCount };
  });

export const restoreFaceToIdentity = os
  .input(z.object({ identityId: z.number(), faceVectorId: z.number() }))
  .handler(({ input }) => {
    const db = getDatabase();
    const identity = db
      .select({ id: faceIdentities.id })
      .from(faceIdentities)
      .where(eq(faceIdentities.id, input.identityId))
      .get();
    const vector = db
      .select({ id: faceVectors.id, isRejected: faceVectors.isRejected })
      .from(faceVectors)
      .where(eq(faceVectors.id, input.faceVectorId))
      .get();
    if (!(identity && vector) || vector.isRejected) {
      throw new Error("Identity or face vector not found");
    }

    const photo = db
      .select({
        faceIndex: faceVectors.faceIndex,
        photoId: faceVectors.photoId,
      })
      .from(faceVectors)
      .where(eq(faceVectors.id, input.faceVectorId))
      .get();
    if (!photo) {
      throw new Error("Face vector not found");
    }
    db.transaction(() => {
      db.delete(faceIdentityMembers)
        .where(eq(faceIdentityMembers.faceVectorId, input.faceVectorId))
        .run();
      db.delete(faceIdentityExclusions)
        .where(eq(faceIdentityExclusions.faceVectorId, input.faceVectorId))
        .run();
      clearReviewDecision(db, photo.photoId, photo.faceIndex);
      db.update(faceVectors)
        .set({ isRejected: false })
        .where(eq(faceVectors.id, input.faceVectorId))
        .run();
      db.insert(faceIdentityMembers)
        .values({
          identityId: input.identityId,
          faceVectorId: input.faceVectorId,
        })
        .onConflictDoNothing()
        .run();
      refreshFaceIdentityMetadata(input.identityId);
    });
    return { ok: true };
  });

function queryFaceReviewQueue(input: {
  category: ReviewCategory;
  limit: number;
  offset: number;
  status: "pending" | "ignored";
}) {
  const db = getDatabase();
  const model = getActiveFaceModel();
  const identities = db
    .select({
      centroidEmbedding: faceIdentities.centroidEmbedding,
      id: faceIdentities.id,
      name: faceIdentities.name,
    })
    .from(faceIdentities)
    .where(eq(faceIdentities.isHidden, false))
    .all()
    .flatMap((identity) => {
      const centroid = parseNumericVector(identity.centroidEmbedding);
      return centroid ? [{ ...identity, centroid }] : [];
    });
  const members = db
    .select({
      faceVectorId: faceIdentityMembers.faceVectorId,
      identityId: faceIdentityMembers.identityId,
    })
    .from(faceIdentityMembers)
    .all();
  const memberByFace = new Map<number, number>();
  for (const member of members) {
    if (!memberByFace.has(member.faceVectorId)) {
      memberByFace.set(member.faceVectorId, member.identityId);
    }
  }
  const decisions = db.select().from(faceReviewDecisions).all();
  const decisionByKey = new Map<string, (typeof decisions)[number]>();
  for (const decision of decisions) {
    decisionByKey.set(`${decision.photoId}:${decision.faceIndex}`, decision);
  }
  const identityById = new Map(
    identities.map((identity) => [identity.id, identity])
  );
  const rows = db
    .select({
      bboxHeight: faceVectors.bboxHeight,
      bboxWidth: faceVectors.bboxWidth,
      bboxX: faceVectors.bboxX,
      bboxY: faceVectors.bboxY,
      detectionConfidence: faceVectors.confidence,
      embedding: faceVectors.embedding,
      faceIndex: faceVectors.faceIndex,
      id: faceVectors.id,
      isRejected: faceVectors.isRejected,
      photoHeight: photos.height,
      photoId: faceVectors.photoId,
      photoPath: photos.path,
      photoWidth: photos.width,
      thumbnailPath: photos.thumbnailPath,
    })
    .from(faceVectors)
    .innerJoin(photos, eq(photos.id, faceVectors.photoId))
    .where(isNull(photos.deletedAt))
    .all();

  const candidates = rows.flatMap((row) => {
    const decision = decisionByKey.get(`${row.photoId}:${row.faceIndex}`);
    const isIgnored = row.isRejected || decision?.decision === "rejected";
    if (input.status === "ignored" ? !isIgnored : isIgnored) {
      return [];
    }
    if (input.status === "pending" && !row.embedding) {
      return [];
    }
    const memberIdentityId = memberByFace.get(row.id) ?? null;
    if (input.status === "pending" && memberIdentityId !== null) {
      return [];
    }
    const confidence = row.detectionConfidence;
    if (
      input.status === "pending" &&
      confidence !== null &&
      confidence < model.clustering.reviewConfidenceFloor
    ) {
      return [];
    }
    const reason: ReviewCategory = isIgnored
      ? "ignored"
      : decision?.decision === "removed_from_identity"
        ? "removed_from_identity"
        : confidence !== null && confidence < model.clustering.confidenceFilter
          ? "low_confidence"
          : "unmatched";
    if (input.category !== "all" && input.category !== reason) {
      return [];
    }
    const embedding = parseNumericVector(row.embedding);
    const excludedIdentityId = decision?.sourceIdentityId ?? null;
    let bestIdentityId: number | null = null;
    let bestIdentityName: string | null = null;
    let identitySimilarity: number | null = null;
    if (embedding) {
      for (const identity of identities) {
        if (
          identity.id === excludedIdentityId ||
          identity.centroid.length !== embedding.length
        ) {
          continue;
        }
        const similarity = cosineSimilarity(embedding, identity.centroid);
        if (identitySimilarity === null || similarity > identitySimilarity) {
          bestIdentityId = identity.id;
          bestIdentityName = identity.name;
          identitySimilarity = similarity;
        }
      }
    }
    const sourceIdentity = decision?.sourceIdentityId
      ? identityById.get(decision.sourceIdentityId)
      : undefined;
    return [
      {
        bestIdentityId,
        bestIdentityName,
        bboxHeight: row.bboxHeight,
        bboxWidth: row.bboxWidth,
        bboxX: row.bboxX,
        bboxY: row.bboxY,
        detectionConfidence: row.detectionConfidence,
        faceIndex: row.faceIndex,
        id: row.id,
        identitySimilarity,
        photoHeight: row.photoHeight,
        photoId: row.photoId,
        photoPath: row.photoPath,
        photoWidth: row.photoWidth,
        reason,
        sourceIdentityId: decision?.sourceIdentityId ?? null,
        sourceIdentityName:
          decision?.sourceIdentityName ?? sourceIdentity?.name ?? null,
        status: input.status,
        thumbnailPath: row.thumbnailPath,
      },
    ];
  });
  candidates.sort(
    (a, b) =>
      (b.detectionConfidence ?? 0) - (a.detectionConfidence ?? 0) || b.id - a.id
  );
  return candidates.slice(input.offset, input.offset + input.limit);
}

export const listFaceReviewQueue = os
  .input(
    z
      .object({
        category: ReviewCategorySchema.optional(),
        cursor: z.string().optional(),
        limit: z.number().int().positive().max(500).optional(),
        status: z.enum(["pending", "ignored"]).optional(),
      })
      .optional()
  )
  .handler(({ input }) =>
    queryFaceReviewQueue({
      category: input?.category ?? "all",
      limit: input?.limit ?? 200,
      offset: Number.parseInt(input?.cursor ?? "0", 10) || 0,
      status: input?.status ?? "pending",
    })
  );

export const listPhotoFaces = os
  .input(z.object({ photoId: z.number().int().positive() }))
  .handler(({ input }) => {
    const db = getDatabase();
    const model = getActiveFaceModel();
    return db
      .select({
        bboxHeight: faceVectors.bboxHeight,
        bboxWidth: faceVectors.bboxWidth,
        bboxX: faceVectors.bboxX,
        bboxY: faceVectors.bboxY,
        detectionConfidence: faceVectors.confidence,
        embedding: faceVectors.embedding,
        faceIndex: faceVectors.faceIndex,
        id: faceVectors.id,
        identityId: faceIdentityMembers.identityId,
        identityName: faceIdentities.name,
        isRejected: faceVectors.isRejected,
      })
      .from(faceVectors)
      .leftJoin(
        faceIdentityMembers,
        eq(faceIdentityMembers.faceVectorId, faceVectors.id)
      )
      .leftJoin(
        faceIdentities,
        eq(faceIdentities.id, faceIdentityMembers.identityId)
      )
      .where(eq(faceVectors.photoId, input.photoId))
      .orderBy(faceVectors.faceIndex)
      .all()
      .map((face) => {
        let status: "assigned" | "ignored" | "pending" | "skipped" = "pending";
        if (face.isRejected) {
          status = "ignored";
        } else if (face.identityId !== null) {
          status = "assigned";
        } else if (
          !face.embedding ||
          (face.detectionConfidence !== null &&
            face.detectionConfidence < model.clustering.reviewConfidenceFloor)
        ) {
          status = "skipped";
        }
        const { embedding: _embedding, ...publicFace } = face;
        return { ...publicFace, status };
      });
  });

// Kept as a compatibility route for existing callers and plugins.
export const listFaceCandidates = os
  .input(
    z
      .object({ limit: z.number().int().positive().max(500).optional() })
      .optional()
  )
  .handler(({ input }) =>
    queryFaceReviewQueue({
      category: "all",
      limit: input?.limit ?? 200,
      offset: 0,
      status: "pending",
    })
  );

export const reviewFace = os
  .input(
    z.object({
      action: z.enum(["assign", "reject", "keep_pending"]),
      faceVectorId: z.number(),
      identityId: z.number().optional(),
    })
  )
  .handler(({ input }) => {
    const db = getDatabase();
    const vector = db
      .select({
        faceIndex: faceVectors.faceIndex,
        id: faceVectors.id,
        photoId: faceVectors.photoId,
      })
      .from(faceVectors)
      .where(eq(faceVectors.id, input.faceVectorId))
      .get();
    if (!vector) {
      throw new Error("Face vector not found");
    }
    if (input.action === "keep_pending") {
      return { ok: true };
    }
    const previousMembers = db
      .select({ identityId: faceIdentityMembers.identityId })
      .from(faceIdentityMembers)
      .where(eq(faceIdentityMembers.faceVectorId, input.faceVectorId))
      .all();
    if (input.action === "assign") {
      if (!input.identityId) {
        throw new Error("Identity is required when assigning a face");
      }
      const identityId = input.identityId;
      const identity = db
        .select({ id: faceIdentities.id })
        .from(faceIdentities)
        .where(eq(faceIdentities.id, identityId))
        .get();
      if (!identity) {
        throw new Error("Identity not found");
      }
      db.transaction(() => {
        db.delete(faceIdentityMembers)
          .where(eq(faceIdentityMembers.faceVectorId, input.faceVectorId))
          .run();
        db.delete(faceIdentityExclusions)
          .where(eq(faceIdentityExclusions.faceVectorId, input.faceVectorId))
          .run();
        clearReviewDecision(db, vector.photoId, vector.faceIndex);
        db.update(faceVectors)
          .set({ isRejected: false })
          .where(eq(faceVectors.id, input.faceVectorId))
          .run();
        db.insert(faceIdentityMembers)
          .values({
            faceVectorId: input.faceVectorId,
            identityId,
          })
          .onConflictDoNothing()
          .run();
        db.update(faceIdentities)
          .set({ isConfirmed: true })
          .where(eq(faceIdentities.id, identityId))
          .run();
        for (const previous of previousMembers) {
          if (previous.identityId !== identityId) {
            refreshFaceIdentityMetadata(previous.identityId);
          }
        }
        refreshFaceIdentityMetadata(identityId);
      });
      return { ok: true };
    }

    db.transaction(() => {
      db.delete(faceIdentityMembers)
        .where(eq(faceIdentityMembers.faceVectorId, input.faceVectorId))
        .run();
      db.delete(faceIdentityExclusions)
        .where(eq(faceIdentityExclusions.faceVectorId, input.faceVectorId))
        .run();
      db.update(faceVectors)
        .set({ isRejected: true })
        .where(eq(faceVectors.id, input.faceVectorId))
        .run();
      upsertReviewDecision(db, {
        decision: "rejected",
        faceIndex: vector.faceIndex,
        photoId: vector.photoId,
      });
      for (const previous of previousMembers) {
        refreshFaceIdentityMetadata(previous.identityId);
      }
    });
    return { ok: true };
  });

// Backwards-compatible name used by existing renderer actions.
export const confirmFace = reviewFace;

export const restoreRejectedFace = os.input(IdSchema).handler(({ input }) => {
  const db = getDatabase();
  const vector = db
    .select({
      faceIndex: faceVectors.faceIndex,
      isRejected: faceVectors.isRejected,
      photoId: faceVectors.photoId,
    })
    .from(faceVectors)
    .where(eq(faceVectors.id, input.id))
    .get();
  if (!vector) {
    throw new Error("Face vector not found");
  }
  const decision = db
    .select({ decision: faceReviewDecisions.decision })
    .from(faceReviewDecisions)
    .where(
      and(
        eq(faceReviewDecisions.photoId, vector.photoId),
        eq(faceReviewDecisions.faceIndex, vector.faceIndex)
      )
    )
    .get();
  if (decision?.decision !== "rejected" && !vector.isRejected) {
    throw new Error("Face is not ignored");
  }
  db.transaction(() => {
    db.update(faceVectors)
      .set({ isRejected: false })
      .where(eq(faceVectors.id, input.id))
      .run();
    clearReviewDecision(db, vector.photoId, vector.faceIndex);
  });
  return { ok: true };
});

export const cancelFaceDetection_h = os.handler(() => {
  if (!isFaceDetectionRunning()) {
    return { cancelled: false, message: "没有正在运行的人脸检测" };
  }
  cancelFaceDetection();
  return { cancelled: true };
});

export const resetFaceData = os.handler(() => {
  if (isFaceDetectionRunning()) {
    throw new Error(
      "Face detection is running; cancel it before resetting face data"
    );
  }
  resetFaceDataForModelSwitch();
  return { ok: true };
});

export const recluster = os.handler(async () => {
  if (isFaceDetectionRunning()) {
    return { ok: false, message: "人脸检测正在运行中，请稍后再试" };
  }
  const result = await reclusterAllFaces();
  return { ok: true, identityCount: result.merged };
});
