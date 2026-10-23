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
    throw new Error(
      "需要有效的采集 JSON 路径；先运行 npm run perf:gallery:auto。空采样不能生成成功报告。"
    );
  }
  const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));
  const runs = input.results ?? [input];
  for (const run of runs) {
    if (
      !(
        run.datasetCount > 0 &&
        run.loaded > 0 &&
        run.galleryPerf?.firstViewport80Ms?.count > 0 &&
        run.galleryPerf.firstViewport80Ms.total > 0 &&
        run.galleryPerf?.scrollStop95Ms?.count > 0 &&
        run.galleryPerf.scrollStop95Ms.total > 0 &&
        run.galleryPerf?.frameIntervalMs?.count > 0 &&
        run.galleryPerf.frameIntervalMs.total > 0
      )
    ) {
      throw new Error(
        "无效样本：未验证图库数据量、有效图片、首屏、停止滚动补齐或实际帧间隔。"
      );
    }
  }
  if (runs.length === 1) {
    return runs[0];
  }
  const combined = {};
  for (const run of runs) {
    for (const [name, bucket] of Object.entries(run.galleryPerf)) {
      const target = combined[name] ?? {
        count: 0,
        total: 0,
        max: 0,
        samples: [],
      };
      target.count += bucket.count;
      target.total += bucket.total;
      target.max = Math.max(target.max, bucket.max);
      target.samples.push(...(bucket.samples ?? []));
      combined[name] = target;
    }
  }
  return { ...runs[0], galleryPerf: combined, runCount: runs.length };
}

function normalizeBucket(bucket) {
  const count = Number(bucket?.count ?? 0);
  const total = Number(bucket?.total ?? 0);
  const max = Number(bucket?.max ?? 0);
  const samples = (bucket?.samples ?? [])
    .filter(Number.isFinite)
    .sort((a, b) => a - b);
  const percentile = (ratio) =>
    samples.length
      ? Number(
          samples[
            Math.min(
              samples.length - 1,
              Math.max(0, Math.ceil(samples.length * ratio) - 1)
            )
          ].toFixed(3)
        )
      : null;
  return {
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
    sampleCount: samples.length,
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
  lines.push("| Metric | Count | Avg | P50 | P95 | P99 | Max |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [name, bucket] of Object.entries(report.galleryPerf)) {
    lines.push(
      `| ${name} | ${formatNumber(bucket.count)} | ${formatNumber(bucket.avg)} | ${bucket.p50 ?? "n/a"} | ${bucket.p95 ?? "n/a"} | ${bucket.p99 ?? "n/a"} | ${formatNumber(bucket.max)} |`
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
    "- frameIntervalMs records actual animation frames; masonryScrollFrameMs records only scroll callback work. Percentiles use up to 2048 retained samples per metric/run."
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
    datasetCount: snapshot.datasetCount,
    runCount: snapshot.runCount ?? 1,
    build: snapshot.build,
    bundleHash: snapshot.bundleHash,
    sourceCommit: snapshot.sourceCommit,
    sourceDiffHash: snapshot.sourceDiffHash,
    viewport: snapshot.viewport,
    cache: snapshot.cache,
    memory: snapshot.memory,
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
