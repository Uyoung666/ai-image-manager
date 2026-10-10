// @vitest-environment node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getSearchDatabaseRevision,
  invalidateVectorSearch,
} from "@/services/search-revision";

let directory: string;
let reader: Database.Database;
let writer: Database.Database;
let db: ReturnType<typeof drizzle>;
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "search-revision-"));
  const file = path.join(directory, "fixture.db");
  reader = new Database(file);
  db = drizzle(reader);
  migrate(db, { migrationsFolder: "drizzle" });
  reader.exec(
    "INSERT INTO photos(id,path,filename,created_at) VALUES(1,'/one.jpg','one.jpg',1)"
  );
  reader.exec("INSERT INTO exif_data(photo_id,iso) VALUES(1,100)");
  writer = new Database(file);
});
afterEach(() => {
  writer.close();
  reader.close();
  fs.rmSync(directory, { recursive: true });
});

describe("transactional search revision", () => {
  it("keeps exact metadata revisions stable while semantic revisions include vector changes", () => {
    const exact = getSearchDatabaseRevision(db, false);
    const semantic = getSearchDatabaseRevision(db);
    invalidateVectorSearch();
    expect(getSearchDatabaseRevision(db, false)).toBe(exact);
    expect(getSearchDatabaseRevision(db)).not.toBe(semantic);
  });
  it("ignores display-only writes from either connection", () => {
    const revision = getSearchDatabaseRevision(db);
    reader.exec(
      "UPDATE photos SET thumbnail_path='one.webp', width=400 WHERE id=1"
    );
    writer.exec(
      "INSERT INTO photo_view_stats(photo_id,view_count) VALUES(1,1)"
    );
    writer.exec(
      "INSERT INTO app_settings(key,value,updated_at) VALUES('theme','dark',1)"
    );
    expect(getSearchDatabaseRevision(db)).toBe(revision);
  });
  it.each([
    "UPDATE photos SET filename='two.jpg' WHERE id=1",
    "UPDATE photos SET deleted_at=1 WHERE id=1",
    "UPDATE exif_data SET iso=800 WHERE photo_id=1",
    "INSERT INTO tags(name,color,created_at) VALUES('mountain','#ffffff',1)",
  ])("observes committed search changes from another connection: %s", (statement) => {
    const revision = getSearchDatabaseRevision(db);
    writer.exec(statement);
    expect(getSearchDatabaseRevision(db)).not.toBe(revision);
  });
  it("does not expire results for no-op updates or rolled-back writes", () => {
    const revision = getSearchDatabaseRevision(db);
    reader.exec("UPDATE photos SET filename=filename WHERE id=1");
    writer.exec("BEGIN; UPDATE photos SET deleted_at=1 WHERE id=1; ROLLBACK");
    expect(getSearchDatabaseRevision(db)).toBe(revision);
  });
  it("tracks tag, person, color, advanced filter and restore changes", () => {
    reader.exec(
      "INSERT INTO tags(id,name,color,created_at) VALUES(1,'mountain','#ffffff',1); INSERT INTO photo_tags(photo_id,tag_id,confidence,origin,user_confirmed) VALUES(1,1,0.9,'manual',0); INSERT INTO face_identities(id,name,created_at) VALUES(1,'PersonAlpha',1); INSERT INTO face_vectors(id,photo_id,bbox_x,bbox_y,bbox_width,bbox_height,created_at) VALUES(1,1,0,0,1,1,1); INSERT INTO face_identity_members(identity_id,face_vector_id) VALUES(1,1); INSERT INTO advanced_exif_data(photo_id,normalized_json,status) VALUES(1,'{}','pending')"
    );
    let revision = getSearchDatabaseRevision(db);
    writer.exec(
      "UPDATE tags SET color='#ff0000' WHERE id=1; UPDATE advanced_exif_data SET status='complete' WHERE photo_id=1"
    );
    expect(getSearchDatabaseRevision(db)).toBe(revision);
    for (const statement of [
      "UPDATE tags SET name='lake' WHERE id=1",
      "UPDATE photo_tags SET confidence=0.5 WHERE photo_id=1",
      "UPDATE photo_tags SET user_confirmed=1 WHERE photo_id=1",
      "UPDATE face_identities SET name='PersonBeta' WHERE id=1",
      "DELETE FROM face_identity_members WHERE identity_id=1",
      "UPDATE photos SET color_bucket=123 WHERE id=1",
      "UPDATE advanced_exif_data SET capture_mode='portrait' WHERE photo_id=1",
      "UPDATE photos SET deleted_at=1 WHERE id=1",
      "UPDATE photos SET deleted_at=NULL WHERE id=1",
    ]) {
      writer.exec(statement);
      const next = getSearchDatabaseRevision(db);
      expect(next, statement).not.toBe(revision);
      revision = next;
    }
  });
});
