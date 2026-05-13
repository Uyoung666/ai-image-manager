import { fork } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import path from "node:path";
import { eq, inArray, isNull, sql } from "drizzle-orm";
import { app } from "electron";
import { getDatabase } from "@/db";
import { faceIdentityMembers, faceIdentities, faceVectors, photos } from "@/db/schema";
import type { ChildProcess } from "node:child_process";

const BATCH_SIZE = 20;
const CLUSTERING_THRESHOLD = 0.55;
let detectionRunning = false;

function findWorkerScript(): string {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "face-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } else {
    const cwd = process.cwd();
    const candidate = path.join(cwd, "scripts", "face-worker.mjs");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const alt = path.join(app.getAppPath(), "scripts", "face-worker.mjs");
    if (fs.existsSync(alt)) {
      return alt;
    }
  }
  throw new Error(
    "Cannot find face-worker.mjs — expected in scripts/ directory"
  );
}

function findModelsDir(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "models");
    if (fs.existsSync(bundled)) return bundled;
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "models");
  if (fs.existsSync(candidate)) return candidate;
  const alt = path.join(app.getAppPath(), "models");
  if (fs.existsSync(alt)) return alt;
  return path.join(cwd, "models");
}

const FACE_MODELS = [
  {
    filename: "ultraface-320.onnx",
    url: "https://github.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/raw/master/models/onnx/version-RFB-320.onnx",
  },
  {
    filename: "w600k_r50.onnx",
    url: "https://hf-mirror.com/public-data/insightface/resolve/main/models/buffalo_l/w600k_r50.onnx",
  },
];

function downloadFile(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    const request = (reqUrl: string) => {
      https.get(reqUrl, (response) => {
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            request(redirectUrl);
            return;
          }
        }
        if (response.statusCode !== 200) {
          file.close();
          fs.unlinkSync(dest);
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }
        response.pipe(file);
        file.on("finish", () => { file.close(); resolve(); });
      }).on("error", (err) => {
        file.close();
        if (fs.existsSync(dest)) fs.unlinkSync(dest);
        reject(err);
      });
    };
    request(url);
  });
}

async function ensureFaceModels(): Promise<boolean> {
  const modelsDir = findModelsDir();
  const faceDir = path.join(modelsDir, "face");
  if (!fs.existsSync(faceDir)) {
    fs.mkdirSync(faceDir, { recursive: true });
  }

  let needsDownload = false;
  for (const model of FACE_MODELS) {
    if (!fs.existsSync(path.join(faceDir, model.filename))) {
      needsDownload = true;
      break;
    }
  }
  if (!needsDownload) return true;

  console.log("[FaceDetector] Downloading face models...");
  for (const model of FACE_MODELS) {
    const dest = path.join(faceDir, model.filename);
    if (fs.existsSync(dest)) continue;
    try {
      console.log(`[FaceDetector] Downloading ${model.filename}...`);
      await downloadFile(model.url, dest);
      console.log(`[FaceDetector] Downloaded ${model.filename}`);
    } catch (err: any) {
      console.error(`[FaceDetector] Failed to download ${model.filename}: ${err.message}`);
      if (model.filename === "ultraface-320.onnx") return false;
    }
  }
  return true;
}

interface FaceResult {
  faceIndex: number;
  bbox: { x: number; y: number; width: number; height: number };
  confidence: number;
  embedding: number[] | null;
}

interface FaceDetectionResult {
  id: number;
  faces: FaceResult[];
}

export interface DetectionProgress {
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
    const workerPath = findWorkerScript();
    const modelsDir = findModelsDir();
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
        const msg = data.toString().trim();
        if (msg) console.log(`[FaceWorker] ${msg}`);
      });
    }

    worker.send({ type: "detect", photos: photoBatch, modelsDir });
  });
}

