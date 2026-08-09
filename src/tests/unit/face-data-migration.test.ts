import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  addFaceBackupChecksum,
  FACE_BACKUP_FORMAT,
  FACE_BACKUP_VERSION,
  readFaceBackup,
  validateFaceBackupPayload,
} from "../../../scripts/backup-face-data.mjs";
import { runMigration } from "../../../scripts/migrate-face-data.mjs";
import { restoreFaceData } from "../../../scripts/restore-face-data.mjs";

const tempDirectories: string[] = [];
const CHECKSUM_MISMATCH = /checksum mismatch/;
const DIMENSION_MISMATCH = /does not match 128/;
const LEGACY_KIND_REQUIRED = /legacy-kind/;
const MISSING_PHOTO = /missing photo 999/;
const ROLLED_BACK = /rolled back/;

function vector(dimension = 128, value = 0.1) {
  return JSON.stringify(Array.from({ length: dimension }, () => value));
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return addFaceBackupChecksum({
    format: FACE_BACKUP_FORMAT,
    version: FACE_BACKUP_VERSION,
    createdAt: 1,
    backupOf: "test.db",
    faceVectors: [
      {
        id: 1,
        photo_id: 1,
        face_index: 0,
        bbox_x: 1,
        bbox_y: 2,
        bbox_width: 30,
        bbox_height: 30,
        confidence: 0.9,
        embedding: vector(),
        vector_id: null,
        is_rejected: 0,
        created_at: 1,
      },
    ],
    faceIdentities: [
      {
        id: 1,
        name: null,
        representative_photo_id: 1,
        representative_vector_id: "1",
        centroid_embedding: vector(),
        face_count: 1,
        is_confirmed: 0,
        created_at: 1,
      },
    ],
    faceIdentityMembers: [{ id: 1, identity_id: 1, face_vector_id: 1 }],
    faceProcessedPhotoIds: [1],
    faceModelKind: "yunet-sface",
    ...overrides,
  });
}

function makeLegacyPayload() {
  const payload = makePayload({
    faceModelKind: "ultraface-w600k",
    faceVectors: [
      {
        ...makePayload().faceVectors[0],
        embedding: vector(512),
      },
    ],
    faceIdentities: [
      {
        ...makePayload().faceIdentities[0],
        centroid_embedding: vector(512),
      },
    ],
  });
  const {
    checksum: _checksum,
    format: _format,
    version: _version,
    ...legacy
  } = payload;
  legacy.faceModelKind = null;
  return legacy;
}

