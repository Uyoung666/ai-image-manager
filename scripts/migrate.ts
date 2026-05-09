import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";

const dbDir = path.join(process.cwd(), "data");
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const dbPath = path.join(dbDir, "ai-image-manager.db");
const migrationsFolder = path.join(process.cwd(), "drizzle");

if (!fs.existsSync(migrationsFolder)) {
  console.error("No drizzle migrations folder found. Run: npx drizzle-kit generate");
  process.exit(1);
}

const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");

const db = drizzle(sqlite);

console.log(`[Migrate] Running migrations from: ${migrationsFolder}`);
migrate(db, { migrationsFolder });
console.log("[Migrate] Migrations complete.");

process.exit(0);
