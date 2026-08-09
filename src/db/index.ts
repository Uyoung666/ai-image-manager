import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import { getDataPath } from "@/utils/data-path";
import { isSafePath } from "@/utils/path-security";
import {
  advancedExifData,
  albumPhotos,
  albums,
  appSettings,
  cloudConfigs,
  cloudSyncLog,
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  exifData,
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
  photoTags,
  photoViewStats,
  tags,
} from "./schema";

const schema = {
  advancedExifData,
  albumPhotos,
  albums,
  appSettings,
  cloudConfigs,
  cloudSyncLog,
  cullActionLogs,
  cullSessionPhotos,
  cullSessions,
  exifData,
  faceIdentities,
  faceIdentityExclusions,
  faceIdentityMembers,
  faceReviewDecisions,
  faceVectors,
  folders,
  photoSequenceExclusions,
  photoSequenceMembers,
  photoSequenceSuggestions,
  photoSequences,
  photos,
  photoTags,
  photoViewStats,
  tags,
};

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteConnection: Database.Database | null = null;

interface SQLiteTableColumn {
  name: string;
}

export interface PhotoTagProvenanceRepairResult {
  addedOrigin: boolean;
  addedUserConfirmed: boolean;
}

/**
 * Repair databases whose migration journal says the provenance migration ran
 * even though a timestamp collision caused SQLite to skip its SQL.
 */
export function repairPhotoTagProvenanceSchema(
  sqlite: Database.Database
): PhotoTagProvenanceRepairResult {
  const columns = sqlite
    .prepare("PRAGMA table_info('photo_tags')")
    .all() as SQLiteTableColumn[];
  if (columns.length === 0) {
    return { addedOrigin: false, addedUserConfirmed: false };
  }

  const names = new Set(columns.map(({ name }) => name));
  const addedOrigin = !names.has("origin");
  const addedUserConfirmed = !names.has("user_confirmed");

  if (addedOrigin || addedUserConfirmed) {
    sqlite.transaction(() => {
      if (addedOrigin) {
        sqlite.exec(
          "ALTER TABLE photo_tags ADD origin text DEFAULT 'manual' NOT NULL"
        );
        sqlite.exec(
          `UPDATE photo_tags
           SET origin = CASE
             WHEN confidence IS NULL THEN 'manual'
             ELSE 'auto'
           END`
        );
      }
      if (addedUserConfirmed) {
        sqlite.exec(
          "ALTER TABLE photo_tags ADD user_confirmed integer DEFAULT 0 NOT NULL"
        );
        sqlite.exec(
          `UPDATE photo_tags
           SET user_confirmed = CASE
             WHEN confidence IS NULL THEN 1
             ELSE 0
           END`
        );
      }
    })();
  }

  return { addedOrigin, addedUserConfirmed };
}

export function getDbPath(): string {
  const dataPath = getDataPath();
  const dbDir = path.join(dataPath, "data");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, "ai-image-manager.db");
}

function getMigrationsFolder(): string {
  // 定义允许的迁移文件路径白名单
  const allowedRoots = [app.getAppPath(), process.cwd(), process.resourcesPath];

  // In development, migrations are in the project root
  const candidates = [
    path.join(app.getAppPath(), "drizzle"),
    path.join(process.cwd(), "drizzle"),
    path.join(app.getAppPath(), "..", "..", "drizzle"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate) && isSafePath(candidate, allowedRoots)) {
      return candidate;
    }
  }
  // Fallback for packaged app
  const prodPath = path.join(process.resourcesPath, "drizzle");
  if (fs.existsSync(prodPath) && isSafePath(prodPath, allowedRoots)) {
    return prodPath;
  }
  throw new Error("Migrations folder not found");
}

