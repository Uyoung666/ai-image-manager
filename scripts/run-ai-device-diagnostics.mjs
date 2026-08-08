/**
 * Runs repeatable AI index stress diagnostics on the current host.
 * This is an external harness: it does not change production adapter or worker logic.
 */

import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { summarizeDistribution } from "./siglip-v1-baseline/statistics.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const reportsRoot = path.join(repoRoot, "reports");

function takeOption(argv, index, label) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function parseInteger(value, label, minimum, maximum) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${label} must be an integer from ${minimum} to ${maximum}`
    );
  }
  return parsed;
}

function assertBelowReports(outputDir) {
  const relative = path.relative(reportsRoot, outputDir);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("--output-dir must be below ./reports");
  }
}

export function parseArguments(argv) {
  const options = {
    count: 1000,
    help: false,
    input: path.join(repoRoot, "images", "demo.png"),
    modelRoot: path.join(repoRoot, "models"),
    outputDir: null,
    trials: 3,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--count") {
      options.count = parseInteger(
        takeOption(argv, index, "--count"),
        "--count",
        500,
        1000
      );
      index += 1;
    } else if (argument === "--trials") {
      options.trials = parseInteger(
        takeOption(argv, index, "--trials"),
        "--trials",
        1,
        5
      );
      index += 1;
    } else if (argument === "--input") {
      options.input = path.resolve(takeOption(argv, index, "--input"));
      index += 1;
    } else if (argument === "--model-root") {
      options.modelRoot = path.resolve(takeOption(argv, index, "--model-root"));
      index += 1;
    } else if (argument === "--output-dir") {
      options.outputDir = path.resolve(takeOption(argv, index, "--output-dir"));
      assertBelowReports(options.outputDir);
      index += 1;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-ai-device-diagnostics.mjs [options]

Options:
  --input <file-or-dir>       Valid local test images (default: images/demo.png)
  --model-root <dir>          Current model asset root (default: ./models)
  --count <500-1000>          Logical items per trial (default: 1000)
  --trials <1-5>              Fresh-process trials per configuration (default: 3)
  --output-dir <reports/...>  Diagnostic output directory; completed trials resume
  --help                      Show this help

Profiles are 1x1, production automatic selection, and 2x4. All profiles run on
the current host; this does not simulate low-end CPU, memory bandwidth, or thermal throttling.`);
}

export function createExecutionPlan(trials) {
  const profiles = ["low-1x1", "automatic", "high-2x4"];
  return Array.from({ length: trials }, (_, roundIndex) => {
    const offset = roundIndex % profiles.length;
    return [...profiles.slice(offset), ...profiles.slice(0, offset)].map(
      (profileId) => ({ profileId, round: roundIndex + 1 })
    );
  }).flat();
}

function environmentForProfile(profileId) {
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key !== "AI_EMBED_WORKERS" && key !== "AI_EMBED_THREADS"
    )
  );
  if (profileId === "low-1x1") {
    environment.AI_EMBED_WORKERS = "1";
    environment.AI_EMBED_THREADS = "1";
  } else if (profileId === "high-2x4") {
    environment.AI_EMBED_WORKERS = "2";
    environment.AI_EMBED_THREADS = "4";
  }
  return environment;
}

function splitMemoryTrend(report) {
  const cutoff = report.memory.trend.warmupCutoff.sampleIndex;
  const processingSamples = report.memory.samples.filter(
    (sample) =>
      sample.phase === undefined ||
      sample.phase === "workers-ready" ||
      sample.phase === "workers-restarted" ||
      sample.phase === "segment"
  );
  const samples = processingSamples.slice(cutoff);
  const first = samples[0];
  const last = samples.at(-1);
  return {
    combinedRssDeltaBytes: last.totalRssBytes - first.totalRssBytes,
    parentRssDeltaBytes: last.parentRssBytes - first.parentRssBytes,
    workerRssDeltaBytes: last.workerRssBytes - first.workerRssBytes,
    combinedRssPeakBytes: Math.max(
      ...samples.map((sample) => sample.totalRssBytes)
    ),
    parentRssPeakBytes: Math.max(
      ...samples.map((sample) => sample.parentRssBytes)
    ),
    workerRssPeakBytes: Math.max(
      ...samples.map((sample) => sample.workerRssBytes)
    ),
    leakReviewRecommended:
      report.memory.trend.steadyState.leakReviewRecommended,
    warmupCompletedItems:
      report.memory.trend.warmupCutoff.completedLogicalItems,
  };
}

