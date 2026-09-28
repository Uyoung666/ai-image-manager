import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";

// Run with the development Electron binary in Node mode. Only creates a new,
// isolated profile; never opens the user's database or an existing profile.
const [profile, migrationDirectory] = process.argv.slice(2);
if (!profile || fs.existsSync(path.join(profile, "data"))) {
  throw new Error("A fresh isolated profile is required");
}
fs.mkdirSync(path.join(profile, "data"), { recursive: true });
const database = new Database(
  path.join(profile, "data", "ai-image-manager.db")
);
try {
  migrate(drizzle(database), {
    migrationsFolder: migrationDirectory ?? "drizzle",
  });
  const setting = database.prepare(
    "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
  );
  for (const [key, value] of [
    ["onboarding.completed", "true"],
    ["update.autoUpdate", "false"],
    ["wander.enabled", "false"],
  ]) {
    setting.run(key, value, Date.now());
  }
  database
    .prepare("INSERT INTO albums (name, created_at) VALUES (?, ?)")
    .run("Upgrade regression album", Date.now());
} finally {
  database.close();
}
