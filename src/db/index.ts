import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { app } from "electron";
import * as schema from "./schema";

let dbInstance: ReturnType<typeof drizzle> | null = null;

export function getDbPath(): string {
  const userDataPath = app.getPath("userData");
  const dbDir = path.join(userDataPath, "data");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, "ai-image-manager.db");
}

function getMigrationsFolder(): string {
  // In development, migrations are in the project root
  const candidates = [
    path.join(app.getAppPath(), "drizzle"),
    path.join(process.cwd(), "drizzle"),
    path.join(app.getAppPath(), "..", "..", "drizzle"),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  // Fallback for packaged app
  const prodPath = path.join(process.resourcesPath, "drizzle");
  if (fs.existsSync(prodPath)) {
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

  dbInstance = drizzle(sqlite, { schema });

  // Auto-run migrations on startup
  const migrationsFolder = getMigrationsFolder();
  console.log(`[DB] Running migrations from: ${migrationsFolder}`);
  migrate(dbInstance, { migrationsFolder });
  console.log("[DB] Migrations complete");

  // Repair self-referencing tags (can happen if a category parent name matches a candidate tag)
  const selfRef = sqlite
    .prepare("UPDATE tags SET parent_id = NULL WHERE id = parent_id")
    .run();
  if (selfRef.changes > 0) {
    console.log(`[DB] Repaired ${selfRef.changes} self-referencing tag(s)`);
  }

  return dbInstance;
}

export function getDatabase(): ReturnType<typeof drizzle> {
  if (!dbInstance) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return dbInstance;
}

export function closeDatabase(): void {
  // better-sqlite3 automatically closes when the process exits
  dbInstance = null;
}
