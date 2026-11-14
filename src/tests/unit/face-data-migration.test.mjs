import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  addFaceBackupChecksum,
  createFaceBackupPayload,
  FACE_BACKUP_FORMAT,
  FACE_BACKUP_VERSION,
  readFaceBackup,
  runBackup,
  validateFaceBackupPayload,
} from "../../../scripts/backup-face-data.mjs";
import { runMigration } from "../../../scripts/migrate-face-data.mjs";
import { restoreFaceData } from "../../../scripts/restore-face-data.mjs";
import { TestRuntime } from "../helpers/test-runtime.ts";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite");

let runtime;
let previousTempEnvironment;
const CHECKSUM_MISMATCH = /checksum mismatch/;
const DIMENSION_MISMATCH = /does not match 128/;
const LEGACY_KIND_REQUIRED = /legacy-kind/;
const MISSING_PHOTO = /missing photo 999/;
const ROLLED_BACK = /rolled back/;
const VERSIONED_HISTORY_UNSUPPORTED =
  /cannot represent content-versioned face history/;
const PROCESSED_REVISION_EVIDENCE = /faceProcessedPhotoRevisions/;

function vector(dimension = 128, value = 0.1) {
  return JSON.stringify(Array.from({ length: dimension }, () => value));
}

function makePayload(overrides = {}) {
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

function createDatabase({
  versioned = false,
  reviews = versioned,
  photoRevision = 0,
} = {}) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "ai-image-manager-face-migration-")
  );
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
  if (versioned) {
    db.exec(
      "ALTER TABLE photos ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0"
    );
    db.exec(
      "ALTER TABLE photos ADD COLUMN face_refresh_pending INTEGER NOT NULL DEFAULT 0"
    );
    db.prepare("UPDATE photos SET content_revision = ?").run(photoRevision);
    db.exec(
      "ALTER TABLE face_vectors ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 0"
    );
  }
  if (reviews) {
    db.exec(`CREATE TABLE face_review_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      photo_id INTEGER NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
      face_index INTEGER NOT NULL,
      decision TEXT NOT NULL,
      source_identity_id INTEGER REFERENCES face_identities(id) ON DELETE SET NULL,
      source_identity_name TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL${versioned ? ", content_revision INTEGER NOT NULL DEFAULT 0" : ""},
      UNIQUE(photo_id, face_index${versioned ? ", content_revision" : ""})
    );
    INSERT INTO face_review_decisions
      (id, photo_id, face_index, decision, source_identity_id, source_identity_name, created_at, updated_at)
      VALUES (1, 1, 0, 'rejected', 1, 'Ada', 2, 3);`);
  }
  db.close();
  return dbPath;
}

function readPayload(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    assert.deepStrictEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    return createFaceBackupPayload(db, { backupOf: dbPath, createdAt: 1 });
  } finally {
    db.close();
  }
}

function readState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    function readRequiredRow(query) {
      const row = db.prepare(query).get();
      if (!row) {
        throw new Error(`Expected a row for query: ${query}`);
      }
      return row;
    }

    const versioned = db
      .prepare("PRAGMA table_info(photos)")
      .all()
      .some((column) => column.name === "content_revision");
    return {
      ...(versioned
        ? readRequiredRow(
            "SELECT content_revision AS contentRevision, face_refresh_pending AS faceRefreshPending FROM photos WHERE id = 1"
          )
        : {}),
      vectors: readRequiredRow("SELECT count(*) AS count FROM face_vectors")
        .count,
      identities: readRequiredRow(
        "SELECT count(*) AS count FROM face_identities"
      ).count,
      members: readRequiredRow(
        "SELECT count(*) AS count FROM face_identity_members"
      ).count,
      processed: readRequiredRow(
        "SELECT is_face_processed FROM photos WHERE id = 1"
      ).is_face_processed,
      kind: db
        .prepare("SELECT value FROM app_settings WHERE key = 'face.model.kind'")
        .get()?.value,
      faceAutoRefreshStopped: db
        .prepare(
          "SELECT value FROM app_settings WHERE key = 'faces.autoRefreshStopped'"
        )
        .get()?.value,
      aiAutoIndexStopped: db
        .prepare(
          "SELECT value FROM app_settings WHERE key = 'ai.autoIndexStopped'"
        )
        .get()?.value,
    };
  } finally {
    db.close();
  }
}