function createDatabase() {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-face-migration-")
  );
  tempDirectories.push(directory);
  const dbPath = path.join(directory, "test.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE photos (
      id INTEGER PRIMARY KEY,
      path TEXT NOT NULL,
      is_face_processed INTEGER NOT NULL DEFAULT 0,
      deleted_at INTEGER
    );
    CREATE TABLE face_vectors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      face_index INTEGER NOT NULL DEFAULT 0,
      bbox_x REAL NOT NULL,
      bbox_y REAL NOT NULL,
      bbox_width REAL NOT NULL,
      bbox_height REAL NOT NULL,
      confidence REAL,
      embedding TEXT,
      vector_id TEXT,
      is_rejected INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE face_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      representative_photo_id INTEGER REFERENCES photos(id) ON DELETE SET NULL,
      representative_vector_id TEXT,
      centroid_embedding TEXT,
      face_count INTEGER NOT NULL DEFAULT 0,
      is_confirmed INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE face_identity_members (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identity_id INTEGER NOT NULL REFERENCES face_identities(id) ON DELETE CASCADE,
      face_vector_id INTEGER NOT NULL REFERENCES face_vectors(id) ON DELETE CASCADE,
      UNIQUE(identity_id, face_vector_id)
    );
  `);
  db.prepare(
    "INSERT INTO photos (id, path, is_face_processed) VALUES (1, ?, 1)"
  ).run(path.join(directory, "missing.jpg"));
  db.prepare(
    "INSERT INTO app_settings (key, value, updated_at) VALUES ('face.model.kind', 'yunet-sface', 1)"
  ).run();
  db.prepare(
    "INSERT INTO face_vectors (id, photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, is_rejected, created_at) VALUES (1, 1, 0, 1, 2, 30, 30, 0.9, ?, 0, 1)"
  ).run(vector());
  db.prepare(
    "INSERT INTO face_identities (id, representative_photo_id, representative_vector_id, centroid_embedding, face_count, is_confirmed, created_at) VALUES (1, 1, '1', ?, 1, 0, 1)"
  ).run(vector());
  db.prepare(
    "INSERT INTO face_identity_members (id, identity_id, face_vector_id) VALUES (1, 1, 1)"
  ).run();
  db.close();
  return dbPath;
}

function readState(dbPath: string) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const readRequiredRow = <T>(query: string): T => {
      const row = db.prepare(query).get() as T | undefined;
      if (!row) {
        throw new Error(`Expected a row for query: ${query}`);
      }
      return row;
    };

    return {
      vectors: readRequiredRow<{ count: number }>(
        "SELECT count(*) AS count FROM face_vectors"
      ).count,
      identities: readRequiredRow<{ count: number }>(
        "SELECT count(*) AS count FROM face_identities"
      ).count,
      members: readRequiredRow<{ count: number }>(
        "SELECT count(*) AS count FROM face_identity_members"
      ).count,
      processed: readRequiredRow<{ is_face_processed: number }>(
        "SELECT is_face_processed FROM photos WHERE id = 1"
      ).is_face_processed,
      kind: (
        db
          .prepare(
            "SELECT value FROM app_settings WHERE key = 'face.model.kind'"
          )
          .get() as { value: string } | undefined
      )?.value,
    };
  } finally {
    db.close();
  }
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("face backup payload safety", () => {
  it("requires a versioned payload and detects checksum tampering", () => {
    const payload = makePayload();
    expect(() => validateFaceBackupPayload(payload)).not.toThrow();

    const tampered = { ...payload, faceModelKind: "ultraface-w600k" };
    expect(() => validateFaceBackupPayload(tampered)).toThrow(
      CHECKSUM_MISMATCH
    );
  });

  it("rejects an embedding dimension that does not match the model kind", () => {
    const base = makePayload();
    const payload = makePayload({
      faceVectors: [
        {
          ...base.faceVectors[0],
          embedding: vector(512),
        },
      ],
      faceIdentities: [
        {
          ...base.faceIdentities[0],
          centroid_embedding: vector(512),
        },
      ],
    });
    expect(() => validateFaceBackupPayload(payload)).toThrow(
      DIMENSION_MISMATCH
    );
  });
});

describe("face restore safety", () => {
  it("validates references before deleting current face data", () => {
    const dbPath = createDatabase();
    const payload = makePayload({
      faceVectors: [
        {
          ...makePayload().faceVectors[0],
          photo_id: 999,
        },
      ],
      faceIdentities: [
        {
          ...makePayload().faceIdentities[0],
          representative_photo_id: 999,
        },
      ],
      faceProcessedPhotoIds: [999],
    });
    const backupFile = path.join(path.dirname(dbPath), "invalid.json");
    fs.writeFileSync(backupFile, JSON.stringify(payload), "utf8");

    expect(() => restoreFaceData(dbPath, backupFile)).toThrow(MISSING_PHOTO);
    expect(readState(dbPath)).toMatchObject({
      vectors: 1,
      identities: 1,
      members: 1,
      kind: "yunet-sface",
    });
  });

  it("restores a valid payload and its model marker", () => {
    const dbPath = createDatabase();
    const backupFile = path.join(path.dirname(dbPath), "valid.json");
    fs.writeFileSync(backupFile, JSON.stringify(makePayload()), "utf8");

    expect(() => restoreFaceData(dbPath, backupFile)).not.toThrow();
    expect(readState(dbPath)).toMatchObject({
      vectors: 1,
      identities: 1,
      members: 1,
      processed: 1,
      kind: "yunet-sface",
    });
  });

  it("restores the pre-v1 512-d legacy backup only with an explicit kind", () => {
    const dbPath = createDatabase();
    const backupFile = path.join(path.dirname(dbPath), "legacy.json");
    fs.writeFileSync(backupFile, JSON.stringify(makeLegacyPayload()), "utf8");

    expect(() => restoreFaceData(dbPath, backupFile)).toThrow(
      LEGACY_KIND_REQUIRED
    );
    expect(() =>
      restoreFaceData(dbPath, backupFile, {
        legacyKind: "ultraface-w600k",
      })
    ).not.toThrow();
    expect(readState(dbPath)).toMatchObject({
      vectors: 1,
      identities: 1,
      members: 1,
      kind: "ultraface-w600k",
    });
    expect(
      readFaceBackup(backupFile, { legacyKind: "ultraface-w600k" })
    ).toMatchObject({
      format: FACE_BACKUP_FORMAT,
      version: FACE_BACKUP_VERSION,
      faceModelKind: "ultraface-w600k",
    });
  });
});

describe("face migration safety", () => {
  it("makes limit a non-destructive read-only preview", async () => {
    const dbPath = createDatabase();
    const before = readState(dbPath);

    await runMigration([dbPath, "yunet-sface", "1"]);

    expect(readState(dbPath)).toEqual(before);
  });

  it("rolls back the wipe when worker initialization fails", async () => {
    const dbPath = createDatabase();
    const before = readState(dbPath);
    const modelsDir = path.join(path.dirname(dbPath), "models");
    fs.mkdirSync(path.join(modelsDir, "face"), { recursive: true });
    for (const fileName of [
      "face_detection_yunet_2023mar.onnx",
      "face_recognition_sface_2021dec.onnx",
    ]) {
      fs.writeFileSync(path.join(modelsDir, "face", fileName), "invalid");
    }
    const previousModelsDir = process.env.FACE_MIGRATION_MODELS_DIR;
    process.env.FACE_MIGRATION_MODELS_DIR = modelsDir;

    try {
      await expect(runMigration([dbPath, "yunet-sface"])).rejects.toThrow(
        ROLLED_BACK
      );
    } finally {
      if (previousModelsDir === undefined) {
        delete process.env.FACE_MIGRATION_MODELS_DIR;
      } else {
        process.env.FACE_MIGRATION_MODELS_DIR = previousModelsDir;
      }
    }

    expect(readState(dbPath)).toEqual(before);
  });
});