function cosineSimilarity(a: number[], b: number[]): number {
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

function computeCentroid(embeddings: number[][]): number[] {
  if (embeddings.length === 0) return [];
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
  identityCentroids: Array<{ id: number; centroid: number[] }>
): { identityId: number; similarity: number } | null {
  let bestId = -1;
  let bestSim = -1;

  for (const { id, centroid } of identityCentroids) {
    if (centroid.length === 0) continue;
    const sim = cosineSimilarity(embedding, centroid);
    if (sim > bestSim) {
      bestSim = sim;
      bestId = id;
    }
  }

  if (bestId >= 0 && bestSim >= CLUSTERING_THRESHOLD) {
    return { identityId: bestId, similarity: bestSim };
  }
  return null;
}

export async function detectFaces(photoIds: number[]): Promise<number> {
  if (detectionRunning) return 0;
  detectionRunning = true;

  const modelsReady = await ensureFaceModels();
  if (!modelsReady) {
    console.error("[FaceDetector] Models not available, aborting");
    detectionRunning = false;
    return 0;
  }

  const db = getDatabase();
  let totalFaces = 0;

  try {
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
                  confidence: face.confidence,
                  embedding: face.embedding ? JSON.stringify(face.embedding) : null,
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

    // --- Clustering: assign faces to identities ---
    await clusterUnassignedFaces();

    currentProgress.phase = "complete";
  } catch (err: any) {
    console.error(`[FaceDetector] Fatal error: ${err.message}`);
    currentProgress.phase = "idle";
  } finally {
    detectionRunning = false;
  }

  return totalFaces;
}

async function clusterUnassignedFaces(): Promise<void> {
  const db = getDatabase();

  // Load all existing identity centroids
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
      } catch { /* skip malformed */ }
    }
  }

  // Find unassigned faces
  const unassignedFaces = db
    .select({
      id: faceVectors.id,
      photoId: faceVectors.photoId,
      embedding: faceVectors.embedding,
    })
    .from(faceVectors)
    .leftJoin(
      faceIdentityMembers,
      eq(faceVectors.id, faceIdentityMembers.faceVectorId)
    )
    .where(isNull(faceIdentityMembers.id))
    .all();

  for (const face of unassignedFaces) {
    if (!face.embedding) {
      // No embedding — create standalone identity (legacy behavior)
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
          .values({ identityId: result.insertedId, faceVectorId: face.id })
          .onConflictDoNothing()
          .run();
      }
      continue;
    }

    let embedding: number[];
    try {
      embedding = JSON.parse(face.embedding);
    } catch {
      continue;
    }

    // Try to match to existing identity
    const match = assignToIdentity(embedding, identityCentroids);

    if (match) {
      // Assign to existing identity
      db.insert(faceIdentityMembers)
        .values({ identityId: match.identityId, faceVectorId: face.id })
        .onConflictDoNothing()
        .run();

      // Update face count
      db.update(faceIdentities)
        .set({
          faceCount: sql`(SELECT COUNT(*) FROM face_identity_members WHERE identity_id = ${match.identityId})`,
        })
        .where(eq(faceIdentities.id, match.identityId))
        .run();

      // Update centroid with new face included
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
    .innerJoin(faceVectors, eq(faceIdentityMembers.faceVectorId, faceVectors.id))
    .where(eq(faceIdentityMembers.identityId, identityId))
    .all();

  const embeddings: number[][] = [];
  for (const m of members) {
    if (m.embedding) {
      try {
        embeddings.push(JSON.parse(m.embedding));
      } catch { /* skip */ }
    }
  }

  if (embeddings.length > 0) {
    const centroid = computeCentroid(embeddings);
    db.update(faceIdentities)
      .set({ centroidEmbedding: JSON.stringify(centroid) })
      .where(eq(faceIdentities.id, identityId))
      .run();
  }
}

export async function reclusterAllFaces(): Promise<{ merged: number }> {
  const db = getDatabase();

  // Clear all identity assignments
  db.delete(faceIdentityMembers).run();
  db.delete(faceIdentities).run();

  // Re-cluster from scratch
  await clusterUnassignedFaces();

  const count = db.select({ id: faceIdentities.id }).from(faceIdentities).all().length;
  return { merged: count };
}

