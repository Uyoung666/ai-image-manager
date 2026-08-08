/**
 * Regenerates aggregate reports and human-readable summary from raw trial JSON.
 * Raw JSON files referenced by run-index.json are the only measurement facts.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  pickMedianTrial,
  summarizeDistribution,
  summarizeIntegerDistribution,
} from "./siglip-v1-baseline/statistics.mjs";

const latencyPhaseNames = [
  "textEncodingMs",
  "scoringMs",
  "filteringMs",
  "sortingMs",
  "endToEndSearchMs",
];

const canonicalQualityMetricNames = [
  "hitAt1",
  "hitAt3",
  "hitAt5",
  "hitAt10",
  "meanReciprocalRank",
  "recallAt5",
  "recallAt10",
  "fixedCutoffPrecisionAt5",
  "fixedCutoffPrecisionAt10",
  "fixedCutoffPrecisionAt20",
  "fixedCutoffPrecisionAt50",
  "hardNegativeFalsePositiveRateAt1",
  "hardNegativeFalsePositiveRateAt3",
  "hardNegativeFalsePositiveRateAt5",
  "hardNegativeFalsePositiveRateAt10",
  "hardNegativeQueryCount",
  "ndcgAt50",
];

const legacyQualityMetricNames = [
  "precisionAt20",
  "precisionAt50",
  "recallAt50",
  "recallAt200",
  "ndcgAt50",
  "p95LatencyMs",
  "emptyResultRate",
];

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rename(temporaryPath, filePath);
}

async function writeText(filePath, value) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(temporaryPath, value, "utf8");
  await fs.promises.rename(temporaryPath, filePath);
}

function requireTrials(trials, label) {
  if (trials.length === 0) {
    throw new Error(`No raw trials found for ${label}`);
  }
}

function mergeVectorValidation(trials, kind) {
  const validations = trials.map(
    (trial) => trial.metrics[kind].vectorValidation
  );
  return {
    expectedDimensions: validations[0].expectedDimensions,
    observedDimensions: [
      ...new Set(
        validations.flatMap((validation) => validation.observedDimensions)
      ),
    ].sort((left, right) => left - right),
    minimumL2Norm: Math.min(
      ...validations.map((validation) => validation.minimumL2Norm)
    ),
    maximumL2Norm: Math.max(
      ...validations.map((validation) => validation.maximumL2Norm)
    ),
    meanL2Norm: summarizeDistribution(
      validations.map((validation) => validation.meanL2Norm)
    ).median,
    fingerprintCorrect: validations.every(
      (validation) => validation.fingerprintCorrect
    ),
    adapterIdCorrect: validations.every(
      (validation) => validation.adapterIdCorrect
    ),
    allVectorsValid: validations.every(
      (validation) => validation.allVectorsValid
    ),
  };
}

function aggregateTemperature(trials) {
  const observations = trials.flatMap((trial) => [
    trial.resourceObservations.temperature.start,
    trial.resourceObservations.temperature.end,
  ]);
  const available = observations.filter(
    (observation) => observation.status === "available"
  );
  const unavailable = observations.filter(
    (observation) => observation.status === "unavailable"
  );
  let status = "partial";
  if (available.length === 0) {
    status = "unavailable";
  } else if (unavailable.length === 0) {
    status = "available";
  }
  return {
    status,
    celsius:
      available.length > 0
        ? summarizeDistribution(
            available.map((observation) => observation.celsius)
          )
        : null,
    sources: [
      ...new Set(observations.map((observation) => observation.source)),
    ],
    unavailableReasons: [
      ...new Set(
        unavailable.map((observation) => observation.reason).filter(Boolean)
      ),
    ],
  };
}

function aggregateRun(trials) {
  const startedAt = [...trials].map((trial) => trial.run.startedAt).sort()[0];
  const finishedAt = [...trials]
    .map((trial) => trial.run.finishedAt)
    .sort()
    .at(-1);
  return {
    startedAt,
    finishedAt,
    durationMs: trials.reduce((sum, trial) => sum + trial.run.durationMs, 0),
    errors: trials.flatMap((trial) => trial.run.errors),
  };
}

function aggregateResources(trials) {
  return {
    memory: {
      observedPeakCombinedRssBytes: summarizeDistribution(
        trials.map(
          (trial) =>
            trial.resourceObservations.memory.observedPeakCombinedRssBytes
        )
      ),
      rawTrialSamples: trials.map((trial) => ({
        trialNumber: trial.trial.trialNumber,
        samples: trial.resourceObservations.memory.samples,
      })),
    },
    temperature: aggregateTemperature(trials),
    workerProcesses: trials.map((trial) => ({
      trialNumber: trial.trial.trialNumber,
      executionOrder: trial.trial.executionOrder,
      ...trial.resourceObservations.workerProcesses,
    })),
  };
}

function addAggregationSemantics(semantics) {
  return Object.fromEntries(
    Object.entries(semantics).map(([field, value]) => [
      field,
      { ...value, aggregateValue: "median across fresh-worker trials" },
    ])
  );
}

export function aggregatePerformanceTrials(trials, rawTrialFiles = []) {
  requireTrials(trials, "performance");
  const first = trials[0];
  const phaseAggregates = {
    imageModelLoadMs: summarizeDistribution(
      trials.map((trial) => trial.metrics.phases.imageModelLoad.wallMs)
    ),
    firstImageInferenceMs: summarizeDistribution(
      trials.map((trial) => trial.metrics.phases.firstImageInference.latencyMs)
    ),
    hotSingleImageMs: summarizeDistribution(
      trials.map(
        (trial) =>
          trial.metrics.phases.hotSingleImageInference.distribution.median
      )
    ),
    batchWallMs: summarizeDistribution(
      trials.map((trial) => trial.metrics.phases.batchImageEmbedding.wallMs)
    ),
    batchThroughputPerSecond: summarizeDistribution(
      trials.map(
        (trial) => trial.metrics.phases.batchImageEmbedding.throughputPerSecond
      )
    ),
    textModelLoadMs: summarizeDistribution(
      trials.map((trial) => trial.metrics.phases.textModelLoad.wallMs)
    ),
    textEncodingMs: summarizeDistribution(
      trials.map(
        (trial) => trial.metrics.phases.textEncoding.distribution.median
      )
    ),
    observedPeakProcessMemoryBytes: summarizeDistribution(
      trials.map((trial) => trial.metrics.observedPeakProcessMemoryBytes)
    ),
    trialDurationMs: summarizeDistribution(
      trials.map((trial) => trial.run.durationMs)
    ),
  };
  const workerCount = first.performanceProfile.actual.workers;
  const perWorkerLoadMs = Array.from(
    { length: workerCount },
    (_, index) =>
      summarizeDistribution(
        trials.map((trial) => trial.metrics.image.perWorkerLoadMs[index] ?? 0)
      ).median
  );
  const imageP50 = summarizeDistribution(
    trials.map((trial) => trial.metrics.image.latencyP50Ms)
  );
  const imageP95 = summarizeDistribution(
    trials.map((trial) => trial.metrics.image.latencyP95Ms)
  );
  const textP50 = summarizeDistribution(
    trials.map((trial) => trial.metrics.text.latencyP50Ms)
  );
  const textP95 = summarizeDistribution(
    trials.map((trial) => trial.metrics.text.latencyP95Ms)
  );
  return {
    schemaVersion: 2,
    reportType: "performance",
    adapter: first.adapter,
    benchmark: first.benchmark,
    environment: first.environment,
    performanceProfile: first.performanceProfile,
    trialAggregation: {
      trialCount: trials.length,
      rawTrialFiles,
      statistic: "median",
      distributionFields: ["p5", "median", "p95", "max", "range"],
    },
    run: aggregateRun(trials),
    resourceObservations: aggregateResources(trials),
    metrics: {
      trialCount: trials.length,
      rawTrialFiles,
      phaseAggregates,
      metricSemantics: addAggregationSemantics(first.metrics.metricSemantics),
      image: {
        coldStartModelLoadMs: phaseAggregates.imageModelLoadMs.median,
        perWorkerLoadMs,
        firstImageInferenceMs: phaseAggregates.firstImageInferenceMs.median,
        hotSingleAverageMs: phaseAggregates.hotSingleImageMs.median,
        batchWallMs: phaseAggregates.batchWallMs.median,
        batchThroughputPerSecond:
          phaseAggregates.batchThroughputPerSecond.median,
        latencyP50Ms: imageP50.median,
        latencyP95Ms: imageP95.median,
        workerCount,
        threadsPerWorker: first.performanceProfile.actual.threadsPerWorker,
        errors: trials.reduce(
          (sum, trial) => sum + trial.metrics.image.errors,
          0
        ),
        vectorValidation: mergeVectorValidation(trials, "image"),
      },
      text: {
        coldStartModelLoadMs: phaseAggregates.textModelLoadMs.median,
        firstEmbeddingMs: summarizeDistribution(
          trials.map((trial) => trial.metrics.text.firstEmbeddingMs)
        ).median,
        averageEmbeddingMs: phaseAggregates.textEncodingMs.median,
        latencyP50Ms: textP50.median,
        latencyP95Ms: textP95.median,
        errors: trials.reduce(
          (sum, trial) => sum + trial.metrics.text.errors,
          0
        ),
        vectorValidation: mergeVectorValidation(trials, "text"),
      },
      errorsTotal: trials.reduce(
        (sum, trial) => sum + trial.metrics.errorsTotal,
        0
      ),
      observedPeakProcessMemoryBytes:
        phaseAggregates.observedPeakProcessMemoryBytes.max,
    },
  };
}

function aggregateMetricMap(trials, container, names) {
  return Object.fromEntries(
    names.map((name) => [
      name,
      summarizeDistribution(
        trials.map((trial) => trial.metrics[container][name])
      ),
    ])
  );
}

function aggregateErrorCategories(trials) {
  const categories = [
    ...new Set(
      trials.flatMap((trial) => Object.keys(trial.metrics.errorCategories))
    ),
  ];
  return Object.fromEntries(
    categories.map((category) => [
      category,
      summarizeDistribution(
        trials.map((trial) => trial.metrics.errorCategories[category] ?? 0)
      ).median,
    ])
  );
}

export function aggregateQualityTrials(trials, rawTrialFiles = []) {
  requireTrials(trials, "quality");
  const first = trials[0];
  const canonicalMetricAggregates = aggregateMetricMap(
    trials,
    "canonical",
    canonicalQualityMetricNames
  );
  const legacyMetricAggregates = aggregateMetricMap(
    trials,
    "macro",
    legacyQualityMetricNames
  );
  const pooledPerQuery = trials.flatMap((trial) => trial.metrics.perQuery);
  const latencyPhaseAggregates = Object.fromEntries(
    latencyPhaseNames.map((phase) => [
      phase,
      {
        pooledQueries: summarizeDistribution(
          pooledPerQuery.map((query) => query.latencyPhases[phase])
        ),
        trialMedian: summarizeDistribution(
          trials.map(
            (trial) => trial.metrics.canonical.latencyPhases[phase].median
          )
        ),
        trialP95: summarizeDistribution(
          trials.map(
            (trial) => trial.metrics.canonical.latencyPhases[phase].p95
          )
        ),
      },
    ])
  );
  const canonical = Object.fromEntries(
    canonicalQualityMetricNames.map((name) => [
      name,
      canonicalMetricAggregates[name].median,
    ])
  );
  canonical.returnedCountDistribution = summarizeIntegerDistribution(
    pooledPerQuery.map((query) => query.returned)
  );
  canonical.latencyPhases = Object.fromEntries(
    latencyPhaseNames.map((phase) => [
      phase,
      latencyPhaseAggregates[phase].pooledQueries,
    ])
  );
  const macro = Object.fromEntries(
    legacyQualityMetricNames.map((name) => [
      name,
      legacyMetricAggregates[name].median,
    ])
  );
  const medianTrial = pickMedianTrial(
    trials,
    (trial) => trial.metrics.canonical.latencyPhases.endToEndSearchMs.p95
  );
  return {
    schemaVersion: 2,
    reportType: "quality",
    adapter: first.adapter,
    benchmark: first.benchmark,
    environment: first.environment,
    performanceProfile: first.performanceProfile,
    trialAggregation: {
      trialCount: trials.length,
      rawTrialFiles,
      statistic: "median",
      distributionFields: ["p5", "median", "p95", "max", "range"],
    },
    run: aggregateRun(trials),
    resourceObservations: aggregateResources(trials),
    metrics: {
      trialCount: trials.length,
      rawTrialFiles,
      queryCount: first.metrics.queryCount,
      candidateMinimumSimilarity: first.metrics.candidateMinimumSimilarity,
      searchLatencyScope: first.metrics.searchLatencyScope,
      canonical,
      canonicalMetricAggregates,
      latencyPhaseAggregates,
      legacyMetricAggregates,
      macro,
      metricSemantics: {
        ...first.metrics.metricSemantics,
        perQuery: {
          status: "legacy-compatible",
          meaning: "Per-query detail from the median end-to-end-latency trial",
          rawTrialFile: rawTrialFiles[trials.indexOf(medianTrial)],
        },
      },
      errorCategories: aggregateErrorCategories(trials),
      perQuery: medianTrial.metrics.perQuery,
    },
  };
}

function buildProfileSummary(report) {
  return {
    actualConfiguration: report.performanceProfile.actual,
    requestedConfiguration: report.performanceProfile.requested,
    comparisonClassification:
      report.performanceProfile.comparisonClassification,
    trials: report.metrics.trialCount,
    phases: report.metrics.phaseAggregates,
    memory: report.resourceObservations.memory.observedPeakCombinedRssBytes,
    temperature: report.resourceObservations.temperature,
    errorsTotal: report.metrics.errorsTotal,
  };
}

export function buildRunSummary(index, aggregateReports) {
  const performanceReports = aggregateReports.filter(
    (report) => report.reportType === "performance"
  );
  const qualityReport = aggregateReports.find(
    (report) => report.reportType === "quality"
  );
  const profiles = Object.fromEntries(
    performanceReports.map((report) => [
      report.performanceProfile.profileId,
      buildProfileSummary(report),
    ])
  );
  const standard = performanceReports.find(
    (report) => report.performanceProfile.profileId === "standard"
  );
  const high = performanceReports.find(
    (report) => report.performanceProfile.profileId === "high"
  );
  let standardVsHigh = {
    classification: "unavailable",
    claimAllowed: false,
    reason: "Both standard and high reports are required",
    measuredDelta: null,
  };
  if (standard && high) {
    const sameConfiguration =
      standard.performanceProfile.actual.workers ===
        high.performanceProfile.actual.workers &&
      standard.performanceProfile.actual.threadsPerWorker ===
        high.performanceProfile.actual.threadsPerWorker;
    standardVsHigh = sameConfiguration
      ? {
          classification: "same-configuration-repeat",
          claimAllowed: false,
          reason:
            "Standard and high used identical worker/thread configuration; observed differences are repeat variation, not a profile advantage",
          measuredDelta: null,
        }
      : {
          classification: "distinct-configuration",
          claimAllowed: true,
          reason: "Actual worker/thread configurations differ",
          measuredDelta: {
            batchThroughputRatio:
              high.metrics.phaseAggregates.batchThroughputPerSecond.median /
              standard.metrics.phaseAggregates.batchThroughputPerSecond.median,
            hotSingleLatencyRatio:
              high.metrics.phaseAggregates.hotSingleImageMs.median /
              standard.metrics.phaseAggregates.hotSingleImageMs.median,
          },
        };
  }
  const warnings = [];
  if (index.environment.nodeBaselineStatus !== "supported") {
    warnings.push(
      `Node 22 baseline required; run used ${index.environment.nodeVersion}`
    );
  }
  for (const [profileId, profile] of Object.entries(profiles)) {
    if (profile.temperature.status !== "available") {
      warnings.push(
        `${profileId} temperature ${profile.temperature.status}: ${profile.temperature.unavailableReasons.join("; ") || "no complete sensor data"}`
      );
    }
  }
  const standardBaseline = profiles.standard?.actualConfiguration ?? null;
  return {
    schemaVersion: 2,
    sourceOfTruth: {
      index: "run-index.json",
      rawTrials: index.rawTrials.map((trial) => trial.fileName),
      policy: "All aggregate and Markdown values are generated from raw JSON",
    },
    generatedAt: index.createdAt,
    runId: index.runId,
    adapter: index.adapter,
    definitions: index.definitions,
    environment: index.environment,
    trialPlan: index.trialPlan,
    profiles,
    operatingGuidance: {
      standardModel: "SigLIP v1",
      standardDeviceBaseline: standardBaseline,
      productRuntimePolicy:
        "Use production automatic hardware configuration; do not force the standard-device baseline on every device",
      lowEndFallback:
        "Automatic hardware detection may degrade low-end devices to 1 worker and 1 thread",
    },
    quality: qualityReport
      ? {
          trials: qualityReport.metrics.trialCount,
          canonical: qualityReport.metrics.canonical,
          canonicalMetricAggregates:
            qualityReport.metrics.canonicalMetricAggregates,
          latencyPhaseAggregates: qualityReport.metrics.latencyPhaseAggregates,
          legacy: {
            macro: qualityReport.metrics.macro,
            semantics: qualityReport.metrics.metricSemantics,
          },
          searchLatencyScope: qualityReport.metrics.searchLatencyScope,
        }
      : null,
    comparisons: { standardVsHigh },
    limitations: {
      hardwareCoverage: {
        status: "single-device-only",
        meaning:
          "Low, standard, and high profiles were exercised on the recorded host; real low-end, office, and high-performance device coverage is still pending",
      },
      qualityScope: {
        status: "baseline-dataset-only",
        meaning:
          "Quality results establish recall and ranking behavior only for the recorded 21-sample baseline dataset and must not be generalized to all user photo libraries",
      },
      memoryStress: {
        status: "separate-follow-up-required",
        meaning:
          "The baseline runner does not prove leak freedom; review the separate index-stress report and follow up with 1000-5000 items, three repetitions, and separate parent/worker RSS trends",
      },
      historicalLatencyComparison: {
        status: "not-comparable",
        meaning:
          "Historical latency values from different metric definitions or run conditions must not be compared directly with this repeated Node 22 baseline",
      },
    },
    warnings,
  };
}

function formatNumber(value, digits = 2) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toFixed(digits)
    : "unavailable";
}

function formatProfileRow(profileId, profile) {
  const phases = profile.phases;
  return `| ${profileId} | ${profile.actualConfiguration.workers}×${profile.actualConfiguration.threadsPerWorker} | ${formatNumber(phases.imageModelLoadMs.median)} | ${formatNumber(phases.firstImageInferenceMs.median)} | ${formatNumber(phases.hotSingleImageMs.median)} | ${formatNumber(phases.batchThroughputPerSecond.median)} | ${formatNumber(phases.textEncodingMs.median)} | ${formatNumber(phases.observedPeakProcessMemoryBytes.max / 1024 / 1024, 1)} |`;
}

export function renderSummaryMarkdown(summary) {
  const profileRows = Object.entries(summary.profiles)
    .map(([profileId, profile]) => formatProfileRow(profileId, profile))
    .join("\n");
  const quality = summary.quality;
  const latencyRows = quality
    ? latencyPhaseNames
        .map((phase) => {
          const distribution = quality.canonical.latencyPhases[phase];
          return `| ${phase} | ${formatNumber(distribution.p50)} | ${formatNumber(distribution.p95)} | ${formatNumber(distribution.max)} |`;
        })
        .join("\n")
    : "| unavailable | unavailable | unavailable | unavailable |";
  const comparison = summary.comparisons.standardVsHigh;
  return `<!-- Generated from summary.json by summarize-siglip-v1-baseline.mjs. Do not edit. -->
# SigLIP v1 baseline summary

JSON source of truth: \`summary.json\` → \`run-index.json\` → raw trial JSON.

## Performance phases

| Profile | Actual workers×threads | Model load median ms | First image median ms | Hot single median ms | Batch images/s median | Text encoding median ms | Peak observed MiB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
${profileRows}

Each aggregate report also records P5, median, P95, max, and range. Model load means a fresh worker process; the operating-system file cache is not flushed.

## Quality

${
  quality
    ? `Hit@1 ${formatNumber(quality.canonical.hitAt1, 4)}, Hit@3 ${formatNumber(quality.canonical.hitAt3, 4)}, Hit@5 ${formatNumber(quality.canonical.hitAt5, 4)}, Hit@10 ${formatNumber(quality.canonical.hitAt10, 4)}, MRR ${formatNumber(quality.canonical.meanReciprocalRank, 4)}, nDCG@50 ${formatNumber(quality.canonical.ndcgAt50, 4)}.`
    : "Quality was not requested for this run."
}

${
  quality
    ? `Hard-negative false-positive rate: @1 ${formatNumber(quality.canonical.hardNegativeFalsePositiveRateAt1, 4)}, @3 ${formatNumber(quality.canonical.hardNegativeFalsePositiveRateAt3, 4)}, @5 ${formatNumber(quality.canonical.hardNegativeFalsePositiveRateAt5, 4)}, @10 ${formatNumber(quality.canonical.hardNegativeFalsePositiveRateAt10, 4)}. The denominator is the ${quality.canonical.hardNegativeQueryCount} queries with at least one declared hard negative; a query counts as a false positive when any declared similar-but-irrelevant sample appears in its top-K results. Lower is better.`
    : ""
}

| Latency phase | P50 ms | P95 ms | Max ms |
| --- | ---: | ---: | ---: |
${latencyRows}

Text encoding is only the worker encoding request. End-to-end benchmark search is text encoding + in-memory scoring + threshold filtering + sorting; its exclusions are recorded in JSON. These values must not be presented under one unlabeled “query latency”.

Quality conclusions apply only to the recorded 21-sample baseline dataset. They do not establish suitability for every user photo library.

## Runtime configuration

SigLIP v1 remains the standard model. The standard-device baseline is ${summary.operatingGuidance.standardDeviceBaseline ? `${summary.operatingGuidance.standardDeviceBaseline.workers}×${summary.operatingGuidance.standardDeviceBaseline.threadsPerWorker}` : "unavailable"}; product runtime continues to use automatic hardware configuration, and low-end devices may degrade to 1×1.

## Standard vs high

Classification: **${comparison.classification}**. ${comparison.reason}. Comparative claim allowed: ${comparison.claimAllowed ? "yes" : "no"}.

## Limitations and follow-up

- Only the recorded host was tested; real low-end, office, and high-performance hardware coverage remains pending.
- Historical latency values obtained with different metric definitions or run conditions are not directly comparable with this repeated Node 22 baseline.
- Memory leak freedom is not established here. Review the separate stress report and repeat 1000-5000-item runs three times with parent and worker RSS reported separately.

## Warnings

${summary.warnings.length > 0 ? summary.warnings.map((warning) => `- ${warning}`).join("\n") : "- None"}
`;
}

export async function generateRunArtifacts(runDirectory) {
  const indexPath = path.join(runDirectory, "run-index.json");
  const index = readJson(indexPath);
  const rawReports = index.rawTrials.map((entry) => ({
    entry,
    report: readJson(path.join(runDirectory, entry.fileName)),
  }));
  const aggregateReports = [];
  const reportPaths = [];
  const performanceProfileIds = [
    ...new Set(
      rawReports
        .filter(({ report }) => report.reportType === "performance-trial")
        .map(({ report }) => report.performanceProfile.profileId)
    ),
  ];
  for (const profileId of performanceProfileIds) {
    const matches = rawReports.filter(
      ({ report }) =>
        report.reportType === "performance-trial" &&
        report.performanceProfile.profileId === profileId
    );
    const aggregate = aggregatePerformanceTrials(
      matches.map(({ report }) => report),
      matches.map(({ entry }) => entry.fileName)
    );
    const filePath = path.join(runDirectory, `performance-${profileId}.json`);
    await writeJson(filePath, aggregate);
    aggregateReports.push(aggregate);
    reportPaths.push(filePath);
  }
  const qualityMatches = rawReports.filter(
    ({ report }) => report.reportType === "quality-trial"
  );
  if (qualityMatches.length > 0) {
    const aggregate = aggregateQualityTrials(
      qualityMatches.map(({ report }) => report),
      qualityMatches.map(({ entry }) => entry.fileName)
    );
    const filePath = path.join(runDirectory, "quality-standard.json");
    await writeJson(filePath, aggregate);
    aggregateReports.push(aggregate);
    reportPaths.push(filePath);
  }

  const summary = buildRunSummary(index, aggregateReports);
  const summaryJsonPath = path.join(runDirectory, "summary.json");
  const summaryMarkdownPath = path.join(runDirectory, "summary.md");
  await writeJson(summaryJsonPath, summary);
  await writeText(summaryMarkdownPath, renderSummaryMarkdown(summary));
  const updatedIndex = {
    ...index,
    reports: reportPaths.map((filePath) => path.basename(filePath)),
    generatedArtifacts: {
      summaryJson: path.basename(summaryJsonPath),
      summaryMarkdown: path.basename(summaryMarkdownPath),
      generatedAt: summary.generatedAt,
    },
  };
  await writeJson(indexPath, updatedIndex);
  return {
    reportPaths,
    summaryJsonPath,
    summaryMarkdownPath,
  };
}

function fileDigest(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function captureDigests(runDirectory, fileNames) {
  return Object.fromEntries(
    fileNames.map((fileName) => [
      fileName,
      fileDigest(path.join(runDirectory, fileName)),
    ])
  );
}

function sameDigests(left, right) {
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.entries(left).every(
      ([fileName, digest]) => right[fileName] === digest
    )
  );
}

export async function verifyReproducibleArtifacts(runDirectory) {
  const resolvedRunDirectory = path.resolve(runDirectory);
  const initialIndex = readJson(
    path.join(resolvedRunDirectory, "run-index.json")
  );
  const rawTrialFiles = initialIndex.rawTrials.map((entry) => entry.fileName);
  const rawBefore = captureDigests(resolvedRunDirectory, rawTrialFiles);

  await generateRunArtifacts(resolvedRunDirectory);
  const firstIndex = readJson(
    path.join(resolvedRunDirectory, "run-index.json")
  );
  const generatedFiles = [
    "run-index.json",
    ...firstIndex.reports,
    firstIndex.generatedArtifacts.summaryJson,
    firstIndex.generatedArtifacts.summaryMarkdown,
  ];
  const firstGenerated = captureDigests(resolvedRunDirectory, generatedFiles);

  await generateRunArtifacts(resolvedRunDirectory);
  const secondGenerated = captureDigests(resolvedRunDirectory, generatedFiles);
  const rawAfter = captureDigests(resolvedRunDirectory, rawTrialFiles);
  const rawUnchanged = sameDigests(rawBefore, rawAfter);
  const generatedByteIdentical = sameDigests(firstGenerated, secondGenerated);
  if (!(rawUnchanged && generatedByteIdentical)) {
    throw new Error(
      `Artifact reproducibility failed: rawUnchanged=${rawUnchanged}, generatedByteIdentical=${generatedByteIdentical}`
    );
  }
  return {
    runDirectory: resolvedRunDirectory,
    rawUnchanged,
    generatedByteIdentical,
    generatedFieldIdentical: generatedByteIdentical,
    generatedSha256: secondGenerated,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const verifyReproducible = process.argv.includes("--verify-reproducible");
  const runDirectoryArgument = process.argv
    .slice(2)
    .find((argument) => argument !== "--verify-reproducible");
  const runDirectory =
    runDirectoryArgument && path.resolve(runDirectoryArgument);
  if (!runDirectory) {
    throw new Error(
      "Usage: node scripts/summarize-siglip-v1-baseline.mjs <reports/run-directory>"
    );
  }
  const operation = verifyReproducible
    ? verifyReproducibleArtifacts
    : generateRunArtifacts;
  operation(runDirectory)
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
}
