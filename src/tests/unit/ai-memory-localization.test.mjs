import assert from "node:assert/strict";
import { it } from "vitest";
import {
  renderMemoryLocalizationMarkdown,
  summarizeMemoryLocalization,
} from "../../../scripts/summarize-ai-memory-localization.mjs";

const noLeakProofRegex = /not proof of a leak/u;
const mebibyte = 1024 * 1024;

function memorySample(completed, generation, phase, parentRss, workerRss) {
  const parentRssBytes = parentRss * mebibyte;
  return {
    completed,
    parentMemory: {
      arrayBuffersBytes: parentRssBytes / 20,
      externalBytes: parentRssBytes / 10,
      heapUsedBytes: parentRssBytes / 5,
      rssBytes: parentRssBytes,
    },
    phase,
    totalRssBytes: parentRssBytes + workerRss * mebibyte,
    workerGeneration: generation,
    workerRssBytes: workerRss * mebibyte,
  };
}

it("memory localization attributes restart-released RSS to the worker", () => {
  const samples = [
    memorySample(0, 1, "workers-ready", 100, 200),
    memorySample(100, 1, "segment", 105, 220),
    memorySample(200, 1, "segment", 110, 240),
    memorySample(200, 1, "workers-stopped-for-restart", 110, 0),
    memorySample(200, 2, "workers-restarted", 110, 190),
    memorySample(300, 2, "segment", 115, 200),
    memorySample(400, 2, "segment", 120, 210),
    memorySample(400, 2, "before-final-worker-shutdown", 120, 210),
    memorySample(400, 2, "workers-stopped-final", 120, 0),
    memorySample(400, 2, "vector-db-closed", 121, 0),
  ];
  const summary = summarizeMemoryLocalization({
    controls: {
      workerRestart: {
        completedLogicalItems: 200,
        workerRssReleasedBytes: 240 * mebibyte,
      },
    },
    environment: {},
    execution: { segmentSize: 100, threadsPerWorker: 1, workerCount: 1 },
    generatedAt: "2026-08-08T00:00:00.000Z",
    memory: {
      epochTrends: {
        1: { warmupCutoff: { completedLogicalItems: 100 } },
        2: { warmupCutoff: { completedLogicalItems: 300 } },
      },
      samples,
    },
    reportType: "ai-index-production-stress",
    results: {
      completedLogicalItems: 400,
      errorCount: 0,
      fingerprintPublished: true,
      storedRowCount: 400,
    },
    status: "complete",
    syntheticWorkload: { logicalItemCount: 400 },
  });

  assert.equal(
    summary.attribution.worker.assessment,
    "worker-side-native-retention-or-cache-most-likely"
  );
  assert.equal(
    summary.attribution.imageDecodeVsOrt.assessment,
    "not-isolated-by-external-rss"
  );
  assert.match(renderMemoryLocalizationMarkdown(summary), noLeakProofRegex);
});
