#!/usr/bin/env node
import { fork } from "node:child_process";
/**
 * Migrate face data to a face model kind.
 *
 * Usage:
 *   node scripts/migrate-face-data.mjs <dbPath> [kind] [limit]
 *
 * Without `limit`, this performs the real full migration.  With `limit`, it
 * performs a read-only preview: it detects only the first N photos, reports
 * the result, and does not write the database, create a backup, or change any
 * face rows/settings.  This makes small-scope checks safe to repeat.
 *
 * The full migration keeps one SQLite write transaction open from the wipe
 * until every detection result, cluster, flag, and model setting is written.
 * Any failure rolls that transaction back, so an empty face database cannot be
 * left behind by a failed worker or failed insert.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  createFaceBackupPayload,
  FACE_MODEL_DIMENSIONS,
  writeFaceBackup,
} from "./backup-face-data.mjs";

const CONFIGS = {
  "yunet-sface": {
    clusteringThreshold: 0.363,
    confidenceFilter: 0.5,
  },
};

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const WORKER_FILE = path.join(SCRIPT_DIR, "face-worker.mjs");

const MODEL_FILES = {
  "yunet-sface": [
    "face_detection_yunet_2023mar.onnx",
    "face_recognition_sface_2021dec.onnx",
  ],
};

function usageError() {
  return new Error(
    "Usage: node scripts/migrate-face-data.mjs <dbPath> [kind] [limit]"
  );
}

function parseArguments(args) {
  const [dbPath, kindArg, limitArg] = args;
  if (!dbPath) {
    throw usageError();
  }
  const kind = kindArg || "yunet-sface";
  if (!Object.hasOwn(CONFIGS, kind)) {
    throw new Error(`Unknown kind: ${kind}`);
  }
  if (limitArg === undefined) {
    return { dbPath, kind, limit: null };
  }
  const limit = Number(limitArg);
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new Error(
      "limit must be a positive integer; it enables read-only preview mode"
    );
  }
  return { dbPath, kind, limit };
}

function getPhotos(db) {
  return db
    .prepare("SELECT id, path FROM photos WHERE deleted_at IS NULL ORDER BY id")
    .all()
    .map((row) => ({ id: row.id, path: row.path }));
}

function getUseGpu(db) {
  return (
    db.prepare("SELECT value FROM app_settings WHERE key = 'gpu.enabled'").get()
      ?.value === "true"
  );
}

function assertModelsAvailable(modelsDir, kind) {
  const missing = MODEL_FILES[kind]
    .map((fileName) => path.join(modelsDir, "face", fileName))
    .filter((fileName) => !fs.existsSync(fileName));
  if (missing.length) {
    throw new Error(
      `Required ${kind} model file(s) missing:\n${missing.join("\n")}`
    );
  }
}

function terminateWorker(worker) {
  try {
    if (worker.connected) {
      worker.send({ type: "shutdown" });
    }
  } catch {
    // The worker may already have exited.
  }
  try {
    worker.kill();
  } catch {
    // The worker may already have exited.
  }
}

function detectPhotos(scope, { kind, useGPU, modelsDir }) {
  return new Promise((resolve, reject) => {
    const worker = fork(WORKER_FILE, [], {
      stdio: ["ignore", "inherit", "inherit", "ipc"],
    });
    const queue = [...scope];
    const results = [];
    let settled = false;
    let ready = false;
    const timeout = setTimeout(() => {
      fail(new Error("face worker timed out after 10 minutes"));
    }, 600_000);

    const cleanup = () => {
      clearTimeout(timeout);
      process.removeListener("SIGINT", onSignal);
      process.removeListener("SIGTERM", onSignal);
      worker.removeListener("error", onWorkerError);
      worker.removeListener("exit", onWorkerExit);
    };
    const succeed = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      terminateWorker(worker);
      resolve(results);
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      terminateWorker(worker);
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const onSignal = () => fail(new Error("migration interrupted"));
    const onWorkerError = (error) => fail(error);
    const onWorkerExit = (code, signal) => {
      if (!settled) {
        fail(
          new Error(
            `face worker exited before migration completed (code=${code}, signal=${signal ?? "none"})`
          )
        );
      }
    };
    const dispatch = () => {
      if (!queue.length) {
        succeed();
        return;
      }
      try {
        worker.send({ type: "detect", photos: queue.splice(0, 40) });
      } catch (error) {
        fail(error);
      }
    };

    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the worker protocol has distinct ready, progress, result, and failure states
    worker.on("message", (message) => {
      if (settled) {
        return;
      }
      if (message.type === "ready") {
        if (message.error) {
          fail(new Error(`face worker init failed: ${message.error}`));
          return;
        }
        ready = true;
        dispatch();
        return;
      }
      if (message.type === "init-progress") {
        console.log(`[migrate] worker init ${message.percent}%`);
        return;
      }
      if (message.type === "result") {
        if (!(ready && Array.isArray(message.results))) {
          fail(new Error("face worker returned an invalid result message"));
          return;
        }
        results.push(...message.results);
        dispatch();
      }
    });
    worker.on("error", onWorkerError);
    worker.on("exit", onWorkerExit);
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);

    try {
      worker.send({ type: "init", modelsDir, useGPU, kind });
    } catch (error) {
      fail(error);
    }
  });
}

function finite(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${field} must be a finite number`);
  }
}

function parseEmbedding(value, field, expectedDimension) {
  if (value == null) {
    return null;
  }
  if (!Array.isArray(value) || value.length !== expectedDimension) {
    throw new Error(
      `${field} must be a ${expectedDimension}-dimensional embedding`
    );
  }
  for (const [index, component] of value.entries()) {
    finite(component, `${field}[${index}]`);
  }
  return value;
}

function validateWorkerResults(results, scope, expectedDimension) {
  const expectedIds = new Set(scope.map((photo) => photo.id));
  const resultIds = new Set();
  for (const result of results) {
    if (!(Number.isInteger(result.id) && expectedIds.has(result.id))) {
      throw new Error(`worker returned an unexpected photo id ${result.id}`);
    }
    if (resultIds.has(result.id)) {
      throw new Error(`worker returned duplicate photo id ${result.id}`);
    }
    resultIds.add(result.id);
    if (!Array.isArray(result.faces)) {
      throw new Error(`worker returned invalid faces for photo ${result.id}`);
    }
    for (const face of result.faces) {
      if (!Number.isInteger(face.faceIndex)) {
        throw new Error(`invalid face index for photo ${result.id}`);
      }
      for (const field of ["x", "y", "width", "height"]) {
        finite(face.bbox?.[field], `photo ${result.id} bbox.${field}`);
      }
      finite(face.confidence, `photo ${result.id} confidence`);
      parseEmbedding(
        face.embedding,
        `photo ${result.id} face ${face.faceIndex} embedding`,
        expectedDimension
      );
    }
  }
  if (resultIds.size !== expectedIds.size) {
    throw new Error(
      `worker returned ${resultIds.size}/${expectedIds.size} photos`
    );
  }
}

function cosineSimilarity(a, b) {
  if (a.length !== b.length) {
    throw new Error(
      `cannot compare ${a.length}-d and ${b.length}-d embeddings`
    );
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let index = 0; index < a.length; index += 1) {
    dot += a[index] * b[index];
    na += a[index] * a[index];
    nb += b[index] * b[index];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) + 1e-8);
}

function l2(vector) {
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return norm > 0 ? vector.map((value) => value / norm) : vector;
}

function computeCentroid(embeddings, expectedDimension) {
  if (!embeddings.length) {
    return [];
  }
  for (const embedding of embeddings) {
    parseEmbedding(embedding, "cluster embedding", expectedDimension);
  }
  const centroid = new Array(expectedDimension).fill(0);
  for (const embedding of embeddings) {
    for (let index = 0; index < expectedDimension; index += 1) {
      centroid[index] += embedding[index];
    }
  }
  return l2(centroid);
}

function clusterUnassigned(db, cfg, expectedDimension) {
  const unassigned = db
    .prepare(
      `SELECT fv.id, fv.photo_id, fv.embedding, fv.confidence
       FROM face_vectors fv
       LEFT JOIN face_identity_members fm ON fm.face_vector_id = fv.id
       WHERE fm.id IS NULL AND fv.is_rejected = 0
         AND (fv.confidence IS NULL OR fv.confidence >= ?)
       ORDER BY fv.id`
    )
    .all(cfg.confidenceFilter);
  const insMember = db.prepare(
    "INSERT INTO face_identity_members (identity_id, face_vector_id) VALUES (?, ?)"
  );
  const insIdentity = db.prepare(
    "INSERT INTO face_identities (name, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, created_at) VALUES (NULL, ?, ?, ?, 1, 0, ?)"
  );
  const updateIdentity = db.prepare(
    "UPDATE face_identities SET centroid_embedding = ?, face_count = ?, representative_photo_id = COALESCE(representative_photo_id, ?), representative_vector_id = COALESCE(representative_vector_id, ?) WHERE id = ?"
  );
  let assigned = 0;
  let created = 0;

  for (const face of unassigned) {
    let embedding;
    try {
      embedding = JSON.parse(face.embedding);
    } catch {
      embedding = null;
    }
    if (
      !parseEmbedding(embedding, `face vector ${face.id}`, expectedDimension)
    ) {
      db.prepare("UPDATE face_vectors SET is_rejected = 1 WHERE id = ?").run(
        face.id
      );
      continue;
    }

    const identities = db
      .prepare(
        "SELECT id, centroid_embedding, representative_photo_id FROM face_identities WHERE centroid_embedding IS NOT NULL"
      )
      .all();
    let bestId = -1;
    let bestSimilarity = -1;
    for (const identity of identities) {
      let centroid;
      try {
        centroid = JSON.parse(identity.centroid_embedding);
      } catch {
        centroid = null;
      }
      if (!centroid) {
        continue;
      }
      parseEmbedding(
        centroid,
        `identity ${identity.id} centroid`,
        expectedDimension
      );
      const similarity = cosineSimilarity(embedding, centroid);
      if (similarity > bestSimilarity) {
        bestSimilarity = similarity;
        bestId = identity.id;
      }
    }

    if (bestId >= 0 && bestSimilarity >= cfg.clusteringThreshold) {
      insMember.run(bestId, face.id);
      assigned += 1;
      const members = db
        .prepare(
          `SELECT fv.embedding FROM face_identity_members fm
           JOIN face_vectors fv ON fv.id = fm.face_vector_id
           WHERE fm.identity_id = ?`
        )
        .all(bestId)
        .map((row) => JSON.parse(row.embedding));
      const centroid = computeCentroid(members, expectedDimension);
      const faceCount = db
        .prepare(
          `SELECT count(DISTINCT fv.photo_id) AS count
           FROM face_identity_members fm
           JOIN face_vectors fv ON fv.id = fm.face_vector_id
           WHERE fm.identity_id = ?`
        )
        .get(bestId).count;
      updateIdentity.run(
        JSON.stringify(centroid),
        faceCount,
        face.photo_id,
        String(face.id),
        bestId
      );
    } else {
      const identity = insIdentity.run(
        face.photo_id,
        String(face.id),
        JSON.stringify(embedding),
        Date.now()
      );
      insMember.run(Number(identity.lastInsertRowid), face.id);
      created += 1;
    }
  }
  console.log(
    `[migrate] Clustering: ${assigned} assigned, ${created} new identities.`
  );
  return { assigned, created };
}

function insertResults(db, results, expectedDimension) {
  const insert = db.prepare(
    "INSERT INTO face_vectors (photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, is_rejected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)"
  );
  let totalFaces = 0;
  const dimensions = new Set();
  for (const result of results) {
    for (const face of result.faces) {
      const embedding = parseEmbedding(
        face.embedding,
        `photo ${result.id} face ${face.faceIndex} embedding`,
        expectedDimension
      );
      if (embedding) {
        dimensions.add(embedding.length);
      }
      insert.run(
        result.id,
        face.faceIndex,
        face.bbox.x,
        face.bbox.y,
        face.bbox.width,
        face.bbox.height,
        face.confidence,
        embedding ? JSON.stringify(embedding) : null,
        Date.now()
      );
      totalFaces += 1;
    }
  }
  console.log(
    `[migrate] Inserted ${totalFaces} face vectors; embedding dims: ${
      [...dimensions].join(", ") || "none"
    }`
  );
  return totalFaces;
}

function updateMigrationState(db, results, kind) {
  const processedIds = results.map((result) => result.id);
  for (let index = 0; index < processedIds.length; index += 500) {
    const chunk = processedIds.slice(index, index + 500);
    const placeholders = chunk.map(() => "?").join(",");
    db.prepare(
      `UPDATE photos SET is_face_processed = 1 WHERE id IN (${placeholders})`
    ).run(...chunk);
  }
  db.prepare("DELETE FROM app_settings WHERE key = 'face.model.kind'").run();
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('face.model.kind', ?, ?)"
  ).run(kind, Date.now());
}

function printPreview(results, scope, kind, limit) {
  const faceCount = results.reduce(
    (sum, result) => sum + result.faces.length,
    0
  );
  const dimensions = new Set(
    results.flatMap((result) =>
      result.faces
        .filter((face) => Array.isArray(face.embedding))
        .map((face) => face.embedding.length)
    )
  );
  console.log(
    "[migrate] Read-only preview complete; database was not modified."
  );
  console.log(`  kind: ${kind}`);
  console.log(`  photos: ${results.length}/${scope.length} (limit=${limit})`);
  console.log(`  faces: ${faceCount}`);
  console.log(`  embedding dims: ${[...dimensions].join(", ") || "none"}`);
}

async function runPreview({ dbPath, kind, limit }) {
  const modelsDir = path.resolve(
    process.env.FACE_MIGRATION_MODELS_DIR || "models"
  );
  assertModelsAvailable(modelsDir, kind);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const photos = getPhotos(db);
    const scope = photos.slice(0, limit);
    const results = await detectPhotos(scope, {
      kind,
      useGPU: getUseGpu(db),
      modelsDir,
    });
    validateWorkerResults(results, scope, FACE_MODEL_DIMENSIONS[kind]);
    printPreview(results, scope, kind, limit);
  } finally {
    db.close();
  }
}

async function runFullMigration({ dbPath, kind }) {
  const modelsDir = path.resolve(
    process.env.FACE_MIGRATION_MODELS_DIR || "models"
  );
  // Fail before creating the backup or opening a writable connection.  The
  // worker historically treated a missing embedding model as optional.
  assertModelsAvailable(modelsDir, kind);

  const backupFile = path.join(
    path.dirname(dbPath),
    "backups",
    `face-backup-${Date.now()}.json`
  );
  fs.mkdirSync(path.dirname(backupFile), { recursive: true });

  // The backup is complete and checksummed before any writable connection is
  // opened.  If this fails, the live database is untouched.
  const backupDb = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const payload = createFaceBackupPayload(backupDb, { backupOf: dbPath });
    writeFaceBackup(backupFile, payload);
    console.log(`[migrate] Backup written: ${backupFile}`);
    console.log(`  checksum: ${payload.checksum}`);
  } finally {
    backupDb.close();
  }

  const db = new DatabaseSync(dbPath);
  let transactionOpen = false;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    // BEGIN IMMEDIATE stays open through worker execution and all writes.
    db.exec("BEGIN IMMEDIATE");
    transactionOpen = true;

    const photos = getPhotos(db);
    const useGPU = getUseGpu(db);
    console.log(
      `[migrate] Detecting ${photos.length}/${photos.length} photos (kind=${kind}, GPU=${useGPU})`
    );

    db.exec("DELETE FROM face_identity_members");
    db.exec("DELETE FROM face_identities");
    db.exec("DELETE FROM face_vectors");
    db.exec("UPDATE photos SET is_face_processed = 0 WHERE deleted_at IS NULL");
    console.log(
      "[migrate] Face data wiped inside the open migration transaction."
    );

    const startedAt = Date.now();
    const results = await detectPhotos(photos, { kind, useGPU, modelsDir });
    validateWorkerResults(results, photos, FACE_MODEL_DIMENSIONS[kind]);
    console.log(
      `[migrate] Detection done in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`
    );
    insertResults(db, results, FACE_MODEL_DIMENSIONS[kind]);
    const cluster = clusterUnassigned(
      db,
      CONFIGS[kind],
      FACE_MODEL_DIMENSIONS[kind]
    );
    updateMigrationState(db, results, kind);

    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length) {
      throw new Error(
        `foreign-key check failed with ${foreignKeyViolations.length} violation(s)`
      );
    }
    const vectorCount = db
      .prepare("SELECT count(*) AS count FROM face_vectors")
      .get().count;
    const identityCount = db
      .prepare("SELECT count(*) AS count FROM face_identities")
      .get().count;
    if (
      vectorCount !==
      results.reduce((sum, result) => sum + result.faces.length, 0)
    ) {
      throw new Error("post-migration face vector count verification failed");
    }

    db.exec("COMMIT");
    transactionOpen = false;
    console.log("\n[migrate] Migration complete:");
    console.log(`  face_vectors: ${vectorCount}`);
    console.log(`  face_identities: ${identityCount}`);
    console.log(`  created identities: ${cluster.created}`);
    console.log(`  face.model.kind: ${kind}`);
    console.log(`  embedding dimension: ${FACE_MODEL_DIMENSIONS[kind]}`);
    console.log(`  backup: ${backupFile}`);
    console.log(
      `  rollback: node scripts/restore-face-data.mjs "${dbPath}" "${backupFile}"`
    );
  } catch (error) {
    if (transactionOpen) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original error; SQLite normally rolls this back on close.
      }
    }
    throw new Error(`Migration failed and was rolled back: ${error.message}`, {
      cause: error,
    });
  } finally {
    db.close();
  }
}

export function runMigration(args) {
  const parsed = parseArguments(args);
  if (!fs.existsSync(parsed.dbPath)) {
    throw new Error(`Database not found: ${parsed.dbPath}`);
  }
  if (parsed.limit !== null) {
    return runPreview(parsed);
  }
  return runFullMigration(parsed);
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  runMigration(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
