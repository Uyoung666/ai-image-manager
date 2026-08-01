#!/usr/bin/env node
/**
 * Create a validated backup of the face-related database state.
 *
 * Usage:
 *   node scripts/backup-face-data.mjs <dbPath> [backupFile]
 *
 * The backup format is intentionally self-contained.  The checksum protects
 * against truncated or accidentally edited JSON; it is not a signature.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export const FACE_BACKUP_FORMAT = "ai-image-manager.face-backup";
export const FACE_BACKUP_VERSION = 1;
export const FACE_MODEL_DIMENSIONS = Object.freeze({
  "yunet-sface": 128,
  "ultraface-w600k": 512,
});
export const LEGACY_FACE_BACKUP_KINDS = Object.freeze(["ultraface-w600k"]);

const VECTOR_COLUMNS =
  "id, photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, vector_id, is_rejected, created_at";
const IDENTITY_COLUMNS =
  "id, name, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, created_at";
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const isInteger = (value) => Number.isInteger(value);

function fail(message) {
  throw new Error(`Invalid face backup: ${message}`);
}

function assertInteger(value, field) {
  if (!isInteger(value)) {
    fail(`${field} must be an integer`);
  }
}

function assertNullableFiniteNumber(value, field) {
  if (value !== null && !isFiniteNumber(value)) {
    fail(`${field} must be a finite number or null`);
  }
}

function assertBinaryFlag(value, field) {
  if (value !== 0 && value !== 1 && value !== false && value !== true) {
    fail(`${field} must be 0, 1, false, or true`);
  }
}

function parseEmbedding(value, field, expectedDimension) {
  if (value == null) {
    return null;
  }
  if (typeof value !== "string") {
    fail(`${field} must be a JSON string or null`);
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    fail(`${field} is not valid JSON`);
  }

  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    parsed.some((component) => !isFiniteNumber(component))
  ) {
    fail(`${field} must contain a non-empty finite numeric array`);
  }
  if (expectedDimension != null && parsed.length !== expectedDimension) {
    fail(
      `${field} has dimension ${parsed.length}; expected ${expectedDimension}`
    );
  }
  return parsed;
}

function payloadWithoutChecksum(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be an object");
  }
  const { checksum, ...content } = payload;
  return content;
}

function checksumFor(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(payloadWithoutChecksum(payload)))
    .digest("hex");
}

export function addFaceBackupChecksum(payload) {
  const content = payloadWithoutChecksum(payload);
  return { ...content, checksum: checksumFor(content) };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the validator deliberately checks every field and relationship before restore
export function validateFaceBackupPayload(payload, options = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("payload must be an object");
  }
  if (payload.format !== FACE_BACKUP_FORMAT) {
    fail(`unsupported format ${String(payload.format)}`);
  }
  if (payload.version !== FACE_BACKUP_VERSION) {
    fail(`unsupported version ${String(payload.version)}`);
  }
  if (!isFiniteNumber(payload.createdAt)) {
    fail("createdAt must be a number");
  }
  if (typeof payload.backupOf !== "string" || !payload.backupOf) {
    fail("backupOf must be a non-empty string");
  }
  if (!SHA256_PATTERN.test(payload.checksum ?? "")) {
    fail("checksum must be a SHA-256 hex digest");
  }
  if (checksumFor(payload) !== payload.checksum) {
    fail("checksum mismatch");
  }

  const arrays = [
    "faceVectors",
    "faceIdentities",
    "faceIdentityMembers",
    "faceProcessedPhotoIds",
  ];
  for (const field of arrays) {
    if (!Array.isArray(payload[field])) {
      fail(`${field} must be an array`);
    }
  }

  if (
    payload.faceModelKind !== null &&
    !Object.hasOwn(FACE_MODEL_DIMENSIONS, payload.faceModelKind)
  ) {
    fail(`unsupported faceModelKind ${String(payload.faceModelKind)}`);
  }

  const vectorIds = new Set();
  const identityIds = new Set();
  const memberIds = new Set();
  const referencedPhotoIds = new Set();
  const dimensions = new Set();

  for (const row of payload.faceVectors) {
    assertInteger(row.id, "faceVectors.id");
    if (vectorIds.has(row.id)) {
      fail(`duplicate face vector id ${row.id}`);
    }
    vectorIds.add(row.id);
    assertInteger(row.photo_id, `faceVectors[${row.id}].photo_id`);
    referencedPhotoIds.add(row.photo_id);
    assertInteger(row.face_index, `faceVectors[${row.id}].face_index`);
    for (const field of [
      "bbox_x",
      "bbox_y",
      "bbox_width",
      "bbox_height",
      "confidence",
    ]) {
      assertNullableFiniteNumber(row[field], `faceVectors[${row.id}].${field}`);
    }
    assertBinaryFlag(row.is_rejected, `faceVectors[${row.id}].is_rejected`);
    assertInteger(row.created_at, `faceVectors[${row.id}].created_at`);
    const embedding = parseEmbedding(
      row.embedding,
      `faceVectors[${row.id}].embedding`
    );
    if (embedding) {
      dimensions.add(embedding.length);
    }
  }

  for (const row of payload.faceIdentities) {
    assertInteger(row.id, "faceIdentities.id");
    if (identityIds.has(row.id)) {
      fail(`duplicate face identity id ${row.id}`);
    }
    identityIds.add(row.id);
    if (row.name !== null && typeof row.name !== "string") {
      fail(`faceIdentities[${row.id}].name must be a string or null`);
    }
    if (row.representative_photo_id !== null) {
      assertInteger(
        row.representative_photo_id,
        `faceIdentities[${row.id}].representative_photo_id`
      );
      referencedPhotoIds.add(row.representative_photo_id);
    }
    if (
      row.representative_vector_id !== null &&
      typeof row.representative_vector_id !== "string"
    ) {
      fail(
        `faceIdentities[${row.id}].representative_vector_id must be a string or null`
      );
    }
    const centroid = parseEmbedding(
      row.centroid_embedding,
      `faceIdentities[${row.id}].centroid_embedding`
    );
    if (centroid) {
      dimensions.add(centroid.length);
    }
    assertInteger(row.face_count, `faceIdentities[${row.id}].face_count`);
    if (row.face_count < 0) {
      fail(`faceIdentities[${row.id}].face_count < 0`);
    }
    assertBinaryFlag(
      row.is_confirmed,
      `faceIdentities[${row.id}].is_confirmed`
    );
    assertInteger(row.created_at, `faceIdentities[${row.id}].created_at`);
  }

  for (const row of payload.faceIdentityMembers) {
    assertInteger(row.id, "faceIdentityMembers.id");
    if (memberIds.has(row.id)) {
      fail(`duplicate face member id ${row.id}`);
    }
    memberIds.add(row.id);
    assertInteger(
      row.identity_id,
      `faceIdentityMembers[${row.id}].identity_id`
    );
    assertInteger(
      row.face_vector_id,
      `faceIdentityMembers[${row.id}].face_vector_id`
    );
    if (!identityIds.has(row.identity_id)) {
      fail(`member ${row.id} references missing identity ${row.identity_id}`);
    }
    if (!vectorIds.has(row.face_vector_id)) {
      fail(`member ${row.id} references missing vector ${row.face_vector_id}`);
    }
  }

  const processedIds = new Set();
  for (const id of payload.faceProcessedPhotoIds) {
    assertInteger(id, "faceProcessedPhotoIds[]");
    if (processedIds.has(id)) {
      fail(`duplicate processed photo id ${id}`);
    }
    processedIds.add(id);
    referencedPhotoIds.add(id);
  }

  if (dimensions.size > 1) {
    fail(`mixed embedding dimensions: ${[...dimensions].join(", ")}`);
  }
  const expectedDimension = payload.faceModelKind
    ? FACE_MODEL_DIMENSIONS[payload.faceModelKind]
    : ([...dimensions][0] ?? null);
  if (
    expectedDimension != null &&
    [...dimensions].some((dimension) => dimension !== expectedDimension)
  ) {
    fail(
      `embedding dimension ${[...dimensions].join(", ")} does not match ${expectedDimension}`
    );
  }

  if (options.photoIds) {
    const photoIds = options.photoIds;
    for (const photoId of referencedPhotoIds) {
      if (!photoIds.has(photoId)) {
        fail(`payload references missing photo ${photoId}`);
      }
    }
  }

  return {
    dimension: expectedDimension,
    kind: payload.faceModelKind,
    referencedPhotoIds,
  };
}

export function createFaceBackupPayload(
  db,
  { backupOf, createdAt = Date.now() }
) {
  const dump = (sql) => db.prepare(sql).all();
  const payload = {
    format: FACE_BACKUP_FORMAT,
    version: FACE_BACKUP_VERSION,
    createdAt,
    backupOf: path.basename(backupOf),
    faceVectors: dump(`SELECT ${VECTOR_COLUMNS} FROM face_vectors ORDER BY id`),
    faceIdentities: dump(
      `SELECT ${IDENTITY_COLUMNS} FROM face_identities ORDER BY id`
    ),
    faceIdentityMembers: dump(
      "SELECT id, identity_id, face_vector_id FROM face_identity_members ORDER BY id"
    ),
    faceProcessedPhotoIds: dump(
      "SELECT id FROM photos WHERE is_face_processed = 1 ORDER BY id"
    ).map((row) => row.id),
    faceModelKind:
      db
        .prepare("SELECT value FROM app_settings WHERE key = 'face.model.kind'")
        .get()?.value ?? null,
  };
  const checked = addFaceBackupChecksum(payload);
  validateFaceBackupPayload(checked);
  return checked;
}

export function writeFaceBackup(backupFile, payload) {
  validateFaceBackupPayload(payload);
  const target = path.resolve(backupFile);
  const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    fs.renameSync(temp, target);
  } catch (error) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Preserve the original error.
    }
    throw error;
  }
  return target;
}

function isLegacyFaceBackup(payload) {
  return (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    payload.format === undefined &&
    payload.version === undefined &&
    payload.checksum === undefined
  );
}

function normalizeLegacyFaceBackup(payload, legacyKind) {
  if (!isLegacyFaceBackup(payload)) {
    return null;
  }
  if (!LEGACY_FACE_BACKUP_KINDS.includes(legacyKind)) {
    throw new Error(
      "Legacy face backup detected; re-run with --legacy-kind ultraface-w600k"
    );
  }

  const normalized = addFaceBackupChecksum({
    ...payload,
    format: FACE_BACKUP_FORMAT,
    version: FACE_BACKUP_VERSION,
    faceModelKind: legacyKind,
  });
  validateFaceBackupPayload(normalized);
  console.warn(
    "Legacy face backup accepted without a source checksum; it was normalized " +
      `as ${legacyKind} with a new checksum before restore.`
  );
  return normalized;
}

export function readFaceBackup(backupFile, { legacyKind } = {}) {
  let payload;
  try {
    payload = JSON.parse(fs.readFileSync(backupFile, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read backup ${backupFile}: ${error.message}`);
  }
  const legacyPayload = normalizeLegacyFaceBackup(payload, legacyKind);
  if (legacyPayload) {
    return legacyPayload;
  }
  validateFaceBackupPayload(payload);
  return payload;
}

function printUsage() {
  console.error(
    "Usage: node scripts/backup-face-data.mjs <dbPath> [backupFile]"
  );
}

export function runBackup(dbPath, backupFileArg) {
  if (!dbPath) {
    throw new Error("dbPath is required");
  }
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database not found: ${dbPath}`);
  }
  const backupFile =
    backupFileArg ??
    path.join(
      path.dirname(dbPath),
      "backups",
      `face-backup-${Date.now()}.json`
    );
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const payload = createFaceBackupPayload(db, { backupOf: dbPath });
    writeFaceBackup(backupFile, payload);
    console.log(`Backed up face data: ${backupFile}`);
    console.log(`  face_vectors: ${payload.faceVectors.length}`);
    console.log(`  face_identities: ${payload.faceIdentities.length}`);
    console.log(
      `  face_identity_members: ${payload.faceIdentityMembers.length}`
    );
    console.log(
      `  is_face_processed photos: ${payload.faceProcessedPhotoIds.length}`
    );
    console.log(`  face.model.kind: ${payload.faceModelKind ?? "(unset)"}`);
    console.log(`  checksum: ${payload.checksum}`);
    return payload;
  } finally {
    db.close();
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const [dbPath, backupFile] = process.argv.slice(2);
  if (dbPath) {
    try {
      runBackup(dbPath, backupFile);
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  } else {
    printUsage();
    process.exitCode = 1;
  }
}
