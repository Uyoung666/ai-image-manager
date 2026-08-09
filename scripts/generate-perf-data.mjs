/**
 * 性能压测数据生成器
 *
 * 在独立的 SQLite DB 中生成 100K 测试图片记录和真实图片文件。
 * 不依赖 Electron —— 直接使用 better-sqlite3 + sharp。
 *
 * 用法：node scripts/generate-perf-data.mjs [--count 100000] [--db path/to/perf.db] [--images path/to/images]
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

// ── CLI args ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
function arg(key, fallback) {
  const idx = args.indexOf(key);
  return idx >= 0 ? args[idx + 1] : fallback;
}

const COUNT = Number.parseInt(arg("--count", "100000"), 10);
const DB_PATH = arg("--db", path.join(projectRoot, "perf-test.db"));
const IMG_DIR = arg("--images", path.join(projectRoot, "perf-images"));

// ── Aspect ratio distribution (simulating real photo libraries) ──────

const ASPECT_RATIOS = [
  { ar: 3 / 2, weight: 0.4 }, // DSLR default
  { ar: 4 / 3, weight: 0.15 }, // m4/3 + phones
  { ar: 16 / 9, weight: 0.1 }, // widescreen phones
  { ar: 1 / 1, weight: 0.08 }, // Instagram square
  { ar: 2 / 3, weight: 0.12 }, // portrait phone
  { ar: 3 / 4, weight: 0.05 }, // portrait m4/3
  { ar: 9 / 16, weight: 0.05 }, // portrait phone wide
  { ar: 21 / 9, weight: 0.03 }, // ultrawide pano
  { ar: 5 / 4, weight: 0.02 }, // large format
];

// ── Synthetic JPEG generator (minimal valid JPEG, ~500 bytes) ────────
// A tiny valid JPEG: 2×2 pixels, no actual image content needed

function generateMinimalJpeg(width, height) {
  // Build a minimal valid JPEG with a solid gray pixel
  // This is a ~1KB JPEG that sharp can read
  const _side = Math.max(
    2,
    Math.min(64, Math.floor(Math.min(width, height) / 10))
  );
  // We'll write a simple BMP-like raw buffer and let sharp handle JPEG encoding later
  // For now, return a minimal valid JPEG binary
  // SOI, APP0 (JFIF), DQT, SOF0, DHT, SOS, compressed data, EOI
  const jpeg = Buffer.from(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAYEBAUEBAYFBQUGBgYHCQ4JCQgICRINDQoOFRIWFRQSExUcIB4XHCQdExUiISQlKB4pLSUyLDIwLCQvMS01KS81LCz/2wBDAQYGBgkICREJCREkGBQYJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCT/wAARCAAIAAgDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAUH/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8An0mAp0EAP//Z",
    "base64"
  );
  return jpeg;
}

// ── Main generator ────────────────────────────────────────────────────

console.log("\n=== 性能压测数据生成器 ===");
console.log(`目标照片数: ${COUNT.toLocaleString()}`);
console.log(`数据库路径: ${DB_PATH}`);
console.log(`图片目录:   ${IMG_DIR}\n`);

// Prepare directories
if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
}
if (!fs.existsSync(IMG_DIR)) {
  fs.mkdirSync(IMG_DIR, { recursive: true });
}

// Create DB and schema
const sqlite = new Database(DB_PATH);
sqlite.pragma("journal_mode = OFF"); // faster for bulk insert
sqlite.pragma("synchronous = OFF");
sqlite.pragma("foreign_keys = OFF");

sqlite.exec(`
  CREATE TABLE IF NOT EXISTS folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    photo_count INTEGER NOT NULL DEFAULT 0,
    last_scanned_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL UNIQUE,
    folder_id INTEGER REFERENCES folders(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    file_size INTEGER,
    file_date INTEGER,
    width INTEGER,
    height INTEGER,
    format TEXT,
    thumbnail_path TEXT,
    is_indexed INTEGER NOT NULL DEFAULT 1,
    is_ai_processed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );

  CREATE TABLE IF NOT EXISTS exif_data (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    photo_id INTEGER REFERENCES photos(id) ON DELETE CASCADE UNIQUE,
    camera_model TEXT,
    lens_model TEXT,
    focal_length TEXT,
    aperture REAL,
    iso INTEGER,
    date_taken INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_photos_folder_id ON photos(folder_id);
  CREATE INDEX IF NOT EXISTS idx_photos_file_date ON photos(file_date);
  CREATE INDEX IF NOT EXISTS idx_exif_date_taken ON exif_data(date_taken);
`);

// Insert folder
const folderPath = IMG_DIR.replace(/\\/g, "/");
sqlite
  .prepare(
    "INSERT INTO folders (path, display_name, photo_count) VALUES (?, ?, ?)"
  )
  .run(folderPath, "性能测试", COUNT);

// Weighted random aspect ratio picker
const weights = ASPECT_RATIOS.map((a) => a.weight);
const cumWeights = [];
let cum = 0;
for (const w of weights) {
  cum += w;
  cumWeights.push(cum);
}

function pickAspectRatio() {
  const r = Math.random();
  for (let i = 0; i < cumWeights.length; i++) {
    if (r <= cumWeights[i]) {
      return ASPECT_RATIOS[i].ar;
    }
  }
  return 3 / 2;
}

// Generate images and insert into DB
console.log("生成中...");

const cameraModels = [
  "Sony A7M4",
  "Sony A7M3",
  "Sony A7R5",
  "Canon EOS R5",
  "Canon EOS R6",
  "Nikon Z8",
  "Nikon Z6II",
  "Fujifilm X-T5",
  "Fujifilm X100VI",
  null,
];
const lensModels = [
  "FE 24-70mm F2.8 GM II",
  "FE 70-200mm F2.8 GM II",
  "FE 50mm F1.2 GM",
  "RF 24-70mm F2.8 L",
  "RF 50mm F1.2 L",
  "NIKKOR Z 24-70mm F2.8 S",
  null,
];

const batchSize = 5000;
const insertPhoto = sqlite.prepare(`
  INSERT INTO photos (path, folder_id, filename, file_size, file_date, width, height, format, is_indexed)
  VALUES (?, 1, ?, ?, ?, ?, ?, 'jpeg', 1)
`);
const insertExif = sqlite.prepare(`
  INSERT INTO exif_data (photo_id, camera_model, lens_model, focal_length, aperture, iso, date_taken)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const startTime = Date.now();
let lastReport = startTime;

const insertAll = sqlite.transaction(() => {
  for (let i = 1; i <= COUNT; i++) {
    const ar = pickAspectRatio();
    const baseSize = 3000 + Math.floor(Math.random() * 5000);
    const width = baseSize;
    const height = Math.round(baseSize / ar);

    // Random date within last 5 years
    const dateTaken =
      Date.now() - Math.floor(Math.random() * 5 * 365 * 24 * 60 * 60 * 1000);
    const fileDate = dateTaken + Math.floor(Math.random() * 3600 * 1000);

    const filename = `IMG_${String(i).padStart(6, "0")}.jpg`;
    const filePath = path.join(IMG_DIR, filename);
    const fileSize = 500_000 + Math.floor(Math.random() * 10_000_000);

    // Write a tiny valid JPEG for each photo
    const jpeg = generateMinimalJpeg(width, height);
    fs.writeFileSync(filePath, jpeg);

    insertPhoto.run(
      filePath.replace(/\\/g, "/"),
      filename,
      fileSize,
      fileDate,
      width,
      height
    );

    if (Math.random() > 0.3) {
      const cam = cameraModels[Math.floor(Math.random() * cameraModels.length)];
      const lens = lensModels[Math.floor(Math.random() * lensModels.length)];
      const focal = [24, 35, 50, 85, 135, 200][Math.floor(Math.random() * 6)];
      const aperture = [1.2, 1.4, 1.8, 2.8, 4, 5.6, 8][
        Math.floor(Math.random() * 7)
      ];
      const iso = [100, 200, 400, 800, 1600, 3200, 6400][
        Math.floor(Math.random() * 7)
      ];

      insertExif.run(i, cam, lens, `${focal}`, aperture, iso, dateTaken);
    }

    if (i % batchSize === 0) {
      const elapsed = ((Date.now() - lastReport) / 1000).toFixed(1);
      const pct = ((i / COUNT) * 100).toFixed(1);
      console.log(
        `  ${i.toLocaleString()}/${COUNT.toLocaleString()} (${pct}%) — 本批 ${batchSize} 条 ${elapsed}s`
      );
      lastReport = Date.now();
    }
  }
});

insertAll();

// Update folder count
sqlite.prepare("UPDATE folders SET photo_count = ? WHERE id = 1").run(COUNT);

// Analyze for query planner
sqlite.exec("ANALYZE");

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
console.log(
  `\n✅ 生成完成！共 ${COUNT.toLocaleString()} 条记录，耗时 ${totalTime}s`
);
console.log(
  `   数据库: ${DB_PATH} (${(fs.statSync(DB_PATH).size / 1024 / 1024).toFixed(1)} MB)`
);
console.log(
  `   图片目录: ${IMG_DIR} (${fs.readdirSync(IMG_DIR).length.toLocaleString()} 文件)`
);

// ── Quick benchmark queries ───────────────────────────────────────────

console.log("\n=== 快速查询基准 ===");

function bench(name, fn, iterations = 10) {
  const times = [];
  for (let i = 0; i < iterations; i++) {
    const t0 = performance.now();
    fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const p50 = times[Math.floor(times.length * 0.5)];
  const p95 = times[Math.floor(times.length * 0.95)];
  const p99 = times[Math.floor(times.length * 0.99)];
  console.log(
    `  ${name.padEnd(40)} avg=${avg.toFixed(2)}ms  p50=${p50.toFixed(2)}ms  p95=${p95.toFixed(2)}ms  p99=${p99.toFixed(2)}ms`
  );
}

// Paginated list (simulates listPhotos with limit 100)
bench("listPhotos (LIMIT 100, OFFSET 0)", () => {
  sqlite
    .prepare("SELECT * FROM photos ORDER BY file_date DESC LIMIT 100")
    .all();
});

bench("listPhotos (LIMIT 100, OFFSET 50000)", () => {
  sqlite
    .prepare(
      "SELECT * FROM photos ORDER BY file_date DESC LIMIT 100 OFFSET 50000"
    )
    .all();
});

bench("count(*)", () => {
  sqlite.prepare("SELECT count(*) FROM photos").get();
});

bench("search by filename LIKE pattern", () => {
  sqlite
    .prepare("SELECT * FROM photos WHERE filename LIKE '%IMG_05%' LIMIT 100")
    .all();
});

bench("filter by camera model", () => {
  sqlite
    .prepare(
      "SELECT p.* FROM photos p JOIN exif_data e ON p.id = e.photo_id WHERE e.camera_model = 'Sony A7M4' LIMIT 100"
    )
    .all();
});

bench("date range filter", () => {
  const yearAgo = Date.now() - 365 * 24 * 60 * 60 * 1000;
  sqlite
    .prepare(
      "SELECT * FROM photos WHERE file_date >= ? ORDER BY file_date DESC LIMIT 100"
    )
    .all(yearAgo);
});

// ── Memory estimate ───────────────────────────────────────────────────

const memUsage = process.memoryUsage();
console.log("\n=== 内存使用 (进程) ===");
console.log(`  RSS:      ${(memUsage.rss / 1024 / 1024).toFixed(1)} MB`);
console.log(
  `  Heap:     ${(memUsage.heapUsed / 1024 / 1024).toFixed(1)} MB / ${(memUsage.heapTotal / 1024 / 1024).toFixed(1)} MB`
);

sqlite.close();

console.log("\n=== 压测就绪 ===");
console.log("使用此数据集启动应用:");
console.log(`  1. 设置环境变量 AI_IMAGE_MANAGER_DB=${DB_PATH}`);
console.log(`  2. 导入文件夹 "${IMG_DIR}"`);
console.log("  3. 监控 FPS 帧率、内存、搜索延迟\n");
