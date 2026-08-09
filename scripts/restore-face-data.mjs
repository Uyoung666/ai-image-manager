#!/usr/bin/env node
/**
 * Restore a validated face backup without touching the database until every
 * payload, model-dimension, and foreign-key reference check has passed.
 *
 * Usage:
 *   node scripts/restore-face-data.mjs <dbPath> <backupFile>
 *   node scripts/restore-face-data.mjs <dbPath> <backupFile> --legacy-kind ultraface-w600k
 *
 * The app must NOT be running while restoring.
 * After a legacy restore, running that old model also requires the explicit
 * FACE_MODEL_ALLOW_RESEARCH_ONLY=1 runtime opt-in.
 */
import fs from "node:fs";
import path from "node:path";
import sqlite from "node:sqlite";
import { fileURLToPath } from "node:url";
import {
  readFaceBackup,
  validateFaceBackupPayload,
} from "./backup-face-data.mjs";

const { DatabaseSync } = sqlite;

const FACE_TABLES = [
  "face_vectors",
  "face_identities",
  "face_identity_members",
  "photos",
  "app_settings",
];

function assertRequiredTables(db) {
  const existing = new Set(
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?, ?, ?)"
      )
      .all(...FACE_TABLES)
      .map((row) => row.name)
  );
  const missing = FACE_TABLES.filter((table) => !existing.has(table));
  if (missing.length) {
    throw new Error(
      `Database is missing required tables: ${missing.join(", ")}`
    );
  }
}

function hasTable(db, name) {
  return Boolean(
    db
      .prepare(
        "SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?"
      )
      .get(name)
  );
}

function hasColumn(db, table, column) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
}

function validateRepresentativeReferences(payload, vectorIds, photoIds) {
  for (const identity of payload.faceIdentities) {
    if (
      identity.representative_photo_id !== null &&
      !photoIds.has(identity.representative_photo_id)
    ) {
      throw new Error(
        `identity ${identity.id} references missing representative photo ${identity.representative_photo_id}`
      );
    }

    if (identity.representative_vector_id === null) {
      continue;
    }
    const representativeVectorId = Number(identity.representative_vector_id);
    if (
      !Number.isInteger(representativeVectorId) ||
      representativeVectorId <= 0 ||
      !vectorIds.has(representativeVectorId)
    ) {
      throw new Error(
        `identity ${identity.id} references missing representative vector ${identity.representative_vector_id}`
      );
    }

    const representative = payload.faceVectors.find(
      (vector) => vector.id === representativeVectorId
    );
    if (
      identity.representative_photo_id !== null &&
      representative.photo_id !== identity.representative_photo_id
    ) {
      throw new Error(
        `identity ${identity.id} representative photo/vector do not match`
      );
    }
  }
}