export function initDatabase(): ReturnType<typeof drizzle> {
  if (dbInstance) {
    return dbInstance;
  }

  const dbPath = getDbPath();
  console.log(`[DB] Initializing database at: ${dbPath}`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");
  sqliteConnection = sqlite;

  // Register custom SQLite functions
  sqlite.function(
    "closest_color_dist",
    (r: number, g: number, b: number, colorsJson: string | null) => {
      if (!colorsJson) {
        return Number.MAX_VALUE;
      }
      try {
        const colors = JSON.parse(colorsJson);
        let minDist = Number.POSITIVE_INFINITY;
        for (const c of colors) {
          const dr = c.r - r;
          const dg = c.g - g;
          const db = c.b - b;
          const dist = dr * dr + dg * dg + db * db;
          if (dist < minDist) {
            minDist = dist;
          }
        }
        return minDist;
      } catch {
        return Number.MAX_VALUE;
      }
    }
  );

  dbInstance = drizzle(sqlite, { schema });

  // Auto-run migrations on startup
  const migrationsFolder = getMigrationsFolder();
  try {
    console.log(`[DB] Running migrations from: ${migrationsFolder}`);
    migrate(dbInstance, { migrationsFolder });
    console.log("[DB] Migrations complete");
    const provenanceRepair = repairPhotoTagProvenanceSchema(sqlite);
    if (provenanceRepair.addedOrigin || provenanceRepair.addedUserConfirmed) {
      console.warn(
        `[DB] Repaired photo tag provenance columns: origin=${provenanceRepair.addedOrigin} userConfirmed=${provenanceRepair.addedUserConfirmed}`
      );
    }
  } catch (err) {
    closeDatabase();
    throw err;
  }

  // Repair self-referencing tags (can happen if a category parent name matches a candidate tag)
  const selfRef = sqlite
    .prepare("UPDATE tags SET parent_id = NULL WHERE id = parent_id")
    .run();
  if (selfRef.changes > 0) {
    console.log(`[DB] Repaired ${selfRef.changes} self-referencing tag(s)`);
  }

  // Repair RAW format: legacy data stored as "jpeg" from embedded preview
  const rawFormats = [
    "cr2",
    "cr3",
    "nef",
    "nrw",
    "arw",
    "srf",
    "sr2",
    "dng",
    "orf",
    "rw2",
    "raf",
    "pef",
    "rwl",
    "3fr",
    "raw",
  ];
  let rawFixed = 0;
  for (const rf of rawFormats) {
    const result = sqlite
      .prepare(
        "UPDATE photos SET format = ? WHERE LOWER(filename) LIKE ? AND format != ?"
      )
      .run(rf, `%.${rf}`, rf);
    rawFixed += result.changes;
  }
  if (rawFixed > 0) {
    console.log(`[DB] Repaired ${rawFixed} RAW photo(s) format`);
  }

  // Heal stale thumbnail_path values. The thumbnailer stores absolute paths
  // (e.g. "C:/.../AI Image Manager/thumbnails/<hash>.webp") in the DB, so a
  // data-path migration leaves every row pointing at the old location. The
  // local-media protocol then 403s those URLs and the gallery shows
  // placeholders. Rewrite mismatched rows to the current thumbnails dir,
  // preserving each row's hashed filename.
  try {
    const currentThumbDir = path.join(getDataPath(), "thumbnails");
    const norm = currentThumbDir.replace(/\\/g, "/").toLowerCase();
    const rows = sqlite
      .prepare(
        "SELECT id, thumbnail_path AS p FROM photos WHERE thumbnail_path IS NOT NULL AND thumbnail_path != ''"
      )
      .all() as { id: number; p: string }[];
    const update = sqlite.prepare(
      "UPDATE photos SET thumbnail_path = ? WHERE id = ?"
    );
    const healMany = sqlite.transaction(
      (items: { id: number; p: string }[]) => {
        let healed = 0;
        for (const row of items) {
          const rowNorm = row.p.replace(/\\/g, "/").toLowerCase();
          if (rowNorm.startsWith(`${norm}/`)) {
            continue;
          }
          const filename = path.basename(row.p);
          const fixed = path.join(currentThumbDir, filename);
          update.run(fixed, row.id);
          healed++;
        }
        return healed;
      }
    );
    const healedCount = healMany(rows);
    if (healedCount > 0) {
      console.log(
        `[DB] Healed ${healedCount} stale thumbnail path(s) → ${currentThumbDir}`
      );
    }
  } catch (err) {
    console.warn(
      "[DB] Thumbnail path heal skipped:",
      (err as Error)?.message ?? err
    );
  }

  return dbInstance;
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!dbInstance) {
    return initDatabase();
  }
  return dbInstance;
}

function dbDiag(msg: string) {
  try {
    const dir = path.join(
      process.env.APPDATA || "/tmp",
      "AI Image Manager",
      "logs"
    );
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "migrate.log"),
      `${new Date().toISOString()} ${msg}\n`,
      { flag: "a" }
    );
  } catch {
    /* best-effort */
  }
}

export function closeDatabase(): void {
  const connection = sqliteConnection;
  if (!connection) {
    dbDiag("closeDatabase: sqliteConnection already null, skip");
    console.warn("[DB] Connection was already null/undefined, skipping close");
    dbInstance = null;
    return;
  }

  let closed = false;
  try {
    // A busy/failing checkpoint must not prevent close(). close() itself also
    // flushes committed WAL pages, and retaining the reference until it has
    // actually succeeded lets a later shutdown retry a failed close.
    try {
      const checkpoint = connection.pragma(
        "wal_checkpoint(TRUNCATE)"
      ) as Array<{
        busy?: number;
      }>;
      if (checkpoint[0]?.busy) {
        dbDiag("closeDatabase: wal_checkpoint busy");
        console.warn("[DB] WAL checkpoint was busy; continuing with close()");
      } else {
        dbDiag("closeDatabase: wal_checkpoint OK");
      }
    } catch (err) {
      dbDiag(
        `closeDatabase: wal_checkpoint ERROR ${(err as Error)?.message ?? err}`
      );
      console.error(
        "[DB] WAL checkpoint failed; continuing with close():",
        (err as Error)?.message ?? err
      );
    }

    connection.close();
    closed = true;
    dbDiag("closeDatabase: OK");
    console.log("[DB] Connection closed gracefully");
  } catch (err) {
    dbDiag(`closeDatabase: close ERROR ${(err as Error)?.message ?? err}`);
    console.error(
      "[DB] Non-fatal error during close:",
      (err as Error)?.message ?? err
    );
  } finally {
    if (closed) {
      sqliteConnection = null;
      dbInstance = null;
    }
  }
}