function assertStateSubset(actual, expected) {
  for (const [key, value] of Object.entries(expected)) {
    assert.equal(actual[key], value, `state.${key}`);
  }
}

beforeEach(() => {
  runtime = new TestRuntime("face-data-migration");
  const scratch = path.join(runtime.root, "scratch");
  fs.mkdirSync(scratch);
  previousTempEnvironment = new Map(
    ["TEMP", "TMP", "TMPDIR"].map((key) => [key, process.env[key]])
  );
  for (const key of previousTempEnvironment.keys()) {
    process.env[key] = scratch;
  }
});

afterEach(() => {
  for (const [key, value] of previousTempEnvironment) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  assert.equal(runtime.cleanup().status, "deleted");
});

describe("face backup payload safety", () => {
  it("validates optional processed-version evidence and includes it in the checksum", () => {
    const valid = makePayload({
      faceProcessedPhotoRevisions: [{ photo_id: 1, content_revision: 2 }],
    });
    assert.doesNotThrow(() => validateFaceBackupPayload(valid));
    assert.throws(
      () =>
        validateFaceBackupPayload({
          ...valid,
          faceProcessedPhotoRevisions: [{ photo_id: 1, content_revision: 3 }],
        }),
      CHECKSUM_MISMATCH
    );
    for (const evidence of [
      [],
      [{ photo_id: 2, content_revision: 2 }],
      [{ photo_id: 1, content_revision: -1 }],
      [{ photo_id: 1, content_revision: 0.5 }],
      [
        { photo_id: 1, content_revision: 2 },
        { photo_id: 1, content_revision: 2 },
      ],
      [null],
    ]) {
      assert.throws(
        () =>
          validateFaceBackupPayload(
            makePayload({ faceProcessedPhotoRevisions: evidence })
          ),
        PROCESSED_REVISION_EVIDENCE
      );
    }
  });

  it("requires a versioned payload and detects checksum tampering", () => {
    const payload = makePayload();
    assert.doesNotThrow(() => validateFaceBackupPayload(payload));

    const tampered = { ...payload, faceModelKind: "ultraface-w600k" };
    assert.throws(() => validateFaceBackupPayload(tampered), CHECKSUM_MISMATCH);
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
    assert.throws(() => validateFaceBackupPayload(payload), DIMENSION_MISMATCH);
  });
});

