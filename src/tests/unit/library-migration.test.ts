/** @vitest-environment node */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, expect, it } from "vitest";
import { backupBeforeLibraryReliabilityMigration } from "@/db";
import { TestRuntime } from "@/tests/helpers/test-runtime";

let runtime: TestRuntime;
let sqlite: Database.Database;
let dbPath: string;
let historicalMigrations: string;

beforeEach(() => {
  runtime = new TestRuntime("library-migration");
  dbPath = path.join(runtime.root, "catalogue.db");
  historicalMigrations = path.join(runtime.root, "migrations");
  fs.mkdirSync(path.join(historicalMigrations, "meta"), { recursive: true });
  const journal = JSON.parse(
    fs.readFileSync("drizzle/meta/_journal.json", "utf8")
  ) as {
    entries: Array<{ idx: number; tag: string }>;
  };
  journal.entries = journal.entries.filter(({ idx }) => idx <= 61);
  fs.writeFileSync(
    path.join(historicalMigrations, "meta/_journal.json"),
    JSON.stringify(journal)
  );
  for (const { tag } of journal.entries) {
    fs.copyFileSync(
      path.join("drizzle", `${tag}.sql`),
      path.join(historicalMigrations, `${tag}.sql`)
    );
  }
  sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
});

afterEach(() => {
  sqlite.close();
  expect(runtime.cleanup().status).toBe("deleted");
});

it("backs up committed WAL contents before migrating and retains catalogue relationships", () => {
  const db = drizzle(sqlite);
  migrate(db, { migrationsFolder: historicalMigrations });
  sqlite.exec(`
    INSERT INTO folders(id, path, display_name, created_at) VALUES(1, 'source', 'source', 1);
    INSERT INTO photos(id, path, filename, folder_id, is_favorite, created_at) VALUES(7, 'source/one.jpg', 'one.jpg', 1, 1, 1);
    INSERT INTO tags(id, name, created_at) VALUES(1, 'manual', 1);
    INSERT INTO photo_tags(photo_id, tag_id) VALUES(7, 1);
    INSERT INTO albums(id, name, created_at) VALUES(1, 'album', 1);
    INSERT INTO album_photos(photo_id, album_id) VALUES(7, 1);
    INSERT INTO cull_sessions(id, name, created_at) VALUES(1, 'review', 1);
    INSERT INTO cull_session_photos(session_id, photo_id) VALUES(1, 7);
    INSERT INTO face_vectors(id, photo_id, face_index, bbox_x, bbox_y, bbox_width, bbox_height, created_at)
      VALUES(3, 7, 0, 0, 0, 1, 1, 1);
    INSERT INTO face_identities(id, name, is_confirmed, created_at)
      VALUES(2, 'person', 1, 1);
    INSERT INTO face_identity_members(identity_id, face_vector_id)
      VALUES(2, 3);
    INSERT INTO face_review_decisions(photo_id, face_index, decision, source_identity_id, created_at, updated_at)
      VALUES(7, 0, 'confirmed', 2, 1, 1);
  `);
  const snapshot = backupBeforeLibraryReliabilityMigration(sqlite, dbPath);
  expect(snapshot).toBeTruthy();
  const backup = new Database(snapshot as string, { readonly: true });
  try {
    expect(backup.prepare("SELECT id, is_favorite FROM photos").get()).toEqual({
      id: 7,
      is_favorite: 1,
    });
    const columns = backup.pragma("table_info(photos)") as Array<{
      name: string;
    }>;
    expect(columns.some(({ name }) => name === "file_revision")).toBe(false);
    expect(backup.prepare("SELECT photo_id FROM photo_tags").get()).toEqual({
      photo_id: 7,
    });
  } finally {
    backup.close();
  }
  migrate(db, { migrationsFolder: "drizzle" });
  expect(
    sqlite
      .prepare(
        "SELECT id, is_favorite, source_status, content_revision, embedding_refresh_attempts, embedding_refresh_retry_at, embedding_refresh_file_revision FROM photos"
      )
      .get()
  ).toEqual({
    id: 7,
    is_favorite: 1,
    source_status: "unverified",
    content_revision: 0,
    embedding_refresh_attempts: 0,
    embedding_refresh_retry_at: 0,
    embedding_refresh_file_revision: null,
  });
  expect(sqlite.prepare("SELECT photo_id FROM photo_tags").get()).toEqual({
    photo_id: 7,
  });
  expect(sqlite.prepare("SELECT photo_id FROM album_photos").get()).toEqual({
    photo_id: 7,
  });
  expect(
    sqlite.prepare("SELECT photo_id FROM cull_session_photos").get()
  ).toEqual({ photo_id: 7 });
  expect(
    sqlite.prepare("SELECT photo_id, content_revision FROM face_vectors").get()
  ).toEqual({ photo_id: 7, content_revision: 0 });
  expect(
    sqlite
      .prepare("SELECT identity_id, face_vector_id FROM face_identity_members")
      .get()
  ).toEqual({ identity_id: 2, face_vector_id: 3 });
  expect(
    sqlite
      .prepare(
        "SELECT photo_id, decision, source_identity_id, content_revision FROM face_review_decisions"
      )
      .get()
  ).toEqual({
    photo_id: 7,
    decision: "confirmed",
    source_identity_id: 2,
    content_revision: 0,
  });
  sqlite.exec(`
    INSERT INTO face_review_decisions(photo_id, face_index, content_revision, decision, created_at, updated_at)
      VALUES(7, 0, 1, 'rejected', 2, 2);
  `);
  expect(
    sqlite.prepare("SELECT count(*) AS count FROM face_review_decisions").get()
  ).toEqual({ count: 2 });
  expect(sqlite.pragma("foreign_key_check")).toEqual([]);
  expect(backupBeforeLibraryReliabilityMigration(sqlite, dbPath)).toBeNull();
});

it("does not create a backup for an empty first-run database", () => {
  expect(backupBeforeLibraryReliabilityMigration(sqlite, dbPath)).toBeNull();
  expect(fs.existsSync(path.join(runtime.root, "backups"))).toBe(false);
});