function validatePayloadAgainstDatabase(db, payload) {
  assertRequiredTables(db);
  const photoIds = new Set(
    db
      .prepare("SELECT id FROM photos")
      .all()
      .map((row) => row.id)
  );
  const result = validateFaceBackupPayload(payload, { photoIds });
  const vectorIds = new Set(payload.faceVectors.map((vector) => vector.id));
  validateRepresentativeReferences(payload, vectorIds, photoIds);
  return result;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: restore is intentionally guarded by validation, transaction, and post-commit checks
export function restoreFaceData(dbPath, backupFile, { legacyKind } = {}) {
  if (!(dbPath && backupFile)) {
    throw new Error(
      "Usage: node scripts/restore-face-data.mjs <dbPath> <backupFile>"
    );
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  if (!fs.existsSync(backupFile)) {
    throw new Error(`Backup file not found: ${backupFile}`);
  }

  // Read and checksum-validate before opening the writable database.
  const payload = readFaceBackup(path.resolve(backupFile), { legacyKind });
  const db = new DatabaseSync(dbPath);
  let inTransaction = false;
  try {
    db.exec("PRAGMA foreign_keys = ON");
    const validation = validatePayloadAgainstDatabase(db, payload);

    // No DELETE happens before all of the checks above have passed.
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;

    db.exec("DELETE FROM face_identity_members");
    const hasExclusionTable = hasTable(db, "face_identity_exclusions");
    const hasHiddenColumn = hasColumn(db, "face_identities", "is_hidden");
    const exclusions = payload.faceIdentityExclusions ?? [];
    if (!hasExclusionTable && exclusions.length > 0) {
      throw new Error(
        "Database is missing face_identity_exclusions required by this backup"
      );
    }
    if (hasExclusionTable) {
      db.exec("DELETE FROM face_identity_exclusions");
    }
    const hasReviewTable = hasTable(db, "face_review_decisions");
    const reviewDecisions = payload.faceReviewDecisions ?? [];
    if (!hasReviewTable && reviewDecisions.length > 0) {
      throw new Error(
        "Database is missing face_review_decisions required by this backup"
      );
    }
    if (hasReviewTable) {
      db.exec("DELETE FROM face_review_decisions");
    }
    db.exec("DELETE FROM face_vectors");
    db.exec("DELETE FROM face_identities");

    const insVector = db.prepare(
      "INSERT INTO face_vectors (id, photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, vector_id, is_rejected, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of payload.faceVectors) {
      insVector.run(
        row.id,
        row.photo_id,
        row.face_index,
        row.bbox_x,
        row.bbox_y,
        row.bbox_width,
        row.bbox_height,
        row.confidence,
        row.embedding,
        row.vector_id,
        row.is_rejected,
        row.created_at
      );
    }

    const insIdentity = db.prepare(
      hasHiddenColumn
        ? "INSERT INTO face_identities (id, name, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, is_hidden, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
        : "INSERT INTO face_identities (id, name, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const row of payload.faceIdentities) {
      if (hasHiddenColumn) {
        insIdentity.run(
          row.id,
          row.name,
          row.representative_photo_id,
          row.representative_vector_id,
          row.centroid_embedding,
          row.face_count,
          row.is_confirmed,
          row.is_hidden ?? 0,
          row.created_at
        );
      } else {
        insIdentity.run(
          row.id,
          row.name,
          row.representative_photo_id,
          row.representative_vector_id,
          row.centroid_embedding,
          row.face_count,
          row.is_confirmed,
          row.created_at
        );
      }
    }

    const insMember = db.prepare(
      "INSERT INTO face_identity_members (id, identity_id, face_vector_id) VALUES (?, ?, ?)"
    );
    for (const row of payload.faceIdentityMembers) {
      insMember.run(row.id, row.identity_id, row.face_vector_id);
    }

    if (hasExclusionTable) {
      const insExclusion = db.prepare(
        "INSERT INTO face_identity_exclusions (id, identity_id, face_vector_id, created_at) VALUES (?, ?, ?, ?)"
      );
      for (const row of exclusions) {
        insExclusion.run(
          row.id,
          row.identity_id,
          row.face_vector_id,
          row.created_at
        );
      }
    }

    if (hasReviewTable) {
      const insReview = db.prepare(
        "INSERT INTO face_review_decisions (id, photo_id, face_index, decision, source_identity_id, source_identity_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      );
      for (const row of reviewDecisions) {
        insReview.run(
          row.id,
          row.photo_id,
          row.face_index,
          row.decision,
          row.source_identity_id ?? null,
          row.source_identity_name ?? null,
          row.created_at,
          row.updated_at
        );
      }
    }

    const updateFlag = db.prepare(
      "UPDATE photos SET is_face_processed = ? WHERE id = ?"
    );
    const processed = new Set(payload.faceProcessedPhotoIds);
    for (const row of db
      .prepare("SELECT id, is_face_processed FROM photos")
      .all()) {
      const wanted = processed.has(row.id) ? 1 : 0;
      if ((row.is_face_processed ? 1 : 0) !== wanted) {
        updateFlag.run(wanted, row.id);
      }
    }

    db.prepare("DELETE FROM app_settings WHERE key = 'face.model.kind'").run();
    if (payload.faceModelKind !== null) {
      db.prepare(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('face.model.kind', ?, ?)"
      ).run(payload.faceModelKind, Date.now());
    }

    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
    if (foreignKeyViolations.length) {
      throw new Error(
        `foreign-key check failed with ${foreignKeyViolations.length} violation(s)`
      );
    }
    const actualVectors = db
      .prepare("SELECT count(*) AS count FROM face_vectors")
      .get().count;
    const actualIdentities = db
      .prepare("SELECT count(*) AS count FROM face_identities")
      .get().count;
    const actualMembers = db
      .prepare("SELECT count(*) AS count FROM face_identity_members")
      .get().count;
    if (
      actualVectors !== payload.faceVectors.length ||
      actualIdentities !== payload.faceIdentities.length ||
      actualMembers !== payload.faceIdentityMembers.length
    ) {
      throw new Error("post-restore row-count verification failed");
    }

    db.exec("COMMIT");
    inTransaction = false;
    console.log("Restore complete (committed).");
    console.log(`  embedding dimension: ${validation.dimension ?? "none"}`);
    console.log(`  face.model.kind: ${payload.faceModelKind ?? "(unset)"}`);
    console.log(`  checksum: ${payload.checksum}`);
    return validation;
  } catch (error) {
    if (inTransaction) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Preserve the original failure.
      }
    }
    throw new Error(`Restore failed, rolled back: ${error.message}`, {
      cause: error,
    });
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const [dbPath, backupFile, legacyFlag, legacyKind] = process.argv.slice(2);
  try {
    if (legacyFlag !== undefined && legacyFlag !== "--legacy-kind") {
      throw new Error(
        "Usage: node scripts/restore-face-data.mjs <dbPath> <backupFile> [--legacy-kind ultraface-w600k]"
      );
    }
    restoreFaceData(dbPath, backupFile, { legacyKind });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
