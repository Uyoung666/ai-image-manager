/** @vitest-environment node */
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

describe("project cull source migration", () => {
  it("adds curate as the workflow for an existing project without changing decisions", () => {
    const sqlite = new Database(":memory:");
    try {
      const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
      const revision = migrations.findIndex((migration) =>
        migration.sql.some((statement) => statement.includes("`workflow`"))
      );
      const last = migrations[revision];
      if (!last) {
        throw new Error("Missing migration");
      }
      for (const migration of migrations.slice(0, revision)) {
        for (const statement of migration.sql) {
          sqlite.exec(statement);
        }
      }
      sqlite.exec(
        "INSERT INTO shooting_projects(id,name,source_root,source_status,source_checked_at,created_at,updated_at,last_opened_at) VALUES('old','Legacy','D:/shoot','online',1,1,1,1)"
      );
      sqlite.exec(
        "INSERT INTO shooting_project_photos(id,project_id,relative_path,filename,file_size,modified_at,format,status,source_status,created_at) VALUES('p','old','one.jpg','one.jpg',10,1,'jpg','kept','available',1)"
      );
      for (const statement of last.sql) {
        sqlite.exec(statement);
      }
      expect(
        sqlite
          .prepare("SELECT workflow FROM shooting_projects WHERE id='old'")
          .get()
      ).toEqual({ workflow: "curate" });
      expect(
        sqlite
          .prepare("SELECT status FROM shooting_project_photos WHERE id='p'")
          .get()
      ).toEqual({ status: "kept" });
    } finally {
      sqlite.close();
    }
  });

  it("upgrades a populated legacy database without losing sessions, ratings or undo history", () => {
    const sqlite = new Database(":memory:");
    try {
      sqlite.pragma("foreign_keys = ON");
      const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
      const revision = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes("csp_exactly_one_source")
        )
      );
      expect(revision).toBeGreaterThan(0);
      sqlite.exec(
        "CREATE TABLE __drizzle_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at NUMERIC)"
      );
      for (const migration of migrations.slice(0, revision)) {
        for (const statement of migration.sql) {
          sqlite.exec(statement);
        }
        sqlite
          .prepare(
            "INSERT INTO __drizzle_migrations(hash, created_at) VALUES (?,?)"
          )
          .run(migration.hash, migration.folderMillis);
      }
      sqlite.exec(`
        INSERT INTO photos(id,path,filename,created_at,is_favorite) VALUES(1,'/old/one.jpg','one.jpg',1,1),(2,'/old/two.jpg','two.jpg',1,0);
        INSERT INTO cull_sessions(id,name,mode,status,total_photos,completed_comparisons,pk_mode,sort_strategy,created_at) VALUES(1,'旧PK','duel','active',2,1,'standard','time',1),(2,'旧甄选','curate','completed',2,2,'standard','time',1);
        INSERT INTO cull_session_photos(id,session_id,photo_id,rating,comparisons,wins,losses,status) VALUES(1,1,1,1516,1,1,0,'pending'),(2,1,2,1484,1,0,1,'pending'),(3,2,1,1500,0,0,0,'kept'),(4,2,2,1500,0,0,0,'rejected');
        INSERT INTO cull_action_logs(id,session_id,action,payload,created_at) VALUES(1,1,'compare','{"winnerId":1,"loserId":2,"winnerOldRating":1500,"loserOldRating":1500}',1),(2,2,'batchStatus','{"entries":[]}',2);
      `);
      const sessions = sqlite
        .prepare("SELECT * FROM cull_sessions ORDER BY id")
        .all();
      const items = sqlite
        .prepare("SELECT * FROM cull_session_photos ORDER BY id")
        .all();
      const logs = sqlite
        .prepare("SELECT * FROM cull_action_logs ORDER BY id")
        .all();
      migrate(drizzle(sqlite), { migrationsFolder: "drizzle" });
      expect(
        sqlite
          .prepare(
            "SELECT id,name,mode,status,total_photos,completed_comparisons,pk_mode,sort_strategy,created_at,completed_at FROM cull_sessions ORDER BY id"
          )
          .all()
      ).toEqual(sessions);
      expect(
        sqlite
          .prepare(
            "SELECT id,session_id,photo_id,rating,comparisons,wins,losses,status FROM cull_session_photos ORDER BY id"
          )
          .all()
      ).toEqual(items);
      expect(
        sqlite.prepare("SELECT * FROM cull_action_logs ORDER BY id").all()
      ).toEqual(logs);
      expect(
        sqlite
          .prepare("SELECT id,archived_at FROM cull_sessions ORDER BY id")
          .all()
      ).toEqual([
        { id: 1, archived_at: null },
        { id: 2, archived_at: null },
      ]);
      expect(sqlite.pragma("foreign_key_check")).toEqual([]);
      expect(sqlite.pragma("foreign_keys", { simple: true })).toBe(1);
      expect(() =>
        sqlite.exec("INSERT INTO cull_session_photos(session_id) VALUES(1)")
      ).toThrow();
      sqlite.exec("DELETE FROM cull_sessions WHERE id=1");
      expect(
        sqlite.prepare("SELECT id FROM cull_action_logs ORDER BY id").all()
      ).toEqual([{ id: 2 }]);
      expect(
        sqlite.prepare("SELECT id FROM cull_session_photos ORDER BY id").all()
      ).toEqual([{ id: 3 }, { id: 4 }]);
    } finally {
      sqlite.close();
    }
  });
});
