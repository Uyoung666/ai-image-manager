import assert from "node:assert/strict";
import test from "node:test";
import { evaluateSemanticRun } from "../evaluate-semantic-quality.mjs";
import {
  buildRunSummary,
  renderSummaryMarkdown,
} from "../summarize-siglip-v1-baseline.mjs";
import { summarizeDistribution } from "./statistics.mjs";

test("quality metrics support multiple relevant samples and hard negatives", () => {
  const result = evaluateSemanticRun(
    {
      version: "test-v1",
      queries: [
        {
          id: "multi-relevant",
          category: "semantic",
          intent: "verify ranking metrics",
          query: "two relevant samples",
          relevantContentHashes: ["relevant-a", "relevant-b"],
          hardNegativeContentHashes: ["hard-negative"],
        },
      ],
      errorCategoryByContentHash: {
        "hard-negative": "hard-negative",
      },
    },
    {
      queries: [
        {
          id: "multi-relevant",
          results: ["relevant-b", "hard-negative", "relevant-a"],
          latencyPhases: {
            textEncodingMs: 40,
            scoringMs: 1200,
            filteringMs: 20,
            sortingMs: 13,
            endToEndSearchMs: 1273,
          },
        },
      ],
    }
  );

  assert.equal(result.macro.hitAt1, 1);
  assert.equal(result.macro.hitAt3, 1);
  assert.equal(result.macro.meanReciprocalRank, 1);
  assert.equal(result.macro.recallAt5, 1);
  assert.equal(result.macro.fixedCutoffPrecisionAt5, 0.4);
  assert.equal(result.macro.precisionAt20, 2 / 3);
  assert.equal(result.macro.hardNegativeFalsePositiveRateAt3, 1);
  assert.equal(
    result.metricSemantics.hardNegativeFalsePositiveRate.direction,
    "lower-is-better"
  );
  assert.equal(result.returnedCountDistribution.histogram["3"], 1);
  assert.equal(result.latencyPhases.textEncodingMs.median, 40);
  assert.equal(result.latencyPhases.endToEndSearchMs.median, 1273);
  assert.equal(
    result.metricSemantics.precisionAt20.status,
    "legacy-nonstandard"
  );
});

test("distribution aggregation records requested robust statistics", () => {
  assert.deepEqual(summarizeDistribution([10, 20, 30, 40, 50]), {
    count: 5,
    min: 10,
    p5: 12,
    p50: 30,
    median: 30,
    p95: 48,
    max: 50,
    range: 40,
    method: "linear-interpolation-r7",
  });
});

test("identical standard and high configurations prohibit advantage claims", () => {
  const makeReport = (profileId) => ({
    reportType: "performance",
    performanceProfile: {
      profileId,
      requested: { workers: 2, threadsPerWorker: 4 },
      actual: { workers: 1, threadsPerWorker: 4 },
      comparisonClassification: "same-configuration-repeat",
    },
    metrics: {
      trialCount: 3,
      errorsTotal: 0,
      phaseAggregates: {
        imageModelLoadMs: { median: 1 },
        firstImageInferenceMs: { median: 1 },
        hotSingleImageMs: { median: 1 },
        batchThroughputPerSecond: { median: 1 },
        textEncodingMs: { median: 1 },
        observedPeakProcessMemoryBytes: { max: 1 },
      },
    },
    resourceObservations: {
      memory: { observedPeakCombinedRssBytes: { max: 1 } },
      temperature: {
        status: "unavailable",
        unavailableReasons: ["sensor unavailable"],
      },
    },
  });
  const summary = buildRunSummary(
    {
      runId: "test-run",
      createdAt: "2026-08-08T00:00:00.000Z",
      adapter: {},
      definitions: {},
      environment: { nodeBaselineStatus: "supported" },
      trialPlan: {},
      rawTrials: [],
    },
    [makeReport("standard"), makeReport("high")]
  );

  assert.equal(
    summary.comparisons.standardVsHigh.classification,
    "same-configuration-repeat"
  );
  assert.equal(summary.comparisons.standardVsHigh.claimAllowed, false);
  assert.equal(summary.comparisons.standardVsHigh.measuredDelta, null);
  assert.equal(summary.generatedAt, "2026-08-08T00:00:00.000Z");
  const markdown = renderSummaryMarkdown(summary);
  assert.ok(
    markdown.includes("Text encoding is only the worker encoding request")
  );
  assert.ok(markdown.includes("Do not edit"));
});
