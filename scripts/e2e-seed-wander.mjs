/**
 * E2E seeding for the Wander feature.
 *
 * Run through the Electron binary (ELECTRON_RUN_AS_NODE=1) so better-sqlite3's
 * Electron ABI matches the app:
 *
 *   execFileSync(require("electron"), [thisScript, userDataDir, "true|false", photoCount], {
 *     env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
 *   })
 *
 * Creates a fresh library at <userDataDir>/data/ai-image-manager.db with all
 * migrations applied, writes real placeholder photo files, and inserts a
 * deterministic set of folders/photos/EXIF/tags/view-stats plus wander settings.
 * The SQLite handle is closed (and WAL checkpointed) before the app launches.
 */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import sharp from "sharp";

const [userDataDir, enabledArg, photoCountArg] = process.argv.slice(2);
if (!userDataDir) {
  console.error(
    "Usage: e2e-seed-wander.mjs <userDataDir> <enabled> [photoCount]"
  );
  process.exit(1);
}
const enabled = enabledArg === "true";
const photoCount = Math.max(4, Number(photoCountArg) || 14);
const root = process.cwd();

const dataDir = path.join(userDataDir, "data");
const photoDir = path.join(userDataDir, "e2e-photos");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(photoDir, { recursive: true });

const dbPath = path.join(dataDir, "ai-image-manager.db");
const sqlite = new Database(dbPath);
sqlite.pragma("journal_mode = WAL");
sqlite.pragma("foreign_keys = ON");
migrate(drizzle(sqlite), { migrationsFolder: path.join(root, "drizzle") });

const insertFolder = sqlite.prepare(
  "INSERT INTO folders (path, display_name, photo_count, created_at) VALUES (?, ?, ?, ?)"
);

const now = new Date();
const todayPrior = new Date(
  now.getFullYear() - 2,
  now.getMonth(),
  now.getDate(),
  12,
  0,
  0
).getTime();
const historicalDay = new Date(2023, 4, 15, 12, 0, 0).getTime(); // 2023-05-15
const yesterday = Date.now() - 24 * 60 * 60 * 1000;

const folderResult = insertFolder.run(
  photoDir,
  "E2E Wander",
  photoCount,
  Date.now()
);
const folderId = Number(folderResult.lastInsertRowid);
const fixtureJpeg = await sharp({
  create: {
    background: { b: 180, g: 120, r: 80 },
    channels: 3,
    height: 2,
    width: 2,
  },
})
  .jpeg({ quality: 70 })
  .toBuffer();

const insertPhoto = sqlite.prepare(`
  INSERT INTO photos
    (path, folder_id, filename, file_size, file_date, width, height, format,
     is_indexed, is_ai_processed, is_face_processed, is_favorite, deleted_at, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, 'jpg', 1, 0, 0, ?, NULL, ?)
`);
const insertExif = sqlite.prepare(
  "INSERT INTO exif_data (photo_id, date_taken) VALUES (?, ?)"
);
const insertTag = sqlite.prepare(
  "INSERT INTO tags (name, created_at) VALUES (?, ?)"
);
const insertPhotoTag = sqlite.prepare(
  "INSERT INTO photo_tags (photo_id, tag_id, origin, confidence, is_confirmed, user_confirmed) VALUES (?, ?, 'manual', NULL, 0, 1)"
);
const insertViewStat = sqlite.prepare(`
  INSERT INTO photo_view_stats (photo_id, view_count, last_viewed_at, wander_shown_count, last_wandered_at)
  VALUES (?, ?, ?, 0, NULL)
`);
const insertSetting = sqlite.prepare(
  "INSERT OR REPLACE INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)"
);

const photoIds = [];
for (let i = 0; i < photoCount; i += 1) {
  const filePath = path.join(photoDir, `photo-${i + 1}.jpg`);
  fs.writeFileSync(filePath, fixtureJpeg);
  const fileDate = (() => {
    if (i < 4) {
      return todayPrior;
    }
    if (i < 6) {
      return historicalDay;
    }
    return yesterday - i * 3_600_000;
  })();
  const info = insertPhoto.run(
    filePath,
    folderId,
    `photo-${i + 1}.jpg`,
    1,
    fileDate,
    1200,
    800,
    i % 2 === 0 ? 1 : 0,
    Date.now()
  );
  const photoId = Number(info.lastInsertRowid);
  photoIds.push(photoId);
  insertExif.run(photoId, fileDate);
}

// A trusted manual theme tag backed by the first four photos.
const themeTag = insertTag.run("E2E Theme", Date.now());
const themeTagId = Number(themeTag.lastInsertRowid);
for (const photoId of photoIds.slice(0, 4)) {
  insertPhotoTag.run(photoId, themeTagId);
}

// A couple of viewed photos so rediscovery has both sides to order by.
insertViewStat.run(photoIds[6], 3, yesterday);
insertViewStat.run(photoIds[7], 1, now.getTime() - 7 * 24 * 60 * 60 * 1000);

// Wander settings (read through the app_settings IPC by the provider).
const nowMs = Date.now();
insertSetting.run("wander.enabled", String(enabled), nowMs);
insertSetting.run("wander.idleMinutes", "15", nowMs);
insertSetting.run("wander.intervalSeconds", "3", nowMs);
insertSetting.run(
  "wander.modes",
  JSON.stringify(["timeCapsule", "theme", "rediscovery"]),
  nowMs
);

sqlite.pragma("wal_checkpoint(TRUNCATE)");
sqlite.close();
console.log(`[e2e-seed] ${photoCount} photos at ${dbPath}`);