export function aggregateDiagnostics(trials) {
  const byProfile = Object.groupBy(trials, (trial) => trial.profileId);
  return Object.fromEntries(
    Object.entries(byProfile).map(([profileId, profileTrials]) => {
      const actualConfigurations = [
        ...new Set(
          profileTrials.map(
            (trial) =>
              `${trial.execution.workerCount}x${trial.execution.threadsPerWorker}`
          )
        ),
      ];
      return [
        profileId,
        {
          actualConfigurations,
          trials: profileTrials.length,
          completedWithoutErrors: profileTrials.every(
            (trial) => trial.status === "complete" && trial.errorCount === 0
          ),
          throughputPerSecond: summarizeDistribution(
            profileTrials.map((trial) => trial.throughputPerSecond)
          ),
          steadyStateMemory: {
            combinedRssDeltaBytes: summarizeDistribution(
              profileTrials.map((trial) => trial.memory.combinedRssDeltaBytes)
            ),
            parentRssDeltaBytes: summarizeDistribution(
              profileTrials.map((trial) => trial.memory.parentRssDeltaBytes)
            ),
            workerRssDeltaBytes: summarizeDistribution(
              profileTrials.map((trial) => trial.memory.workerRssDeltaBytes)
            ),
            leakReviewTrialCount: profileTrials.filter(
              (trial) => trial.memory.leakReviewRecommended
            ).length,
          },
        },
      ];
    })
  );
}

