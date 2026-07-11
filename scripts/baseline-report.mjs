/**
 * Generate a lightweight optimization baseline report.
 *
 * Run:
 *   npm run perf:baseline
 *
 * The report is intentionally self-contained: it does not start Electron and
 * does not require a photo library. It captures repository size, key source
 * hot spots, dependency/resource footprint, and the local runtime environment
 * so later performance work has a stable before/after reference.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const reportDir = path.join(projectRoot, "reports");

const IGNORED_DIRS = new Set([
  ".git",
  ".vite",
  "dist",
  "node_modules",
  "out",
  "playwright-report",
  "test-results",
]);

const HOTSPOT_EXTENSIONS = new Set([
  ".css",
  ".json",
  ".mjs",
  ".mts",
  ".ts",
  ".tsx",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = units.shift();
  while (value >= 1024 && units.length > 0) {
    value /= 1024;
    unit = units.shift();
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${unit}`;
}

function tryGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function walkFiles(rootDir, options = {}) {
  const {
    includeAll = false,
    ignoredDirs = IGNORED_DIRS,
    onDirectory,
  } = options;
  const files = [];

  function walk(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    onDirectory?.(dir);

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!includeAll && ignoredDirs.has(entry.name)) {
          continue;
        }
        walk(fullPath);
        continue;
      }
      if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(rootDir);
  return files;
}

function summarizeFiles(rootDir) {
  const start = performance.now();
  let directoryCount = 0;
  const files = walkFiles(rootDir, {
    onDirectory: () => {
      directoryCount += 1;
    },
  });
  const durationMs = performance.now() - start;

  const byExtension = new Map();
  let totalBytes = 0;
  const hotFiles = [];

  for (const file of files) {
    const stat = fs.statSync(file);
    const ext = path.extname(file).toLowerCase() || "(none)";
    totalBytes += stat.size;

    const prev = byExtension.get(ext) ?? { bytes: 0, files: 0 };
    prev.bytes += stat.size;
    prev.files += 1;
    byExtension.set(ext, prev);

    if (HOTSPOT_EXTENSIONS.has(ext)) {
      hotFiles.push({
        bytes: stat.size,
        path: path.relative(projectRoot, file).replace(/\\/g, "/"),
      });
    }
  }

  return {
    directoryCount,
    durationMs: Number(durationMs.toFixed(2)),
    fileCount: files.length,
    totalBytes,
    byExtension: [...byExtension.entries()]
      .map(([extension, value]) => ({ extension, ...value }))
      .sort((a, b) => b.bytes - a.bytes),
    largestHotFiles: hotFiles.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  };
}

function directorySize(relativePath) {
  const dir = path.join(projectRoot, relativePath);
  if (!fs.existsSync(dir)) {
    return null;
  }
  const files = walkFiles(dir, { includeAll: true, ignoredDirs: new Set() });
  let bytes = 0;
  for (const file of files) {
    bytes += fs.statSync(file).size;
  }
  return {
    bytes,
    files: files.length,
    path: relativePath,
  };
}

function countTestFiles() {
  const testRoot = path.join(projectRoot, "src", "tests");
  if (!fs.existsSync(testRoot)) {
    return [];
  }

  const result = new Map();
  for (const file of walkFiles(testRoot)) {
    const relative = path.relative(testRoot, file).replace(/\\/g, "/");
    const suite = relative.split("/")[0] ?? "unknown";
    const prev = result.get(suite) ?? 0;
    result.set(suite, prev + 1);
  }
  return [...result.entries()].map(([suite, files]) => ({ suite, files }));
}

function generateMarkdown(report) {
  const lines = [];
  lines.push("# AI Image Manager Performance Baseline");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(
    `Git: ${report.git.branch ?? "unknown"} @ ${report.git.commit ?? "unknown"}`
  );
  lines.push("");
  lines.push("## Runtime");
  lines.push("");
  lines.push(`- Node: ${report.runtime.node}`);
  lines.push(`- Platform: ${report.runtime.platform} ${report.runtime.arch}`);
  lines.push(
    `- CPU: ${report.runtime.cpuModel} (${report.runtime.cpuCount} logical cores)`
  );
  lines.push(`- Memory: ${formatBytes(report.runtime.totalMemoryBytes)}`);
  lines.push("");
  lines.push("## Repository Footprint");
  lines.push("");
  lines.push(`- Files scanned: ${report.source.fileCount}`);
  lines.push(`- Directories scanned: ${report.source.directoryCount}`);
  lines.push(`- Source footprint: ${formatBytes(report.source.totalBytes)}`);
  lines.push(`- Scan time: ${report.source.durationMs} ms`);
  lines.push("");
  lines.push("## Largest Source Hotspots");
  lines.push("");
  lines.push("| File | Size |");
  lines.push("| --- | ---: |");
  for (const item of report.source.largestHotFiles.slice(0, 12)) {
    lines.push(`| ${item.path} | ${formatBytes(item.bytes)} |`);
  }
  lines.push("");
  lines.push("## Dependency And Resource Footprint");
  lines.push("");
  lines.push(`- Dependencies: ${report.package.dependencyCount}`);
  lines.push(`- Dev dependencies: ${report.package.devDependencyCount}`);
  for (const item of report.resources) {
    lines.push(
      `- ${item.path}: ${formatBytes(item.bytes)} (${item.files} files)`
    );
  }
  lines.push("");
  lines.push("## Tests");
  lines.push("");
  if (report.tests.length === 0) {
    lines.push("- No tests found under src/tests.");
  } else {
    for (const item of report.tests) {
      lines.push(`- ${item.suite}: ${item.files} files`);
    }
  }
  lines.push("");
  lines.push("## Suggested Tracking Commands");
  lines.push("");
  lines.push("```bash");
  lines.push("npm run perf:baseline");
  lines.push("npm test");
  lines.push("npm run check");
  lines.push("```");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function main() {
  const pkg = readJson(path.join(projectRoot, "package.json"));
  const report = {
    generatedAt: new Date().toISOString(),
    git: {
      branch: tryGit(["branch", "--show-current"]),
      commit: tryGit(["rev-parse", "--short", "HEAD"]),
      dirty: Boolean(tryGit(["status", "--short"])),
    },
    package: {
      name: pkg.name,
      version: pkg.version,
      dependencyCount: Object.keys(pkg.dependencies ?? {}).length,
      devDependencyCount: Object.keys(pkg.devDependencies ?? {}).length,
      scripts: Object.keys(pkg.scripts ?? {}),
    },
    resources: ["assets", "models", "drizzle", "screenshots", "src/assets"]
      .map(directorySize)
      .filter(Boolean),
    runtime: {
      arch: process.arch,
      cpuCount: os.cpus().length,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      node: process.version,
      platform: process.platform,
      totalMemoryBytes: os.totalmem(),
    },
    source: summarizeFiles(projectRoot),
    tests: countTestFiles(),
  };

  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = report.generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `perf-baseline-${stamp}.json`);
  const markdownPath = path.join(reportDir, `perf-baseline-${stamp}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(markdownPath, generateMarkdown(report));

  console.log("Performance baseline generated:");
  console.log(`  JSON: ${path.relative(projectRoot, jsonPath)}`);
  console.log(`  MD:   ${path.relative(projectRoot, markdownPath)}`);
}

main();
