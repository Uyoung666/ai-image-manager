import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { and, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import {
  appSettings,
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  photos,
} from "@/db/schema";
import { getActiveFaceModel } from "@/services/ai/face-model-config";
import {
  abortAllFaceWorkers,
  detectFacesWithPool,
  getFacePoolInitProgress,
  initFaceWorkerPool,
  shutdownFacePool,
} from "@/services/face-worker-pool";
import { getSetting, setSetting } from "@/services/settings-manager";
import { getDataPath } from "@/utils/data-path";

const BATCH_SIZE = 40;
let detectionRunning = false;

export class FaceEmbeddingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaceEmbeddingValidationError";
  }
}

/** Cancel a running face detection operation and abort all workers. */
export function cancelFaceDetection(): void {
  detectionRunning = false;
  abortAllFaceWorkers();
}

/** Check whether face detection is currently running. */
export function isFaceDetectionRunning(): boolean {
  return detectionRunning;
}

/**
 * Whether the stored face vectors belong to a different model than the active
 * one. First use (no stored kind) returns false — nothing to invalidate.
 */
export function isFaceModelMismatch(): boolean {
  const stored = getSetting("face.model.kind");
  const activeModel = getActiveFaceModel();
  if (stored === null) {
    const db = getDatabase();
    return Boolean(
      db.select({ id: faceVectors.id }).from(faceVectors).limit(1).get() ||
        db
          .select({ id: faceIdentities.id })
          .from(faceIdentities)
          .limit(1)
          .get() ||
        db
          .select({ id: photos.id })
          .from(photos)
          .where(eq(photos.isFaceProcessed, true))
          .limit(1)
          .get()
    );
  }
  if (stored !== activeModel.kind) {
    return true;
  }

  const db = getDatabase();
  const rows = db
    .select({ embedding: faceVectors.embedding })
    .from(faceVectors)
    .all();
  return rows.some((row) => {
    if (!row.embedding) {
      return false;
    }
    try {
      const embedding: unknown = JSON.parse(row.embedding);
      return (
        !Array.isArray(embedding) ||
        embedding.length !== activeModel.recognition.vectorDimensions ||
        embedding.some(
          (value) => typeof value !== "number" || !Number.isFinite(value)
        )
      );
    } catch {
      return true;
    }
  });
}

interface FaceDataBackupPayload {
  backupOf: string;
  checksum: string;
  createdAt: number;
  faceIdentities: Record<string, unknown>[];
  faceIdentityExclusions: Record<string, unknown>[];
  faceIdentityMembers: Record<string, unknown>[];
  faceModelKind: string | null;
  faceProcessedPhotoIds: number[];
  faceReviewDecisions: Record<string, unknown>[];
  faceVectors: Record<string, unknown>[];
  format: "ai-image-manager.face-backup";
  version: 1;
}

const FACE_BACKUP_FORMAT = "ai-image-manager.face-backup" as const;
const FACE_BACKUP_VERSION = 1 as const;

function addFaceBackupChecksum(
  payload: Omit<FaceDataBackupPayload, "checksum">
): FaceDataBackupPayload {
  const checksum = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex");
  return { ...payload, checksum };
}

function validateFaceBackupPayload(payload: FaceDataBackupPayload): void {
  const dimensions = new Set<number>();
  const collect = (value: unknown, field: string) => {
    if (value === null) {
      return;
    }
    if (typeof value !== "string") {
      throw new Error(`${field} must be a JSON string or null`);
    }
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length === 0 ||
      parsed.some(
        (component) =>
          typeof component !== "number" || !Number.isFinite(component)
      )
    ) {
      throw new Error(`${field} must contain finite numeric values`);
    }
    dimensions.add(parsed.length);
  };

  for (const row of payload.faceVectors) {
    collect(row.embedding, "face vector embedding");
  }
  for (const row of payload.faceIdentities) {
    collect(row.centroid_embedding, "face identity centroid");
  }
  if (dimensions.size > 1) {
    throw new Error("Face backup contains mixed embedding dimensions");
  }
  let expected: number | null = null;
  if (payload.faceModelKind === "yunet-sface") {
    expected = 128;
  } else if (payload.faceModelKind === "ultraface-w600k") {
    expected = 512;
  }
  if (payload.faceModelKind !== null && expected === null) {
    throw new Error(`Unsupported face model kind: ${payload.faceModelKind}`);
  }
  if (expected !== null && dimensions.size > 0 && !dimensions.has(expected)) {
    throw new Error(
      `Face backup embedding dimension does not match ${payload.faceModelKind}`
    );
  }
}