async function writeJsonAtomic(filePath, value) {
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(
    temporaryPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rename(temporaryPath, filePath);
}

function summarizeTrialReport({
  executionOrder,
  plan,
  profileTrialNumber,
  rawReportPath,
  report,
  outputDir,
}) {
  return {
    errorCount: report.results.errorCount,
    execution: report.execution,
    executionOrder,
    memory: splitMemoryTrend(report),
    profileId: plan.profileId,
    rawReport: path.relative(outputDir, rawReportPath),
    round: plan.round,
    status: report.status,
    throughputPerSecond: report.performance.throughputPerSecond,
    trialNumber: profileTrialNumber,
  };
}

async function runDiagnostics(options) {
  if (Number.parseInt(process.versions.node.split(".")[0], 10) !== 22) {
    throw new Error(`Node 22 is required; received ${process.version}`);
  }
  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const outputDir =
    options.outputDir ??
    path.join(reportsRoot, "ai-device-diagnostics", timestamp);
  assertBelowReports(outputDir);
  await fs.promises.mkdir(outputDir, { recursive: true });

  const executionPlan = createExecutionPlan(options.trials);
  const completedTrials = [];
  for (let index = 0; index < executionPlan.length; index += 1) {
    const plan = executionPlan[index];
    const profileTrialNumber = plan.round;
    const trialDirectoryName = `${String(index + 1).padStart(2, "0")}-${plan.profileId}-trial-${profileTrialNumber}`;
    const plannedTrialOutput = path.join(outputDir, trialDirectoryName);
    const plannedReportPath = path.join(
      plannedTrialOutput,
      "ai-index-stress.json"
    );
    if (fs.existsSync(plannedReportPath)) {
      const report = JSON.parse(
        await fs.promises.readFile(plannedReportPath, "utf8")
      );
      completedTrials.push(
        summarizeTrialReport({
          executionOrder: index + 1,
          outputDir,
          plan,
          profileTrialNumber,
          rawReportPath: plannedReportPath,
          report,
        })
      );
      console.error(
        `[ai-device-diagnostics] ${index + 1}/${executionPlan.length} ${plan.profileId} trial ${profileTrialNumber}/${options.trials} reused`
      );
      continue;
    }
    const trialOutput = fs.existsSync(plannedTrialOutput)
      ? path.join(
          outputDir,
          `${trialDirectoryName}-resume-${new Date().toISOString().replaceAll(":", "-")}`
        )
      : plannedTrialOutput;
    console.error(
      `[ai-device-diagnostics] ${index + 1}/${executionPlan.length} ${plan.profileId} trial ${profileTrialNumber}/${options.trials}`
    );
    await execFileAsync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "run-ai-index-stress.mjs"),
        "--count",
        String(options.count),
        "--input",
        options.input,
        "--model-root",
        options.modelRoot,
        "--segment-size",
        "100",
        "--pause-after",
        String(Math.floor(options.count / 2)),
        "--pause-ms",
        "1000",
        "--output-dir",
        trialOutput,
      ],
      {
        cwd: repoRoot,
        env: environmentForProfile(plan.profileId),
        maxBuffer: 10 * 1024 * 1024,
        timeout: 30 * 60 * 1000,
        windowsHide: true,
      }
    );
    const report = JSON.parse(
      await fs.promises.readFile(
        path.join(trialOutput, "ai-index-stress.json"),
        "utf8"
      )
    );
    const rawReportPath = path.join(trialOutput, "ai-index-stress.json");
    completedTrials.push(
      summarizeTrialReport({
        executionOrder: index + 1,
        outputDir,
        plan,
        profileTrialNumber,
        rawReportPath,
        report,
      })
    );
  }

  const aggregates = aggregateDiagnostics(completedTrials);
  const leakReviewRequired = Object.values(aggregates).some(
    (aggregate) => aggregate.steadyStateMemory.leakReviewTrialCount > 0
  );
  const report = {
    schemaVersion: 1,
    reportType: "ai-device-diagnostics",
    generatedAt: new Date().toISOString(),
    environment: {
      arch: os.arch(),
      cpu: os.cpus()[0]?.model?.trim() ?? "unknown",
      logicalCores: os.cpus().length,
      nodeVersion: process.version,
      platform: os.platform(),
      release: os.release(),
      totalMemoryBytes: os.totalmem(),
    },
    scope: {
      configurationCoverage: "simulated-on-current-host",
      realLowEndHardwareCovered: false,
      caveat:
        "1x1 and 2x4 constrain concurrency only; they do not simulate low-end CPU performance, memory bandwidth, or thermal throttling",
    },
    workload: {
      itemsPerTrial: options.count,
      trialsPerConfiguration: options.trials,
      sourceKind: "local-user-supplied-test-data-not-exported",
    },
    executionPlan,
    trials: completedTrials,
    aggregates,
    assessment: {
      allTrialsCompletedWithoutErrors: completedTrials.every(
        (trial) => trial.status === "complete" && trial.errorCount === 0
      ),
      memoryStatus: leakReviewRequired
        ? "steady-state-growth-observed-review-required"
        : "no-steady-state-growth-observed-not-proof-of-no-leak",
      productConfigurationPolicy:
        "Production automatic hardware selection remains authoritative; 2x4 is a standard-device baseline, not a universal fixed setting",
    },
    privacy: {
      containsImageContent: false,
      containsImagePaths: false,
      intendedForVoluntaryTesterFeedback: true,
    },
  };
  const reportPath = path.join(outputDir, "device-diagnostics.json");
  await writeJsonAtomic(reportPath, report);
  console.log(JSON.stringify({ outputDir, reportPath }, null, 2));
}

if (process.argv[1] === import.meta.filename) {
  const options = parseArguments(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    runDiagnostics(options).catch((error) => {
      console.error(error instanceof Error ? error.stack : error);
      process.exitCode = 1;
    });
  }
}
