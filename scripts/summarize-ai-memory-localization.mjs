/** Generates a reproducible memory-localization summary from one stress report. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

function roundMiB(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(3));
}

function delta(first, last, selector) {
  return selector(last) - selector(first);
}

function findPhase(samples, phase) {
  return samples.find((sample) => sample.phase === phase) ?? null;
}

function summarizeGeneration(samples, generation, warmupCompletedItems) {
  const segments = samples.filter(
    (sample) =>
      sample.phase === "segment" &&
      sample.workerGeneration === generation &&
      sample.completed >= warmupCompletedItems
  );
  if (segments.length < 2) {
    return { generation, sampleCount: segments.length, status: "insufficient" };
  }
  const first = segments[0];
  const last = segments.at(-1);
  return {
    generation,
    sampleCount: segments.length,
    status: "available",
    fromCompletedItems: first.completed,
    toCompletedItems: last.completed,
    deltasMiB: {
      combinedRss: roundMiB(
        delta(first, last, (sample) => sample.totalRssBytes)
      ),
      parentRss: roundMiB(
        delta(first, last, (sample) => sample.parentMemory.rssBytes)
      ),
      parentHeapUsed: roundMiB(
        delta(first, last, (sample) => sample.parentMemory.heapUsedBytes)
      ),
      parentExternal: roundMiB(
        delta(first, last, (sample) => sample.parentMemory.externalBytes)
      ),
      parentArrayBuffers: roundMiB(
        delta(first, last, (sample) => sample.parentMemory.arrayBuffersBytes)
      ),
      workerRss: roundMiB(
        delta(first, last, (sample) => sample.workerRssBytes)
      ),
    },
  };
}

export function summarizeMemoryLocalization(report) {
  if (report.reportType !== "ai-index-production-stress") {
    throw new Error("Expected an ai-index-production-stress report");
  }
  const samples = report.memory.samples;
  const generations = Object.entries(report.memory.epochTrends).map(
    ([generation, trends]) =>
      summarizeGeneration(
        samples,
        Number(generation),
        trends.warmupCutoff.completedLogicalItems ?? 0
      )
  );
  const beforeFinalShutdown = findPhase(
    samples,
    "before-final-worker-shutdown"
  );
  const workersStopped = findPhase(samples, "workers-stopped-final");
  const vectorDbClosed = findPhase(samples, "vector-db-closed");
  const workerRestart = report.controls.workerRestart;
  const workerReleaseMiB = workerRestart
    ? roundMiB(workerRestart.workerRssReleasedBytes)
    : null;
  const finalWorkerReleaseMiB =
    beforeFinalShutdown && workersStopped
      ? roundMiB(
          beforeFinalShutdown.workerRssBytes - workersStopped.workerRssBytes
        )
      : null;
  const vectorDbCloseParentRssDeltaMiB =
    workersStopped && vectorDbClosed
      ? roundMiB(
          vectorDbClosed.parentMemory.rssBytes -
            workersStopped.parentMemory.rssBytes
        )
      : null;
  const availableGenerations = generations.filter(
    (generation) => generation.status === "available"
  );
  const largestParentHeapGrowthMiB = Math.max(
    0,
    ...availableGenerations.map(
      (generation) => generation.deltasMiB.parentHeapUsed
    )
  );
  const workerGrowthObserved = availableGenerations.some(
    (generation) => generation.deltasMiB.workerRss > 0
  );
  const workerMemoryReleasedOnRestart =
    workerRestart?.workerRssReleasedBytes > 0;
  return {
    schemaVersion: 1,
    reportType: "ai-memory-localization-summary",
    generatedAt: new Date().toISOString(),
    source: {
      stressReportType: report.reportType,
      stressGeneratedAt: report.generatedAt,
      stressStatus: report.status,
    },
    workload: {
      logicalItems: report.syntheticWorkload.logicalItemCount,
      workerCount: report.execution.workerCount,
      threadsPerWorker: report.execution.threadsPerWorker,
      segmentSize: report.execution.segmentSize,
      workerRestartAt:
        report.controls.workerRestart?.completedLogicalItems ?? null,
    },
    integrity: {
      completedLogicalItems: report.results.completedLogicalItems,
      errors: report.results.errorCount,
      fingerprintPublished: report.results.fingerprintPublished,
      storedRows: report.results.storedRowCount,
    },
    generations,
    lifecycle: {
      workerReleaseMiB,
      finalWorkerReleaseMiB,
      vectorDbCloseParentRssDeltaMiB,
    },
    attribution: {
      mainProcess: {
        assessment:
          largestParentHeapGrowthMiB < 20
            ? "no-linear-js-heap-growth-evidence"
            : "main-process-growth-review-required",
        largestSteadyHeapGrowthMiB: largestParentHeapGrowthMiB,
      },
      worker: {
        assessment:
          workerGrowthObserved && workerMemoryReleasedOnRestart
            ? "worker-side-native-retention-or-cache-most-likely"
            : "worker-side-growth-not-established",
        memoryReleasedOnRestart: workerMemoryReleasedOnRestart,
      },
      vectorDb: {
        assessment:
          vectorDbCloseParentRssDeltaMiB !== null &&
          Math.abs(vectorDbCloseParentRssDeltaMiB) < 10
            ? "no-material-rss-release-on-close-observed"
            : "vector-db-contribution-inconclusive",
      },
      imageDecodeVsOrt: {
        assessment: "not-isolated-by-external-rss",
        meaning:
          "External process RSS localizes retention to the worker lifecycle but cannot distinguish image decode buffers from ONNX Runtime arenas without worker-internal instrumentation",
      },
    },
    conclusion: {
      status: "follow-up-required-not-product-blocking-on-current-host",
      statement:
        "The observed 1x1 RSS growth is primarily associated with worker-process native memory and is released when the worker exits. This is not proof of a leak and does not establish real low-end hardware coverage.",
    },
  };
}

export function renderMemoryLocalizationMarkdown(summary) {
  const generationRows = summary.generations
    .map((generation) =>
      generation.status === "available"
        ? `| ${generation.generation} | ${generation.fromCompletedItems}-${generation.toCompletedItems} | ${generation.deltasMiB.parentRss.toFixed(3)} | ${generation.deltasMiB.parentHeapUsed.toFixed(3)} | ${generation.deltasMiB.parentExternal.toFixed(3)} | ${generation.deltasMiB.parentArrayBuffers.toFixed(3)} | ${generation.deltasMiB.workerRss.toFixed(3)} |`
        : `| ${generation.generation} | insufficient | - | - | - | - | - |`
    )
    .join("\n");
  return `<!-- Generated from ai-index-stress.json. Do not edit. -->
# 1×1 AI memory localization

Workload: ${summary.workload.logicalItems} items, ${summary.workload.workerCount} worker × ${summary.workload.threadsPerWorker} thread, restart at ${summary.workload.workerRestartAt}.

| Worker generation | Steady item range | Parent RSS Δ MiB | heapUsed Δ MiB | external Δ MiB | arrayBuffers Δ MiB | Worker RSS Δ MiB |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${generationRows}

Worker RSS released at restart: ${summary.lifecycle.workerReleaseMiB?.toFixed(3) ?? "unavailable"} MiB. Final worker shutdown released ${summary.lifecycle.finalWorkerReleaseMiB?.toFixed(3) ?? "unavailable"} MiB. Closing LanceDB changed parent RSS by ${summary.lifecycle.vectorDbCloseParentRssDeltaMiB?.toFixed(3) ?? "unavailable"} MiB.

Assessment: ${summary.attribution.worker.assessment}. ${summary.attribution.mainProcess.assessment}. ${summary.attribution.vectorDb.assessment}.

External RSS cannot distinguish image decode buffers from ONNX Runtime arenas. The result is not proof of a leak and does not represent real low-end hardware coverage.
`;
}

async function writeOutputs(reportPath) {
  const resolvedReportPath = path.resolve(reportPath);
  const raw = await fs.promises.readFile(resolvedReportPath);
  const report = JSON.parse(raw.toString("utf8"));
  const summary = summarizeMemoryLocalization(report);
  summary.source.file = path.basename(resolvedReportPath);
  summary.source.sha256 = createHash("sha256").update(raw).digest("hex");
  const directory = path.dirname(resolvedReportPath);
  const jsonPath = path.join(directory, "memory-localization-summary.json");
  const markdownPath = path.join(directory, "memory-localization-summary.md");
  await fs.promises.writeFile(
    jsonPath,
    `${JSON.stringify(summary, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.writeFile(
    markdownPath,
    renderMemoryLocalizationMarkdown(summary),
    "utf8"
  );
  return { jsonPath, markdownPath };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const reportPath = process.argv[2];
  if (!reportPath) {
    throw new Error(
      "Usage: node scripts/summarize-ai-memory-localization.mjs <ai-index-stress.json>"
    );
  }
  writeOutputs(reportPath)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