function writeBackupAtomically(
  backupFile: string,
  payload: FaceDataBackupPayload
): void {
  const temporaryFile = `${backupFile}.tmp-${process.pid}-${Math.random()
    .toString(16)
    .slice(2)}`;
  try {
    fs.writeFileSync(temporaryFile, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(temporaryFile, backupFile);
  } catch (error) {
    try {
      if (fs.existsSync(temporaryFile)) {
        fs.unlinkSync(temporaryFile);
      }
    } catch {
      /* Preserve the original backup error. */
    }
    throw error;
  }
}

/**
 * Create the same face-data backup format as scripts/backup-face-data.mjs.
 * This uses the application's open database connection and is safe to invoke
 * from the reset UI while the application is running.
 */
export function backupFaceData(): string {
  const db = getDatabase();
  const timestamp = Date.now();
  const backupDir = path.join(getDataPath(), "data", "backups");
  const backupFile = path.join(backupDir, `face-backup-${timestamp}.json`);

  const payload = addFaceBackupChecksum({
    format: FACE_BACKUP_FORMAT,
    version: FACE_BACKUP_VERSION,
    createdAt: timestamp,
    backupOf: "ai-image-manager.db",
    faceVectors: db
      .select()
      .from(faceVectors)
      .all()
      .map((row) => ({
        id: row.id,
        photo_id: row.photoId,
        face_index: row.faceIndex,
        bbox_x: row.bboxX,
        bbox_y: row.bboxY,
        bbox_width: row.bboxWidth,
        bbox_height: row.bboxHeight,
        confidence: row.confidence,
        embedding: row.embedding,
        vector_id: row.vectorId,
        is_rejected: row.isRejected,
        created_at: row.createdAt,
      })),
    faceIdentities: db
      .select()
      .from(faceIdentities)
      .all()
      .map((row) => ({
        id: row.id,
        name: row.name,
        representative_photo_id: row.representativePhotoId,
        representative_vector_id: row.representativeVectorId,
        centroid_embedding: row.centroidEmbedding,
        face_count: row.faceCount,
        is_confirmed: row.isConfirmed,
        is_hidden: row.isHidden,
        created_at: row.createdAt,
      })),
    faceIdentityExclusions: db
      .select()
      .from(faceIdentityExclusions)
      .all()
      .map((row) => ({
        id: row.id,
        identity_id: row.identityId,
        face_vector_id: row.faceVectorId,
        created_at: row.createdAt,
      })),
    faceIdentityMembers: db
      .select()
      .from(faceIdentityMembers)
      .all()
      .map((row) => ({
        id: row.id,
        identity_id: row.identityId,
        face_vector_id: row.faceVectorId,
      })),
    faceReviewDecisions: db
      .select()
      .from(faceReviewDecisions)
      .all()
      .map((row) => ({
        id: row.id,
        photo_id: row.photoId,
        face_index: row.faceIndex,
        decision: row.decision,
        source_identity_id: row.sourceIdentityId,
        source_identity_name: row.sourceIdentityName,
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      })),
    faceProcessedPhotoIds: db
      .select({ id: photos.id })
      .from(photos)
      .where(eq(photos.isFaceProcessed, true))
      .all()
      .map((row) => row.id),
    faceModelKind: getSetting("face.model.kind"),
  });

  validateFaceBackupPayload(payload);
  fs.mkdirSync(backupDir, { recursive: true });
  writeBackupAtomically(backupFile, payload);
  console.log(`[FaceDetector] Face data backup created: ${backupFile}`);
  return backupFile;
}

/**
 * Wipe all face data and reset processing flags in one transaction, then record
 * the active model kind so future runs know which vectors belong to it.
 *
 * Model vectors from different kinds live in different metric spaces and cannot
 * be compared, so this is a destructive full reset. Call ONLY after a backup has
 * been taken (scripts/backup-face-data.mjs); rollback is possible via
 * scripts/restore-face-data.mjs.
 */
export function resetFaceDataForModelSwitch(): void {
  if (isFaceDetectionRunning()) {
    throw new Error(
      "Face detection is running; cancel it before resetting face data"
    );
  }

  backupFaceData();
  const activeModelKind = getActiveFaceModel().kind;
  const db = getDatabase();
  db.transaction((tx) => {
    tx.delete(faceReviewDecisions).run();
    tx.delete(faceIdentityMembers).run();
    tx.delete(faceIdentities).run();
    tx.delete(faceVectors).run();
    tx.update(photos)
      .set({ isFaceProcessed: false })
      .where(isNull(photos.deletedAt))
      .run();
    tx.insert(appSettings)
      .values({
        key: "face.model.kind",
        value: activeModelKind,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({
        target: appSettings.key,
        set: { value: activeModelKind, updatedAt: Date.now() },
      })
      .run();
  });
}

function findModelsDir(): string {
  // Models are copied from bundled resources to user data directory
  // by ensureModelAvailable() at startup.
  return path.join(getDataPath(), "models");
}

function ensureFaceModels(): boolean {
  const faceDir = path.join(findModelsDir(), "face");
  if (!fs.existsSync(faceDir)) {
    fs.mkdirSync(faceDir, { recursive: true });
  }

  let allPresent = true;
  for (const filename of getActiveFaceModel().modelFiles) {
    if (!fs.existsSync(path.join(faceDir, filename))) {
      allPresent = false;
      break;
    }
  }

  if (!allPresent) {
    console.log("[FaceDetector] Face models not found");
  }
  return allPresent;
}

interface FaceResult {
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding?: number[] | null;
  faceIndex: number;
}

export interface FaceDetectionResult {
  error?: string;
  faces: FaceResult[];
  id: number;
}

export interface DetectionProgress {
  facesDetected?: number;
  failedPhotos?: number;
  invalidFaces?: number;
  phase: "idle" | "running" | "complete";
  processed: number;
  total: number;
}

let currentProgress: DetectionProgress = {
  processed: 0,
  total: 0,
  phase: "idle",
};

export function getFaceDetectionProgress(): DetectionProgress {
  return { ...currentProgress };
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-8);
}

function applyStableReviewDecision(
  faceVectorId: number,
  photoId: number,
  faceIndex: number
): void {
  const db = getDatabase();
  const decision = db
    .select()
    .from(faceReviewDecisions)
    .where(
      and(
        eq(faceReviewDecisions.photoId, photoId),
        eq(faceReviewDecisions.faceIndex, faceIndex)
      )
    )
    .get();
  if (!decision) {
    return;
  }

  if (decision.decision === "rejected") {
    db.update(faceVectors)
      .set({ isRejected: true })
      .where(eq(faceVectors.id, faceVectorId))
      .run();
    return;
  }

  if (decision.decision === "removed_from_identity") {
    db.delete(faceIdentityExclusions)
      .where(
        and(
          eq(
            faceIdentityExclusions.identityId,
            decision.sourceIdentityId ?? -1
          ),
          eq(faceIdentityExclusions.faceVectorId, faceVectorId)
        )
      )
      .run();
    if (decision.sourceIdentityId !== null) {
      db.insert(faceIdentityExclusions)
        .values({
          identityId: decision.sourceIdentityId,
          faceVectorId,
        })
        .onConflictDoNothing()
        .run();
    }
  }
}

function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) {
    return [];
  }
  const dim = embeddings[0].length;
  const centroid = new Array(dim).fill(0);
  for (const emb of embeddings) {
    for (let i = 0; i < dim; i++) {
      centroid[i] += emb[i];
    }
  }
  const norm = Math.sqrt(centroid.reduce((s, v) => s + v * v, 0));
  return centroid.map((v) => v / (norm || 1));
}