describe("face restore safety", () => {
  it("round-trips face vectors and review decisions from multiple content versions", () => {
    const dbPath = createDatabase({ versioned: true, photoRevision: 5 });
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`UPDATE face_vectors SET content_revision = 2 WHERE id = 1;
        UPDATE face_identities SET name = 'Ada', is_confirmed = 1, face_count = 2;
        UPDATE face_review_decisions SET content_revision = 2, decision = 'removed_from_identity';
        INSERT INTO face_vectors
          (photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, is_rejected, created_at, content_revision)
          SELECT photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, confidence, embedding, is_rejected, 4, 5 FROM face_vectors WHERE id = 1;
        INSERT INTO face_identity_members (identity_id, face_vector_id) VALUES (1, 2);
        INSERT INTO face_review_decisions
          (photo_id, face_index, decision, source_identity_id, source_identity_name, created_at, updated_at, content_revision)
          VALUES (1, 0, 'rejected', 1, 'Ada', 4, 5, 5);`);
    } finally {
      db.close();
    }
    const backupFile = path.join(path.dirname(dbPath), "versioned.json");
    const backup = runBackup(dbPath, backupFile);
    assert.deepStrictEqual(
      backup.faceVectors.map((row) => row.content_revision),
      [2, 5]
    );
    assert.deepStrictEqual(
      backup.faceReviewDecisions.map((row) => row.content_revision),
      [2, 5]
    );
    assert.deepStrictEqual(backup.faceProcessedPhotoRevisions, [
      { photo_id: 1, content_revision: 5 },
    ]);
    assert.deepStrictEqual(
      readFaceBackup(backupFile),
      JSON.parse(JSON.stringify(backup))
    );
    const target = createDatabase({ versioned: true, photoRevision: 5 });
    restoreFaceData(target, backupFile);
    assert.deepStrictEqual(readPayload(target), readPayload(dbPath));
    assertStateSubset(readState(target), {
      vectors: 2,
      identities: 1,
      members: 2,
      processed: 1,
      contentRevision: 5,
      faceRefreshPending: 0,
    });
  });

  for (const versionedTable of [
    "faceVectors",
    "faceReviewDecisions",
    "faceProcessedPhotoRevisions",
  ]) {
    it(`rejects versioned ${versionedTable} before altering an old database's relationships`, () => {
      const dbPath = createDatabase({ reviews: true });
      const before = readPayload(dbPath);
      const backupFile = path.join(
        path.dirname(dbPath),
        "unsupported-version.json"
      );
      const payload = addFaceBackupChecksum({
        ...before,
        [versionedTable]: (versionedTable === "faceProcessedPhotoRevisions"
          ? before.faceProcessedPhotoIds.map((id) => ({ photo_id: id }))
          : before[versionedTable]
        ).map((row) => ({
          ...row,
          content_revision: 3,
        })),
      });
      fs.writeFileSync(backupFile, JSON.stringify(payload));
      assert.throws(
        () => restoreFaceData(dbPath, backupFile),
        VERSIONED_HISTORY_UNSUPPORTED
      );
      assert.deepStrictEqual(readPayload(dbPath), before);
    });
  }

  it("restores an older backup's vectors and decisions into revision zero of the new schema", () => {
    const legacyDb = createDatabase({ reviews: true });
    const backupFile = path.join(
      path.dirname(legacyDb),
      "before-revisions.json"
    );
    const backup = runBackup(legacyDb, backupFile);
    assert.equal(
      Object.hasOwn(backup.faceVectors[0], "content_revision"),
      false
    );
    assert.equal(
      Object.hasOwn(backup.faceReviewDecisions[0], "content_revision"),
      false
    );
    const target = createDatabase({ versioned: true });
    restoreFaceData(target, backupFile);
    const restored = readPayload(target);
    const expected = addFaceBackupChecksum({
      ...readPayload(legacyDb),
      faceVectors: backup.faceVectors.map((row) => ({
        ...row,
        content_revision: 0,
      })),
      faceReviewDecisions: backup.faceReviewDecisions.map((row) => ({
        ...row,
        content_revision: 0,
      })),
      faceProcessedPhotoRevisions: backup.faceProcessedPhotoIds.map((id) => ({
        photo_id: id,
        content_revision: 0,
      })),
    });
    assert.deepStrictEqual(
      { ...JSON.parse(JSON.stringify(restored)), checksum: null },
      { ...JSON.parse(JSON.stringify(expected)), checksum: null }
    );
    assertStateSubset(readState(target), {
      vectors: 1,
      identities: 1,
      members: 1,
      processed: 1,
    });
  });

  it("does not mark a changed photo as processed when only legacy revision-zero faces were restored", () => {
    const legacyDb = createDatabase({ reviews: true });
    const backupFile = path.join(path.dirname(legacyDb), "stale-faces.json");
    runBackup(legacyDb, backupFile);
    const target = createDatabase({ versioned: true, photoRevision: 1 });
    restoreFaceData(target, backupFile);
    assertStateSubset(readState(target), {
      vectors: 1,
      identities: 1,
      members: 1,
      processed: 0,
      contentRevision: 1,
      faceRefreshPending: 1,
    });
    const restored = readPayload(target);
    assert.equal(restored.faceVectors[0].content_revision, 0);
    assert.equal(restored.faceReviewDecisions[0].content_revision, 0);
  });

  it("backs up zero-face completion evidence and queues only stale versions while preserving stopped indexing", () => {
    const source = createDatabase({ versioned: true, photoRevision: 3 });
    const sourceDb = new DatabaseSync(source);
    try {
      sourceDb.exec(
        "DELETE FROM face_review_decisions; DELETE FROM face_identity_members; DELETE FROM face_vectors; DELETE FROM face_identities;"
      );
    } finally {
      sourceDb.close();
    }
    const backupFile = path.join(path.dirname(source), "zero-faces.json");
    const backup = runBackup(source, backupFile);
    assert.deepStrictEqual(backup.faceVectors, []);
    assert.deepStrictEqual(backup.faceProcessedPhotoRevisions, [
      { photo_id: 1, content_revision: 3 },
    ]);
    const target = createDatabase({ versioned: true, photoRevision: 3 });
    const stoppedDb = new DatabaseSync(target);
    try {
      stoppedDb.exec(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ('faces.autoRefreshStopped', 'true', 1), ('ai.autoIndexStopped', 'true', 1)"
      );
    } finally {
      stoppedDb.close();
    }
    restoreFaceData(target, backupFile);
    assertStateSubset(readState(target), {
      processed: 1,
      faceRefreshPending: 0,
      contentRevision: 3,
    });
    const changedDb = new DatabaseSync(target);
    try {
      changedDb.exec("UPDATE photos SET content_revision = 4 WHERE id = 1");
    } finally {
      changedDb.close();
    }
    restoreFaceData(target, backupFile);
    assertStateSubset(readState(target), {
      vectors: 0,
      identities: 0,
      members: 0,
      processed: 0,
      faceRefreshPending: 1,
      contentRevision: 4,
      faceAutoRefreshStopped: "true",
      aiAutoIndexStopped: "true",
    });
  });

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

    assert.throws(() => restoreFaceData(dbPath, backupFile), MISSING_PHOTO);
    assertStateSubset(readState(dbPath), {
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

    assert.doesNotThrow(() => restoreFaceData(dbPath, backupFile));
    assertStateSubset(readState(dbPath), {
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

    assert.throws(
      () => restoreFaceData(dbPath, backupFile),
      LEGACY_KIND_REQUIRED
    );
    assert.doesNotThrow(() =>
      restoreFaceData(dbPath, backupFile, {
        legacyKind: "ultraface-w600k",
      })
    );
    assertStateSubset(readState(dbPath), {
      vectors: 1,
      identities: 1,
      members: 1,
      kind: "ultraface-w600k",
    });
    assertStateSubset(
      readFaceBackup(backupFile, { legacyKind: "ultraface-w600k" }),
      {
        format: FACE_BACKUP_FORMAT,
        version: FACE_BACKUP_VERSION,
        faceModelKind: "ultraface-w600k",
      }
    );
  });
});

describe("face migration safety", () => {
  it("makes limit a non-destructive read-only preview", async () => {
    const dbPath = createDatabase();
    const before = readState(dbPath);

    await runMigration([dbPath, "yunet-sface", "1"]);

    assert.deepStrictEqual(readState(dbPath), before);
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
      await assert.rejects(
        () => runMigration([dbPath, "yunet-sface"]),
        ROLLED_BACK
      );
    } finally {
      if (previousModelsDir === undefined) {
        delete process.env.FACE_MIGRATION_MODELS_DIR;
      } else {
        process.env.FACE_MIGRATION_MODELS_DIR = previousModelsDir;
      }
    }

    assert.deepStrictEqual(readState(dbPath), before);
  });
});
