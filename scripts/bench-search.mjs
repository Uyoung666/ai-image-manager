/**
 * 搜索性能 Benchmark
 *
 * 测量各类搜索/筛选场景在现有数据库上的耗时。不依赖 Electron ——
 * 直接使用 better-sqlite3 运行 SQL 查询，模拟关键搜索路径。
 *
 * 用法：
 *   node scripts/bench-search.mjs [--db path/to/perf.db] [--runs 5]
 *
 * 前置条件：
 *   - 已有带测试数据的 SQLite 数据库（可与 generate-perf-data.mjs 联用）
 *   - 至少数百条含 dominant_colors / exif_data / tags 的记录
 */

import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

const args = process.argv.slice(2);
function arg(key, fallback) {
  const idx = args.indexOf(key);
  return idx >= 0 ? args[idx + 1] : fallback;
}

const DB_PATH = arg("--db", path.join(projectRoot, "perf-test.db"));
const RUNS = Number.parseInt(arg("--runs", "5"), 10);

// ── Helpers ──────────────────────────────────────────────────────────────

function median(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function p95(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

function bench(name, fn, runs = RUNS) {
  const times = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  }
  return {
    scenario: name,
    runs,
    p50_ms: Math.round(median(times) * 100) / 100,
    p95_ms: Math.round(p95(times) * 100) / 100,
    min_ms: Math.round(Math.min(...times) * 100) / 100,
    max_ms: Math.round(Math.max(...times) * 100) / 100,
  };
}

function countPhotos(db) {
  return db.prepare("SELECT count(*) AS c FROM photos WHERE deleted_at IS NULL").get().c;
}

// ── RGB → Hue bucket ─────────────────────────────────────────────────────

function rgbToHue(r, g, b) {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const delta = max - min;
  if (delta === 0) return 0;
  let hue;
  if (max === rn) hue = ((gn - bn) / delta + (gn < bn ? 6 : 0)) * 60;
  else if (max === gn) hue = ((bn - rn) / delta + 2) * 60;
  else hue = ((rn - gn) / delta + 4) * 60;
  return Math.floor(hue / 10) % 36;
}

// ── Main ──────────────────────────────────────────────────────────────────

console.log("╔════════════════════════════════════════════════╗");
console.log("║       Search Benchmark                        ║");
console.log("╚════════════════════════════════════════════════╝");
console.log(`DB: ${DB_PATH}`);
console.log(`Runs per scenario: ${RUNS}\n`);

if (!fs.existsSync(DB_PATH)) {
  console.error(`ERROR: Database not found at ${DB_PATH}`);
  console.error("  Generate test data first: node scripts/generate-perf-data.mjs --count 10000");
  process.exit(1);
}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

const total = countPhotos(db);
console.log(`Photos in DB: ${total.toLocaleString()}\n`);

const results = [];

// ── 场景 1: 列表首屏 ─────────────────────────────────────────────────────

results.push(bench("list_first_page (OFFSET 0 LIMIT 100)", () => {
  db.prepare(`
    SELECT id, filename, file_date, file_size, width, height,
           format, thumbnail_path, is_favorite
    FROM photos
    WHERE deleted_at IS NULL
    ORDER BY file_date DESC
    LIMIT 100
  `).all();
}));

// ── 场景 2: 列表深翻页 ───────────────────────────────────────────────────

results.push(bench("list_deep_page (OFFSET 5000 LIMIT 100)", () => {
  db.prepare(`
    SELECT id, filename, file_date, file_size, width, height,
           format, thumbnail_path, is_favorite
    FROM photos
    WHERE deleted_at IS NULL
    ORDER BY file_date DESC
    LIMIT 100 OFFSET 5000
  `).all();
}));

// ── 场景 3: 文件夹筛选 ───────────────────────────────────────────────────

const folderId = db.prepare("SELECT id FROM folders LIMIT 1").get()?.id;
if (folderId) {
  results.push(bench("list_folder_filter", () => {
    db.prepare(`
      SELECT id, filename, file_date FROM photos
      WHERE deleted_at IS NULL AND folder_id = ?
      ORDER BY file_date DESC LIMIT 100
    `).all(folderId);
  }));
}

// ── 场景 4: 收藏筛选 ─────────────────────────────────────────────────────

results.push(bench("list_favorite_filter", () => {
  db.prepare(`
    SELECT id, filename, file_date FROM photos
    WHERE deleted_at IS NULL AND is_favorite = 1
    ORDER BY file_date DESC LIMIT 100
  `).all();
}));

// ── 场景 5: 文件名 LIKE 搜索 ──────────────────────────────────────────────

results.push(bench("filename_like '%sunset%'", () => {
  db.prepare(`
    SELECT id, filename FROM photos
    WHERE deleted_at IS NULL AND filename LIKE '%sunset%'
    LIMIT 50
  `).all();
}));

// ── 场景 6: 文件名 FTS5 搜索 ──────────────────────────────────────────────

try {
  results.push(bench("filename_fts5 'sunset'", () => {
    db.prepare(`
      SELECT rowid AS id FROM photos_fts WHERE photos_fts MATCH '"sunset"*'
      LIMIT 50
    `).all();
  }));
} catch { /* FTS5 may not exist */ }

// ── 场景 7: EXIF 日期范围 ────────────────────────────────────────────────

results.push(bench("exif_date_range", () => {
  db.prepare(`
    SELECT e.photo_id FROM exif_data e
    WHERE e.date_taken >= ? AND e.date_taken <= ?
    LIMIT 100
  `).all(
    new Date("2024-01-01").getTime(),
    new Date("2024-12-31").getTime()
  );
}));

// ── 场景 8: EXIF 相机筛选 ─────────────────────────────────────────────────

results.push(bench("exif_camera_like", () => {
  db.prepare(`
    SELECT e.photo_id FROM exif_data e
    WHERE e.camera_model LIKE '%Sony%'
    LIMIT 100
  `).all();
}));

// ── 场景 9: EXIF 复合筛选 ─────────────────────────────────────────────────

results.push(bench("exif_compound (date+camera+iso)", () => {
  db.prepare(`
    SELECT e.photo_id FROM exif_data e
    WHERE e.date_taken >= ? AND e.date_taken <= ?
      AND e.camera_model LIKE '%Sony%'
      AND e.iso >= 100 AND e.iso <= 1600
    LIMIT 100
  `).all(
    new Date("2024-01-01").getTime(),
    new Date("2024-12-31").getTime()
  );
}));

// ── 场景 10: 颜色搜索 (UDF) ───────────────────────────────────────────────

// Register closest_color_dist UDF (simulating the real one)
db.function("closest_color_dist", (r, g, b, colorsJson) => {
  if (!colorsJson) return Number.MAX_VALUE;
  try {
    const colors = JSON.parse(colorsJson);
    let minDist = Number.POSITIVE_INFINITY;
    for (const c of colors) {
      const dr = c.r - r, dg = c.g - g, db = c.b - b;
      const dist = dr * dr + dg * dg + db * db;
      if (dist < minDist) minDist = dist;
    }
    return minDist;
  } catch { return Number.MAX_VALUE; }
});

results.push(bench("color_search_udf (#FF6B35)", () => {
  db.prepare(`
    SELECT id, closest_color_dist(255, 107, 53, dominant_colors) AS dist
    FROM photos
    WHERE deleted_at IS NULL AND dominant_colors IS NOT NULL
      AND closest_color_dist(255, 107, 53, dominant_colors) < 10000
    ORDER BY dist ASC
    LIMIT 50
  `).all();
}));

// ── 场景 11: 颜色搜索 (hue bucket 预过滤) ─────────────────────────────────

const targetHue = rgbToHue(255, 107, 53);
const buckets = [...new Set([(targetHue + 35) % 36, targetHue, (targetHue + 1) % 36])];

results.push(bench("color_search_hue_bucket (#FF6B35)", () => {
  db.prepare(`
    SELECT id, closest_color_dist(255, 107, 53, dominant_colors) AS dist
    FROM photos
    WHERE deleted_at IS NULL AND dominant_colors IS NOT NULL
      AND (color_bucket IS NULL OR color_bucket IN (${buckets.join(",")}))
      AND closest_color_dist(255, 107, 53, dominant_colors) < 10000
    ORDER BY dist ASC
    LIMIT 50
  `).all();
}));

// ── 场景 12: 标签搜索 ─────────────────────────────────────────────────────

results.push(bench("tag_like '%风景%'", () => {
  db.prepare(`
    SELECT p.id FROM photos p
    INNER JOIN photo_tags pt ON pt.photo_id = p.id
    INNER JOIN tags t ON t.id = pt.tag_id
    WHERE p.deleted_at IS NULL AND t.name LIKE '%风景%'
    LIMIT 50
  `).all();
}));

// ── 场景 13: getStats 聚合 ────────────────────────────────────────────────

results.push(bench("getStats_counts", () => {
  db.prepare(`
    SELECT
      count(*) AS total,
      sum(case when is_ai_processed = 1 then 1 else 0 end) AS ai_processed
    FROM photos
  `).get();
}));

results.push(bench("getStats_time_aggregates", () => {
  const hourQuery = db.prepare(`
    SELECT
      COUNT(CASE WHEN CAST(strftime('%H', date_taken / 1000, 'unixepoch') AS INTEGER) = 0 THEN 1 END) AS h0
    FROM exif_data WHERE date_taken IS NOT NULL
  `).get();
  db.prepare(`
    SELECT CAST(strftime('%Y', date_taken / 1000, 'unixepoch') AS TEXT) AS year, COUNT(*) AS count
    FROM exif_data WHERE date_taken IS NOT NULL
    GROUP BY year ORDER BY year
  `).all();
  db.prepare(`
    SELECT MIN(date_taken) AS earliest, MAX(date_taken) AS latest
    FROM exif_data WHERE date_taken IS NOT NULL
  `).get();
}));

// ── 场景 14: getExifCandidates ────────────────────────────────────────────

results.push(bench("getExifCandidates (6 queries)", () => {
  db.prepare("SELECT DISTINCT camera_model FROM exif_data WHERE camera_model IS NOT NULL AND camera_model != '' ORDER BY camera_model").all();
  db.prepare("SELECT lens_model FROM exif_data WHERE lens_model IS NOT NULL AND lens_model != '' GROUP BY lens_model ORDER BY count(*) DESC").all();
  db.prepare("SELECT DISTINCT CAST(ROUND(focal_length_num, 0) AS TEXT) FROM exif_data WHERE focal_length_num IS NOT NULL ORDER BY ROUND(focal_length_num, 0)").all();
  db.prepare("SELECT DISTINCT ROUND(aperture, 1) FROM exif_data WHERE aperture IS NOT NULL ORDER BY ROUND(aperture, 1)").all();
  db.prepare("SELECT DISTINCT iso FROM exif_data WHERE iso IS NOT NULL ORDER BY iso").all();
  db.prepare("SELECT DISTINCT format FROM photos WHERE format IS NOT NULL AND format != '' ORDER BY format").all();
}));

// ── 场景 15: COUNT 查询 ──────────────────────────────────────────────────

results.push(bench("count_photos", () => {
  db.prepare("SELECT count(*) AS c FROM photos WHERE deleted_at IS NULL").get();
}));

results.push(bench("count_with_tag_filter", () => {
  db.prepare(`
    SELECT count(*) AS c FROM photos
    WHERE deleted_at IS NULL
      AND id IN (SELECT pt.photo_id FROM photo_tags pt WHERE pt.tag_id IN (1, 2, 3))
  `).get();
}));

// ── 场景 16: 人脸搜索 ────────────────────────────────────────────────────

results.push(bench("face_identity_like", () => {
  db.prepare(`
    SELECT p.id FROM photos p
    INNER JOIN face_vectors fv ON fv.photo_id = p.id
    INNER JOIN face_identity_members fim ON fim.face_vector_id = fv.id
    INNER JOIN face_identities fi ON fi.id = fim.identity_id
    WHERE p.deleted_at IS NULL AND fi.name LIKE '%test%'
    LIMIT 50
  `).all();
}));

// ── 场景 17: 智能相册 ────────────────────────────────────────────────────

results.push(bench("smart_album_composite", () => {
  // 模拟多规则求值：日期 + 相机 + 镜头
  const dateRangeIds = db.prepare(`
    SELECT photo_id FROM exif_data
    WHERE date_taken >= ? AND date_taken <= ?
  `).all(
    new Date("2024-01-01").getTime(),
    new Date("2024-12-31").getTime()
  ).map(r => r.photo_id).filter(Boolean);

  const cameraIds = db.prepare(`
    SELECT photo_id FROM exif_data
    WHERE camera_model LIKE '%Sony%'
  `).all().map(r => r.photo_id).filter(Boolean);

  // JS intersect
  const camSet = new Set(cameraIds);
  dateRangeIds.filter(id => camSet.has(id));
}));

// ── 报告 ──────────────────────────────────────────────────────────────────

db.close();

console.log("\n╔══════════════════════════════════════════════════════════════════════════════╗");
console.log("║                           BENCHMARK RESULTS                                  ║");
console.log("╠══════════════════════════════════════════════════════════════════════════════╣");

const nameWidth = 42;
const p50Width = 12;
const p95Width = 12;
const fmt = (v) => String(v).padStart(p50Width);

console.log(`║ ${"Scenario".padEnd(nameWidth)}${fmt("P50(ms)")}${fmt("P95(ms)")} ║`);
console.log("╟──────────────────────────────────────────────────────────────────────────────╢");

for (const r of results) {
  console.log(
    `║ ${r.scenario.padEnd(nameWidth)}${String(r.p50_ms).padStart(p50Width)}${String(r.p95_ms).padStart(p95Width)} ║`
  );
}

console.log("╚══════════════════════════════════════════════════════════════════════════════╝");

// 输出 JSON 用于自动化对比
console.log("\n// JSON output for CI comparison:");
console.log(JSON.stringify(results, null, 2));