function assignToIdentity(
  embedding: number[],
  identityCentroids: Array<{ id: number; centroid: number[] }>,
  excludedIdentityIds?: ReadonlySet<number>
): { identityId: number; similarity: number } | null {
  let bestId = -1;
  let bestSim = -1;

  for (const { id, centroid } of identityCentroids) {
    if (excludedIdentityIds?.has(id)) {
      continue;
    }
    if (centroid.length === 0) {
      continue;
    }
    const sim = cosineSimilarity(embedding, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = id;
    }
  }

  if (bestId >= 0 && bestSim >= getActiveFaceModel().clustering.threshold) {
    return { identityId: bestId, similarity: bestSim };
  }
  return null;
}

export interface FaceEmbeddingFilterResult {
  invalidFaces: number;
  results: FaceDetectionResult[];
}

/** Keep one malformed face local to its photo instead of aborting the batch. */
export function filterValidFaceEmbeddings(
  results: FaceDetectionResult[],
  expectedDimensions: number
): FaceEmbeddingFilterResult {
  let invalidFaces = 0;
  const filteredResults = results.map((result) => ({
    ...result,
    faces: result.faces.filter((face) => {
      const embedding = face.embedding;
      const valid =
        Array.isArray(embedding) &&
        embedding.length === expectedDimensions &&
        embedding.every((value) => Number.isFinite(value));
      if (!valid) {
        invalidFaces++;
        const actualDimensions = Array.isArray(embedding)
          ? embedding.length
          : "missing";
        console.warn(
          `[FaceDetector] Skipping invalid embedding for photo ${result.id}, face ${face.faceIndex}: got ${actualDimensions}, expected ${expectedDimensions}`
        );
      }
      return valid;
    }),
  }));
  return { invalidFaces, results: filteredResults };
}

