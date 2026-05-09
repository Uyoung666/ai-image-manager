import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema";
import { app } from "electron";
import path from "node:path";
import fs from "node:fs";

let dbInstance: ReturnType<typeof drizzle> | null = null;

export function getDbPath(): string {
  const userDataPath = app.getPath("userData");
  const dbDir = path.join(userDataPath, "data");
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  return path.join(dbDir, "ai-image-manager.db");
}

export function initDatabase(): ReturnType<typeof drizzle> {
  if (dbInstance) return dbInstance;

  const dbPath = getDbPath();
  console.log(`[DB] Initializing database at: ${dbPath}`);

  const sqlite = new Database(dbPath);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  dbInstance = drizzle(sqlite, { schema });
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
