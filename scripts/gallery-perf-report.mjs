/**
 * Generate a gallery browsing performance report from runtime counters.
 *
 * Usage:
 *   npm run perf:gallery
 *   npm run perf:gallery -- path/to/snapshot.json
 *
 * Snapshot format:
 * {
 *   "scenario": "10k-fast-scroll",
 *   "galleryPerf": window.__galleryPerf,
 *   "galleryMediaStats": globalThis.__galleryMediaStats
 * }
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const reportDir = path.join(projectRoot, "reports");
const inputPath = process.argv[2] ? path.resolve(process.argv[2]) : null;

function readSnapshot() {
  if (!inputPath) {
    return {
      galleryMediaStats: {},
      galleryPerf: {},
      notes: [
        "No snapshot file was provided. Run this after exporting runtime counters from a dev session.",
      ],
      scenario: "manual-gallery-browsing",
    };
  }
  return JSON.parse(fs.readFileSync(inputPath, "utf8"));
}

function normalizeBucket(bucket) {
  const count = Number(bucket?.count ?? 0);
  const total = Number(bucket?.total ?? 0);
  const max = Number(bucket?.max ?? 0);
  return {
    avg: count > 0 ? Number((total / count).toFixed(3)) : 0,
    count,
    max: Number(max.toFixed(3)),
    total: Number(total.toFixed(3)),
  };
}

function summarizePerf(galleryPerf) {
  return Object.fromEntries(
    Object.entries(galleryPerf ?? {})
      .map(([name, bucket]) => [name, normalizeBucket(bucket)])
      .sort(([a], [b]) => a.localeCompare(b))
  );
}

function summarizeMedia(stats) {
  const thumbnailRequest = Number(stats?.thumbnailRequest ?? 0);
  const thumbnailHit = Number(stats?.thumbnailHit ?? 0);
  const thumbnailRegenerate = Number(stats?.thumbnailRegenerate ?? 0);
  return {
    thumbnailHit,
    thumbnailHitRate:
      thumbnailRequest > 0
        ? Number(((thumbnailHit / thumbnailRequest) * 100).toFixed(2))
        : 0,
    thumbnailRegenerate,
    thumbnailRequest,
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 3,
  }).format(value);
}

function generateMarkdown(report) {
  const lines = [];
  lines.push("# Gallery Browsing Performance Report");
  lines.push("");
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Scenario: ${report.scenario}`);
  lines.push("");
  lines.push("## Runtime");
  lines.push("");
  lines.push(`- Node: ${report.runtime.node}`);
  lines.push(`- Platform: ${report.runtime.platform} ${report.runtime.arch}`);
  lines.push(`- CPU: ${report.runtime.cpuModel}`);
  lines.push("");
  lines.push("## Renderer Counters");
  lines.push("");
  lines.push("| Metric | Count | Avg | Max | Total |");
  lines.push("| --- | ---: | ---: | ---: | ---: |");
  for (const [name, bucket] of Object.entries(report.galleryPerf)) {
    lines.push(
      `| ${name} | ${formatNumber(bucket.count)} | ${formatNumber(bucket.avg)} | ${formatNumber(bucket.max)} | ${formatNumber(bucket.total)} |`
    );
  }
  if (Object.keys(report.galleryPerf).length === 0) {
    lines.push("| No renderer counters | 0 | 0 | 0 | 0 |");
  }
  lines.push("");
  lines.push("## Thumbnail Counters");
  lines.push("");
  lines.push(
    `- Requests: ${formatNumber(report.galleryMedia.thumbnailRequest)}`
  );
  lines.push(`- Cache hits: ${formatNumber(report.galleryMedia.thumbnailHit)}`);
  lines.push(`- Hit rate: ${report.galleryMedia.thumbnailHitRate}%`);
  lines.push(
    `- Regenerated thumbnails: ${formatNumber(report.galleryMedia.thumbnailRegenerate)}`
  );
  if (report.notes.length > 0) {
    lines.push("");
    lines.push("## Notes");
    lines.push("");
    for (const note of report.notes) {
      lines.push(`- ${note}`);
    }
  }
  lines.push("");
  lines.push("## Capture Checklist");
  lines.push("");
  lines.push("- Record dataset size: 1K / 10K / 100K.");
  lines.push("- Scroll for 60 seconds with normal and fast wheel gestures.");
  lines.push("- Navigate away and back once to verify restoration stability.");
  lines.push("- Select 1 photo and marquee-select about 100 photos.");
  lines.push(
    "- Compare masonryScrollFrameMs avg/max and masonryVisibleItems max."
  );
  return `${lines.join("\n")}\n`;
}

function main() {
  const snapshot = readSnapshot();
  const generatedAt = new Date().toISOString();
  const report = {
    galleryMedia: summarizeMedia(snapshot.galleryMediaStats),
    galleryPerf: summarizePerf(snapshot.galleryPerf),
    generatedAt,
    notes: Array.isArray(snapshot.notes) ? snapshot.notes : [],
    runtime: {
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model ?? "unknown",
      node: process.version,
      platform: process.platform,
    },
    scenario: snapshot.scenario ?? "manual-gallery-browsing",
  };

  fs.mkdirSync(reportDir, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, "-");
  const jsonPath = path.join(reportDir, `gallery-perf-${stamp}.json`);
  const mdPath = path.join(reportDir, `gallery-perf-${stamp}.md`);
  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(mdPath, generateMarkdown(report));
  console.log(`Wrote ${path.relative(projectRoot, jsonPath)}`);
  console.log(`Wrote ${path.relative(projectRoot, mdPath)}`);
}

main();
