import { fork } from "node:child_process";
import path from "node:path";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { faceIdentityMembers, faceIdentities, faceVectors, photos } from "@/db/schema";
import type { ChildProcess } from "node:child_process";

const BATCH_SIZE = 30;
let detectionRunning = false;

interface FaceDetectionResult {
  id: number;
  faces: Array<{
    faceIndex: number;
    bbox: { x: number; y: number; width: number; height: number };
  }>;
}

interface DetectionProgress {
  processed: number;
  total: number;
  phase: "idle" | "running" | "complete";
}

let currentProgress: DetectionProgress = { processed: 0, total: 0, phase: "idle" };

export function getFaceDetectionProgress(): DetectionProgress {
  return { ...currentProgress };
}

export function isFaceDetectionRunning(): boolean {
  return detectionRunning;
}

function runWorker(photoBatch: Array<{ id: number; path: string }>): Promise<FaceDetectionResult[]> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, "..", "..", "scripts", "face-worker.mjs");
    let worker: ChildProcess;

    try {
      worker = fork(workerPath, [], { stdio: ["pipe", "pipe", "pipe", "ipc"] });
    } catch (err: any) {
      reject(new Error(`Failed to fork face-worker: ${err.message}`));
      return;
    }

    worker.on("message", (msg: any) => {
      if (msg.type === "result") {
        resolve(msg.results);
        worker.kill();
      }
    });

    worker.on("error", (err) => {
      reject(err);
      worker.kill();
    });

    worker.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        reject(new Error(`Face-worker exited with code ${code}`));
      }
    });

    if (worker.stderr) {
      worker.stderr.on("data", (data: Buffer) => {
        /* suppress stderr noise from worker */
      });
    }

    worker.send({ type: "detect", photos: photoBatch });
  });
}

export async function detectFaces(photoIds: number[]): Promise<number> {
  if (detectionRunning) return 0;
  detectionRunning = true;

  const db = getDatabase();
  let totalFaces = 0;

  try {
    // Get photo paths for IDs that haven't been processed
    const photoRows = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    if (!photoRows.length) {
      detectionRunning = false;
      return 0;
    }

    currentProgress = { processed: 0, total: photoRows.length, phase: "running" };

    // Process in batches
    for (let i = 0; i < photoRows.length; i += BATCH_SIZE) {
      const batch = photoRows.slice(i, i + BATCH_SIZE);
      try {
        const results = await runWorker(batch);

        for (const r of results) {
          if (!r.faces.length) continue;

          for (const face of r.faces) {
            try {
              db.insert(faceVectors)
                .values({
                  photoId: r.id,
                  faceIndex: face.faceIndex,
                  bboxX: face.bbox.x,
                  bboxY: face.bbox.y,
                  bboxWidth: face.bbox.width,
                  bboxHeight: face.bbox.height,
                })
                .run();
              totalFaces++;
            } catch {
              /* skip duplicates */
            }
          }
        }

        currentProgress.processed = Math.min(i + BATCH_SIZE, photoRows.length);
      } catch (err: any) {
        console.error(`[FaceDetector] Batch failed: ${err.message}`);
        currentProgress.processed = Math.min(i + BATCH_SIZE, photoRows.length);
      }
    }

    // Identity assignment: without face embeddings for similarity-based
    // clustering, the safest default is one identity per unassigned face.
    // Faces from the same photo are likely different people; future ONNX
    // embedding + LanceDB clustering will merge identities properly.
    const unassignedFaces = db
      .select({
        id: faceVectors.id,
        photoId: faceVectors.photoId,
      })
      .from(faceVectors)
      .leftJoin(
        faceIdentityMembers,
        eq(faceVectors.id, faceIdentityMembers.faceVectorId)
      )
      .where(isNull(faceIdentityMembers.id))
      .all();

    for (const face of unassignedFaces) {
      const result = db
        .insert(faceIdentities)
        .values({
          name: null,
          faceCount: 1,
          representativePhotoId: face.photoId,
        })
        .returning({ insertedId: faceIdentities.id })
        .get();

      if (result) {
        db.insert(faceIdentityMembers)
          .values({
            identityId: result.insertedId,
            faceVectorId: face.id,
          })
          .onConflictDoNothing()
          .run();
      }
    }

    currentProgress.phase = "complete";
  } catch (err: any) {
    console.error(`[FaceDetector] Fatal error: ${err.message}`);
    currentProgress.phase = "idle";
  } finally {
    detectionRunning = false;
  }

  return totalFaces;
}