/** Only fully successful photos are safe to replace in persistent storage. */
export function selectReplaceableFaceResults(
  originalResults: FaceDetectionResult[],
  filteredResults: FaceDetectionResult[]
): FaceDetectionResult[] {
  const originalById = new Map(
    originalResults.map((result) => [result.id, result])
  );
  return filteredResults.filter((result) => {
    const original = originalById.get(result.id);
    return (
      original !== undefined &&
      !original.error &&
      original.faces.length === result.faces.length
    );
  });
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Detection coordinates worker lifecycle, batch writes, progress, and clustering as one operation.
export async function detectFaces(
  photoIds: number[],
  onProgress?: (progress: DetectionProgress) => void
): Promise<number> {
  if (detectionRunning) {
    return 0;
  }
  if (isFaceModelMismatch()) {
    throw new Error(
      "Face model is incompatible with stored vectors; reset face data first"
    );
  }
  detectionRunning = true;
  const activeModel = getActiveFaceModel();

  const pushProgress = (p: DetectionProgress) => {
    currentProgress = p;
    onProgress?.(p);
  };

  let totalFaces = 0;
  let invalidFaces = 0;
  let failedPhotos = 0;
  let processedPhotos = 0;

  try {
    const modelsReady = ensureFaceModels();
    if (!modelsReady) {
      console.error("[FaceDetector] Models not available, aborting");
      pushProgress({ processed: 0, total: 0, phase: "idle" });
      return 0;
    }

    // Only mark the model after its files are available and the run has
    // successfully started. This marker guards later incremental runs.
    setSetting("face.model.kind", activeModel.kind);

    const db = getDatabase();

    // Skip photos that are already face-processed
    const photoRows: Array<{ id: number; path: string }> = [];
    for (let index = 0; index < photoIds.length; index += 500) {
      photoRows.push(
        ...db
          .select({ id: photos.id, path: photos.path })
          .from(photos)
          .where(
            and(
              inArray(photos.id, photoIds.slice(index, index + 500)),
              eq(photos.isFaceProcessed, false),
              isNull(photos.deletedAt)
            )
          )
          .all()
      );
    }

    if (!photoRows.length) {
      // Still need to cluster any unassigned faces
      clusterUnassignedFaces();
      setSetting("face.model.kind", activeModel.kind);
      pushProgress({
        processed: 0,
        total: 0,
        phase: "complete",
        facesDetected: 0,
      });
      return 0;
    }

    pushProgress({
      processed: 0,
      total: photoRows.length,
      phase: "running",
      facesDetected: 0,
      invalidFaces: 0,
      failedPhotos: 0,
    });

    // Start persistent face-worker pool (GPU context reused across batches)
    const modelsDir = findModelsDir();
    const useGPU = getSetting("gpu.enabled") === "true";

    // Poll pool init progress during worker startup so UI knows the model
    // is loading (DirectML GPU warm-up can take 5-30s on first run).
    const poolInitInterval = setInterval(() => {
      const pct = getFacePoolInitProgress();
      if (pct > 0 && pct < 100) {
        pushProgress({
          processed: 0,
          total: photoRows.length,
          phase: "running",
          facesDetected: totalFaces,
          invalidFaces,
          failedPhotos,
        });
      }
    }, 500);
    try {
      await initFaceWorkerPool(modelsDir, useGPU);
    } finally {
      clearInterval(poolInitInterval);
    }

    try {
      const poolResults = await detectFacesWithPool(
        photoRows,
        BATCH_SIZE,
        (processed, total) => {
          pushProgress({
            processed,
            total,
            phase: "running",
            facesDetected: totalFaces,
            invalidFaces,
            failedPhotos,
          });
        },
        () => !detectionRunning
      );

      const filtered = filterValidFaceEmbeddings(
        poolResults,
        activeModel.recognition.vectorDimensions
      );
      invalidFaces = filtered.invalidFaces;
      failedPhotos = poolResults.filter((result) => result.error).length;

      const poolResultById = new Map(
        poolResults.map((result) => [result.id, result])
      );
      const successfulResults = selectReplaceableFaceResults(
        poolResults,
        filtered.results
      );
      const invalidResultIds = new Set(
        filtered.results
          .filter((result) => {
            const original = poolResultById.get(result.id);
            return Boolean(
              original && original.faces.length !== result.faces.length
            );
          })
          .map((result) => result.id)
      );

      for (const result of poolResults) {
        db.update(photos)
          .set({
            faceProcessingError:
              result.error ??
              (invalidResultIds.has(result.id)
                ? "invalid face embedding"
                : null),
          })
          .where(eq(photos.id, result.id))
          .run();
      }

      // Replace only non-confirmed vectors before writing the fresh detection
      // result. Confirmed memberships remain stable while retries cannot leave
      // stale faces behind when a previous worker run failed halfway through.
      for (const photo of successfulResults) {
        const confirmedVectorIds = db
          .select({ id: faceVectors.id })
          .from(faceVectors)
          .innerJoin(
            faceIdentityMembers,
            eq(faceIdentityMembers.faceVectorId, faceVectors.id)
          )
          .innerJoin(
            faceIdentities,
            eq(faceIdentities.id, faceIdentityMembers.identityId)
          )
          .where(
            and(
              eq(faceVectors.photoId, photo.id),
              eq(faceIdentities.isConfirmed, true)
            )
          )
          .all()
          .map((row) => row.id);
        const vectorCondition = confirmedVectorIds.length
          ? and(
              eq(faceVectors.photoId, photo.id),
              notInArray(faceVectors.id, confirmedVectorIds)
            )
          : eq(faceVectors.photoId, photo.id);
        db.delete(faceVectors).where(vectorCondition).run();
      }

      for (const r of successfulResults) {
        if (!r.faces.length) {
          continue;
        }

        for (const face of r.faces) {
          const inserted = db
            .insert(faceVectors)
            .values({
              photoId: r.id,
              faceIndex: face.faceIndex,
              bboxX: face.bbox.x,
              bboxY: face.bbox.y,
              bboxWidth: face.bbox.width,
              bboxHeight: face.bbox.height,
              confidence: face.confidence,
              embedding: face.embedding ? JSON.stringify(face.embedding) : null,
            })
            .onConflictDoNothing()
            .returning({ insertedId: faceVectors.id })
            .get();
          const insertedId = inserted?.insertedId;
          if (insertedId !== undefined) {
            applyStableReviewDecision(insertedId, r.id, face.faceIndex);
            totalFaces++;
          }
        }
      }

      // Mark all processed photos as face-processed
      const processedIds = successfulResults.map((r) => r.id);
      processedPhotos = processedIds.length;
      // Batch the UPDATE: split into chunks to avoid SQLite variable limit
      for (let i = 0; i < processedIds.length; i += BATCH_SIZE) {
        const chunk = processedIds.slice(i, i + BATCH_SIZE);
        db.update(photos)
          .set({ faceProcessingError: null, isFaceProcessed: true })
          .where(inArray(photos.id, chunk))
          .run();
      }
    } finally {
      shutdownFacePool();
    }

    // --- Clustering: assign faces to identities ---
    clusterUnassignedFaces();
    setSetting("face.model.kind", activeModel.kind);

    pushProgress({
      processed: processedPhotos,
      total: photoRows.length,
      phase: "complete",
      facesDetected: totalFaces,
      invalidFaces,
      failedPhotos,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[FaceDetector] Fatal error: ${message}`);
    pushProgress({ processed: 0, total: 0, phase: "idle" });
    throw err;
  } finally {
    detectionRunning = false;
  }

  return totalFaces;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Face clustering keeps identity assignment and centroid updates consistent within one pass.
function clusterUnassignedFaces(): void {
  const db = getDatabase();

  const existingIdentities = db
    .select({
      id: faceIdentities.id,
      centroidEmbedding: faceIdentities.centroidEmbedding,
    })
    .from(faceIdentities)
    .all();

  const identityCentroids: Array<{ id: number; centroid: number[] }> = [];
  for (const identity of existingIdentities) {
    if (identity.centroidEmbedding) {
      try {
        identityCentroids.push({
          id: identity.id,
          centroid: JSON.parse(identity.centroidEmbedding),
        });
      } catch {
        /* skip malformed */
      }
    }
  }

  const unassignedFaces = db
    .select({
      id: faceVectors.id,
      faceIndex: faceVectors.faceIndex,
      photoId: faceVectors.photoId,
      embedding: faceVectors.embedding,
    })
    .from(faceVectors)
    .leftJoin(
      faceIdentityMembers,
      eq(faceVectors.id, faceIdentityMembers.faceVectorId)
    )
    .where(
      and(
        isNull(faceIdentityMembers.id),
        eq(faceVectors.isRejected, false),
        // Filter out low-confidence detections, but keep null (legacy data)
        sql`(${faceVectors.confidence} IS NULL OR ${faceVectors.confidence} >= ${getActiveFaceModel().clustering.confidenceFilter})`
      )
    )
    .all();

  const exclusionRows = db
    .select({
      identityId: faceIdentityExclusions.identityId,
      faceVectorId: faceIdentityExclusions.faceVectorId,
    })
    .from(faceIdentityExclusions)
    .all();
  const exclusionsByFace = new Map<number, Set<number>>();
  for (const exclusion of exclusionRows) {
    const identities =
      exclusionsByFace.get(exclusion.faceVectorId) ?? new Set<number>();
    identities.add(exclusion.identityId);
    exclusionsByFace.set(exclusion.faceVectorId, identities);
  }

  const reviewRows = db
    .select({
      decision: faceReviewDecisions.decision,
      faceIndex: faceReviewDecisions.faceIndex,
      photoId: faceReviewDecisions.photoId,
      sourceIdentityId: faceReviewDecisions.sourceIdentityId,
    })
    .from(faceReviewDecisions)
    .all();
  const reviewByFace = new Map<string, (typeof reviewRows)[number]>();
  for (const review of reviewRows) {
    reviewByFace.set(`${review.photoId}:${review.faceIndex}`, review);
  }

  for (const face of unassignedFaces) {
    const review = reviewByFace.get(`${face.photoId}:${face.faceIndex}`);
    if (
      review?.decision === "rejected" ||
      review?.decision === "removed_from_identity"
    ) {
      continue;
    }
    if (!face.embedding) {
      // No valid embedding — mark as rejected, don't create identity
      db.update(faceVectors)
        .set({ isRejected: true })
        .where(eq(faceVectors.id, face.id))
        .run();
      continue;
    }

    let embedding: number[];
    try {
      embedding = JSON.parse(face.embedding);
    } catch {
      continue;
    }

    // Try to match to existing identity
    const match = assignToIdentity(
      embedding,
      identityCentroids,
      exclusionsByFace.get(face.id)
    );

    if (match) {
      db.insert(faceIdentityMembers)
        .values({ identityId: match.identityId, faceVectorId: face.id })
        .onConflictDoNothing()
        .run();

      // If the identity's representative photo was deleted (e.g. folder removed),
      // restore it with this newly matched face's photo.
      const cur = db
        .select({ representativePhotoId: faceIdentities.representativePhotoId })
        .from(faceIdentities)
        .where(eq(faceIdentities.id, match.identityId))
        .get();

      db.update(faceIdentities)
        .set({
          faceCount: sql`(SELECT COUNT(DISTINCT fv.photo_id) FROM face_identity_members fim JOIN face_vectors fv ON fv.id = fim.face_vector_id WHERE fim.identity_id = ${match.identityId})`,
          ...(cur?.representativePhotoId
            ? {}
            : { representativePhotoId: face.photoId }),
        })
        .where(eq(faceIdentities.id, match.identityId))
        .run();

      updateIdentityCentroid(match.identityId);
    } else {
      // Create new identity
      const result = db
        .insert(faceIdentities)
        .values({
          name: null,
          faceCount: 1,
          representativePhotoId: face.photoId,
          centroidEmbedding: face.embedding,
        })
        .returning({ insertedId: faceIdentities.id })
        .get();

      if (result) {
        db.insert(faceIdentityMembers)
          .values({ identityId: result.insertedId, faceVectorId: face.id })
          .onConflictDoNothing()
          .run();

        identityCentroids.push({ id: result.insertedId, centroid: embedding });
      }
    }
  }
}

function updateIdentityCentroid(identityId: number): void {
  const db = getDatabase();

  const members = db
    .select({ embedding: faceVectors.embedding })
    .from(faceIdentityMembers)
    .innerJoin(
      faceVectors,
      eq(faceIdentityMembers.faceVectorId, faceVectors.id)
    )
    .where(eq(faceIdentityMembers.identityId, identityId))
    .all();

  const embeddings: number[][] = [];
  for (const m of members) {
    if (m.embedding) {
      try {
        embeddings.push(JSON.parse(m.embedding));
      } catch {
        /* skip */
      }
    }
  }

  if (embeddings.length > 0) {
    const centroid = computeCentroid(embeddings);
    db.update(faceIdentities)
      .set({ centroidEmbedding: JSON.stringify(centroid) })
      .where(eq(faceIdentities.id, identityId))
      .run();
  } else {
    db.update(faceIdentities)
      .set({ centroidEmbedding: null })
      .where(eq(faceIdentities.id, identityId))
      .run();
  }
}

/** Rebuild denormalized identity fields after scoped face-vector removal. */
export function refreshFaceIdentityMetadata(identityId: number): void {
  const db = getDatabase();
  const identity = db
    .select({ id: faceIdentities.id })
    .from(faceIdentities)
    .where(eq(faceIdentities.id, identityId))
    .get();
  if (!identity) {
    return;
  }

  const members = db
    .select({
      confidence: faceVectors.confidence,
      photoId: faceVectors.photoId,
      vectorId: faceVectors.id,
    })
    .from(faceIdentityMembers)
    .innerJoin(
      faceVectors,
      eq(faceIdentityMembers.faceVectorId, faceVectors.id)
    )
    .where(eq(faceIdentityMembers.identityId, identityId))
    .all();

  if (members.length === 0) {
    db.update(faceIdentities)
      .set({
        centroidEmbedding: null,
        faceCount: 0,
        representativePhotoId: null,
        representativeVectorId: null,
      })
      .where(eq(faceIdentities.id, identityId))
      .run();
    return;
  }

  const representative = [...members].sort(
    (a, b) => (b.confidence ?? 0) - (a.confidence ?? 0)
  )[0];
  db.update(faceIdentities)
    .set({
      faceCount: new Set(members.map((member) => member.photoId)).size,
      representativePhotoId: representative.photoId,
      representativeVectorId: String(representative.vectorId),
    })
    .where(eq(faceIdentities.id, identityId))
    .run();
  updateIdentityCentroid(identityId);
}

export function reclusterAllFaces(): { merged: number } {
  const db = getDatabase();

  // Preserve confirmed identities (manually merged/named by user)
  // Only clear unconfirmed identity assignments
  const confirmedIds = db
    .select({ id: faceIdentities.id })
    .from(faceIdentities)
    .where(eq(faceIdentities.isConfirmed, true))
    .all()
    .map((r) => r.id);

  if (confirmedIds.length > 0) {
    // Delete members of unconfirmed identities only
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
  } else {
    db.delete(faceIdentityMembers).run();
    db.delete(faceIdentities).run();
  }

  // Re-cluster unassigned faces (confirmed members stay intact)
  clusterUnassignedFaces();

  const count = db
    .select({ id: faceIdentities.id })
    .from(faceIdentities)
    .all().length;
  return { merged: count };
}
