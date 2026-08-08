/**
 * Reproducible SigLIP v1 quality and performance baseline.
 *
 * Production adapter, fingerprint, threshold profile, and automatic worker
 * configuration are loaded from src/ through Vite. Image and text vectors are
 * produced only through the production worker protocols.
 */
import { execFile, fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";
import { evaluateSemanticRun } from "./evaluate-semantic-quality.mjs";
import { summarizeDistribution } from "./siglip-v1-baseline/statistics.mjs";
import { generateRunArtifacts } from "./summarize-siglip-v1-baseline.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const definitionsRoot = path.join(repoRoot, "scripts", "siglip-v1-baseline");
const manifestPath = path.join(definitionsRoot, "manifest.v1.json");
const queriesPath = path.join(definitionsRoot, "queries.v1.json");
const reportsRoot = path.join(repoRoot, "reports");
const imageWorkerPath = path.join(repoRoot, "scripts", "embed-worker.mjs");
const textWorkerPath = path.join(repoRoot, "scripts", "text-embed-worker.mjs");
const defaultDatasetRoot = path.resolve(`${repoRoot}测试用例`);
const defaultModelRoot = path.join(repoRoot, "models");
const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp"]);
const workerTimeoutMs = 300_000;
const l2Tolerance = 0.001;
const whitespaceRegex = /\s+/u;

function canonicalize(value) {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonicalize(entry)])
    );
  }
  return value;
}

function sha256Canonical(value) {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)))
    .digest("hex");
}

function mean(values) {
  return values.length > 0
    ? values.reduce((sum, value) => sum + value, 0) / values.length
    : 0;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ];
}

function roundMetric(value) {
  return Number(value.toFixed(3));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new Error(`${label} must contain unique values`);
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: definition validation intentionally reports each malformed contract at its source.
export function loadAndValidateDefinitions() {
  const manifest = readJson(manifestPath);
  const queryDefinitions = readJson(queriesPath);
  if (manifest.schemaVersion !== 1 || queryDefinitions.schemaVersion !== 1) {
    throw new Error("Unsupported SigLIP baseline definition schema");
  }
  if (
    !Array.isArray(manifest.samples) ||
    manifest.samples.length !== 21 ||
    manifest.sampleCount !== manifest.samples.length
  ) {
    throw new Error("The v1 manifest must define exactly 21 samples");
  }
  if (
    !Array.isArray(queryDefinitions.queries) ||
    queryDefinitions.queries.length !== 21
  ) {
    throw new Error("The v1 query definition must contain exactly 21 queries");
  }

  const sampleIds = manifest.samples.map((sample) => sample.id);
  const fileNames = manifest.samples.map((sample) => sample.fileName);
  assertUnique(sampleIds, "Manifest sample ids");
  assertUnique(fileNames, "Manifest file names");
  const knownSampleIds = new Set(sampleIds);
  for (const sample of manifest.samples) {
    requireString(sample.id, "Sample id");
    requireString(sample.fileName, `File name for ${sample.id}`);
    requireString(sample.errorCategory, `Error category for ${sample.id}`);
    if (path.basename(sample.fileName) !== sample.fileName) {
      throw new Error(
        `Sample file name must not contain a path: ${sample.fileName}`
      );
    }
  }

  const queryIds = queryDefinitions.queries.map((query) => query.id);
  assertUnique(queryIds, "Query ids");
  for (const query of queryDefinitions.queries) {
    requireString(query.id, "Query id");
    requireString(query.text, `Query text for ${query.id}`);
    requireString(query.prompt, `Query prompt for ${query.id}`);
    if (
      !Array.isArray(query.relevantSampleIds) ||
      query.relevantSampleIds.length === 0
    ) {
      throw new Error(`Query ${query.id} must define relevant sample ids`);
    }
    for (const sampleId of query.relevantSampleIds) {
      if (!knownSampleIds.has(sampleId)) {
        throw new Error(
          `Query ${query.id} references unknown sample ${sampleId}`
        );
      }
    }
    const hardNegativeSampleIds = query.hardNegativeSampleIds ?? [];
    if (!Array.isArray(hardNegativeSampleIds)) {
      throw new Error(`Query ${query.id} hard negatives must be an array`);
    }
    assertUnique(hardNegativeSampleIds, `Hard negatives for ${query.id}`);
    for (const sampleId of hardNegativeSampleIds) {
      if (!knownSampleIds.has(sampleId)) {
        throw new Error(
          `Query ${query.id} references unknown hard negative ${sampleId}`
        );
      }
      if (query.relevantSampleIds.includes(sampleId)) {
        throw new Error(
          `Query ${query.id} marks ${sampleId} as both relevant and hard negative`
        );
      }
    }
  }

  const requiredMetrics = [
    "precisionAt20",
    "precisionAt50",
    "recallAt50",
    "recallAt200",
    "ndcgAt50",
    "p95LatencyMs",
    "errorCategories",
    "emptyResultRate",
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
    "returnedCountDistribution",
    "latencyPhases",
    "hardNegativeFalsePositiveRates",
  ];
  for (const metric of requiredMetrics) {
    if (!queryDefinitions.metrics?.includes(metric)) {
      throw new Error(
        `Query definitions are missing required metric ${metric}`
      );
    }
  }

  return {
    manifest,
    queryDefinitions,
    fingerprints: {
      datasetManifestFingerprint: sha256Canonical(manifest),
      queryDefinitionFingerprint: sha256Canonical(queryDefinitions),
      queryPlanFingerprint: sha256Canonical({
        queryDefinitionVersion: queryDefinitions.queryDefinitionVersion,
        queryPlan: queryDefinitions.queryPlan,
        queries: queryDefinitions.queries.map((query) => ({
          id: query.id,
          prompt: query.prompt,
          relevantSampleIds: query.relevantSampleIds,
        })),
      }),
    },
  };
}

function parsePositiveInteger(value, label) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function takeOption(argv, index, label) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit CLI branches keep invalid option handling auditable.
function parseArguments(argv) {
  const options = {
    datasetRoot: defaultDatasetRoot,
    hotIterations: 5,
    mode: "all",
    modelRoot: defaultModelRoot,
    outputDir: null,
    performanceInput: null,
    profile: "all",
    sampleLimit: null,
    trials: 3,
    validateOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--dataset-root") {
      options.datasetRoot = path.resolve(
        takeOption(argv, index, "--dataset-root")
      );
      index += 1;
    } else if (argument === "--model-root") {
      options.modelRoot = path.resolve(takeOption(argv, index, "--model-root"));
      index += 1;
    } else if (argument === "--output-dir") {
      options.outputDir = path.resolve(takeOption(argv, index, "--output-dir"));
      index += 1;
    } else if (argument === "--performance-input") {
      options.performanceInput = path.resolve(
        takeOption(argv, index, "--performance-input")
      );
      index += 1;
    } else if (argument === "--mode") {
      options.mode = takeOption(argv, index, "--mode");
      index += 1;
    } else if (argument === "--profile") {
      options.profile = takeOption(argv, index, "--profile");
      index += 1;
    } else if (argument === "--hot-iterations") {
      options.hotIterations = parsePositiveInteger(
        takeOption(argv, index, "--hot-iterations"),
        "--hot-iterations"
      );
      index += 1;
    } else if (argument === "--sample-limit") {
      options.sampleLimit = parsePositiveInteger(
        takeOption(argv, index, "--sample-limit"),
        "--sample-limit"
      );
      index += 1;
    } else if (argument === "--trials") {
      options.trials = parsePositiveInteger(
        takeOption(argv, index, "--trials"),
        "--trials"
      );
      index += 1;
    } else if (argument === "--validate-only") {
      options.validateOnly = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (!new Set(["all", "performance", "quality"]).has(options.mode)) {
    throw new Error("--mode must be all, performance, or quality");
  }
  if (!new Set(["all", "low", "standard", "high"]).has(options.profile)) {
    throw new Error("--profile must be all, low, standard, or high");
  }
  if (options.performanceInput && options.mode !== "performance") {
    throw new Error(
      "--performance-input can only be used with --mode performance"
    );
  }
  if (options.trials < 3 || options.trials > 5) {
    throw new Error("--trials must be between 3 and 5");
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-siglip-v1-baseline.mjs --dataset-root <dir> [options]

Options:
  --model-root <dir>        Model asset root (default: ./models)
  --mode <mode>             all, performance, or quality (default: all)
  --profile <profile>       all, low, standard, or high (default: all)
  --hot-iterations <count>  Warm single-image repetitions (default: 5)
  --trials <count>          Fresh-worker trials per profile, 3-5 (default: 3)
  --sample-limit <count>    Limit performance samples only
  --output-dir <dir>        Output directory below ./reports
  --performance-input <p>  Legacy ad-hoc image file/directory; performance only
  --validate-only           Validate committed definitions without loading models`);
}

async function loadProductionContext(modelRoot) {
  const virtualElectronId = "\0siglip-benchmark-electron";
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    root: repoRoot,
    plugins: [
      {
        name: "siglip-benchmark-electron-stub",
        enforce: "pre",
        resolveId(id) {
          return id === "electron" ? virtualElectronId : null;
        },
        load(id) {
          if (id !== virtualElectronId) {
            return null;
          }
          return `export const app = {
            isPackaged: false,
            getAppPath: () => process.cwd()
          };`;
        },
      },
    ],
    resolve: {
      alias: {
        "@": path.join(repoRoot, "src"),
      },
    },
    server: { middlewareMode: true },
    ssr: { noExternal: ["electron"] },
  });
  try {
    const modelConfig = await server.ssrLoadModule(
      "/src/services/ai/model-config.ts"
    );
    const thresholdProfiles = await server.ssrLoadModule(
      "/src/services/ai/threshold-profile.ts"
    );
    const workerPool = await server.ssrLoadModule(
      "/src/services/embed-worker-pool.ts"
    );
    const runtimeInfo = modelConfig.getActiveEmbeddingRuntimeInfo();
    const workerAdapter =
      modelConfig.getActiveEmbeddingWorkerAdapter(modelRoot);
    const thresholdProfile = thresholdProfiles.getActiveThresholdProfile();
    const automaticWorkerConfig = workerPool.resolveEmbedPoolConfig(
      os.cpus().length,
      false,
      process.env
    );
    if (
      runtimeInfo.adapterId !== workerAdapter.adapterId ||
      runtimeInfo.fingerprint !== workerAdapter.fingerprint ||
      runtimeInfo.dimensions !== workerAdapter.image.dimensions ||
      runtimeInfo.dimensions !== workerAdapter.text.dimensions ||
      runtimeInfo.thresholdProfileId !== thresholdProfile.profileId
    ) {
      throw new Error(
        "Production embedding identity is internally inconsistent"
      );
    }
    return {
      automaticWorkerConfig,
      runtimeInfo,
      thresholdProfile,
      workerAdapter,
    };
  } finally {
    await server.close();
  }
}

function resolveProfiles(automaticWorkerConfig) {
  const logicalCores = Math.max(1, os.cpus().length);
  const availableHighCores = Math.max(1, logicalCores - 1);
  const highWorkers = availableHighCores >= 2 ? 2 : 1;
  const highThreads = Math.max(
    1,
    Math.min(4, Math.floor(availableHighCores / highWorkers))
  );
  const definitions = {
    low: {
      profileId: "low",
      requested: { workers: 1, threadsPerWorker: 1 },
      actual: { workers: 1, threadsPerWorker: 1 },
      degraded: false,
      configurationSource: "fixed-low",
      comparisonClassification: "distinct-configuration",
    },
    standard: {
      profileId: "standard",
      requested: {
        workers: automaticWorkerConfig.workers,
        threadsPerWorker: automaticWorkerConfig.intraOpNumThreads,
      },
      actual: {
        workers: automaticWorkerConfig.workers,
        threadsPerWorker: automaticWorkerConfig.intraOpNumThreads,
      },
      degraded: false,
      configurationSource: "production-auto",
      comparisonClassification: "distinct-configuration",
    },
    high: {
      profileId: "high",
      requested: { workers: 2, threadsPerWorker: 4 },
      actual: { workers: highWorkers, threadsPerWorker: highThreads },
      degraded: highWorkers !== 2 || highThreads !== 4,
      configurationSource: "bounded-high",
      comparisonClassification: "distinct-configuration",
    },
  };
  if (
    definitions.standard.actual.workers === definitions.high.actual.workers &&
    definitions.standard.actual.threadsPerWorker ===
      definitions.high.actual.threadsPerWorker
  ) {
    definitions.standard.comparisonClassification = "same-configuration-repeat";
    definitions.high.comparisonClassification = "same-configuration-repeat";
  }
  return definitions;
}

function getEnvironment() {
  const cpus = os.cpus();
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  return {
    nodeVersion: process.version,
    nodeMajor,
    nodeBaselineStatus: nodeMajor === 22 ? "supported" : "unsupported",
    platform: process.platform,
    arch: process.arch,
    cpu: {
      model: cpus[0]?.model?.trim() || "unknown",
      logicalCores: Math.max(1, cpus.length),
    },
    memory: {
      totalBytes: os.totalmem(),
      freeBytesAtStart: os.freemem(),
    },
  };
}

function resolveBaselineSamples(manifest, datasetRoot, sampleLimit) {
  const samples = manifest.samples
    .slice(0, sampleLimit ?? manifest.samples.length)
    .map((sample) => ({
      ...sample,
      filePath: path.join(datasetRoot, sample.fileName),
    }));
  const missing = samples.filter((sample) => !fs.existsSync(sample.filePath));
  if (missing.length > 0) {
    throw new Error(
      `Missing baseline images under ${datasetRoot}: ${missing
        .map((sample) => sample.fileName)
        .join(", ")}`
    );
  }
  return samples;
}

function resolveAdHocSamples(inputPath, sampleLimit) {
  const stat = fs.statSync(inputPath);
  const filePaths = stat.isFile()
    ? [inputPath]
    : fs
        .readdirSync(inputPath, { withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => path.join(inputPath, entry.name))
        .filter((filePath) =>
          imageExtensions.has(path.extname(filePath).toLowerCase())
        )
        .sort((left, right) => left.localeCompare(right));
  const selected = filePaths.slice(0, sampleLimit ?? filePaths.length);
  if (selected.length === 0) {
    throw new Error(`No performance images found: ${inputPath}`);
  }
  return selected.map((filePath, index) => ({
    id: `ad-hoc-${String(index + 1).padStart(4, "0")}`,
    fileName: path.basename(filePath),
    filePath,
    errorCategory: "unclassified",
  }));
}

function splitEvenly(items, parts) {
  return Array.from({ length: parts }, (_, index) =>
    items.filter((_, itemIndex) => itemIndex % parts === index)
  );
}

function formatWorkerFailure(label, stderrTail) {
  const suffix = stderrTail.trim() ? `: ${stderrTail.slice(-1200)}` : "";
  return new Error(`${label}${suffix}`);
}

function requestWorkerMessage(
  child,
  outbound,
  { description, errorTypes, successType, stderrTail }
) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, message) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("error", onError);
      child.off("exit", onExit);
      if (error) {
        reject(error);
      } else {
        resolve(message);
      }
    };
    const onMessage = (message) => {
      if (errorTypes.includes(message?.type)) {
        finish(
          formatWorkerFailure(
            `${description} failed (${message.error || message.type})`,
            stderrTail()
          )
        );
      } else if (message?.type === successType) {
        finish(null, message);
      }
    };
    const onError = (error) => finish(error);
    const onExit = (code, signal) =>
      finish(
        formatWorkerFailure(
          `${description} exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
          stderrTail()
        )
      );
    const timeout = setTimeout(
      () =>
        finish(formatWorkerFailure(`${description} timed out`, stderrTail())),
      workerTimeoutMs
    );
    child.on("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    try {
      child.send(outbound, (error) => {
        if (error) {
          finish(error);
        }
      });
    } catch (error) {
      finish(error);
    }
  });
}

function launchWorker(scriptPath) {
  const child = fork(scriptPath, [], {
    cwd: repoRoot,
    env: { ...process.env, AI_EMBED_SHARP_THREADS: "1" },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderrTail = "";
  child.stderr?.on("data", (chunk) => {
    stderrTail = `${stderrTail}${chunk.toString()}`.slice(-8000);
  });
  return { child, stderrTail: () => stderrTail };
}

function assertWorkerIdentity(message, adapter, label) {
  if (
    message.adapterId !== adapter.adapterId ||
    message.fingerprint !== adapter.fingerprint
  ) {
    throw new Error(`${label} returned a stale adapter identity`);
  }
}

function launchImageWorker(adapter, threadsPerWorker, index) {
  const handle = launchWorker(imageWorkerPath);
  const startedAt = performance.now();
  handle.ready = requestWorkerMessage(
    handle.child,
    {
      type: "init",
      adapter,
      execution: { provider: "cpu", intraOpNumThreads: threadsPerWorker },
    },
    {
      description: `Image worker ${index} initialization`,
      errorTypes: ["init-error"],
      successType: "ready",
      stderrTail: handle.stderrTail,
    }
  ).then((message) => {
    assertWorkerIdentity(message, adapter, `Image worker ${index}`);
    handle.loadMs = performance.now() - startedAt;
    return message;
  });
  return handle;
}

async function embedImages(handle, adapter, photos) {
  const startedAt = performance.now();
  const message = await requestWorkerMessage(
    handle.child,
    { type: "embed", photos },
    {
      description: "Image worker request",
      errorTypes: ["init-error"],
      successType: "result",
      stderrTail: handle.stderrTail,
    }
  );
  assertWorkerIdentity(message, adapter, "Image worker result");
  return {
    latencyMs: performance.now() - startedAt,
    results: Array.isArray(message.results) ? message.results : [],
  };
}

let nextTextRequestId = 1;

function launchTextWorker(adapter) {
  const handle = launchWorker(textWorkerPath);
  const startedAt = performance.now();
  handle.ready = requestWorkerMessage(
    handle.child,
    { type: "init", adapter },
    {
      description: "Text worker initialization",
      errorTypes: ["init-error"],
      successType: "ready",
      stderrTail: handle.stderrTail,
    }
  ).then((message) => {
    assertWorkerIdentity(message, adapter, "Text worker");
    handle.loadMs = performance.now() - startedAt;
    return message;
  });
  return handle;
}

async function embedTexts(handle, adapter, texts) {
  const requestId = nextTextRequestId;
  nextTextRequestId += 1;
  const startedAt = performance.now();
  const message = await requestWorkerMessage(
    handle.child,
    { type: "embed", requestId, texts },
    {
      description: `Text worker request ${requestId}`,
      errorTypes: ["error", "init-error"],
      successType: "result",
      stderrTail: handle.stderrTail,
    }
  );
  if (message.requestId !== requestId) {
    throw new Error(
      `Text worker returned unexpected request id ${message.requestId}`
    );
  }
  assertWorkerIdentity(message, adapter, "Text worker result");
  return {
    latencyMs: performance.now() - startedAt,
    vectors: Array.isArray(message.vectors) ? message.vectors : [],
  };
}

async function shutdownWorker(handle) {
  if (!handle?.child || handle.child.exitCode !== null) {
    return;
  }
  const exited = new Promise((resolve) => {
    handle.child.once("exit", resolve);
  });
  try {
    handle.child.send({ type: "shutdown" });
  } catch {
    handle.child.kill();
  }
  const timer = new Promise((resolve) => setTimeout(resolve, 1000, "timeout"));
  if ((await Promise.race([exited, timer])) === "timeout") {
    handle.child.kill();
    await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(resolve, 1000)),
    ]);
  }
}

function getSuccessfulImageVectors(responses) {
  return responses.flatMap((response) =>
    response.results
      .filter((result) => Array.isArray(result.vector))
      .map((result) => ({ id: String(result.id), vector: result.vector }))
  );
}

function getImageErrors(responses) {
  return responses.flatMap((response) =>
    response.results
      .filter((result) => result.error)
      .map((result) => `${result.id}: ${result.error}`)
  );
}

function summarizeVectors(vectors, expectedDimensions) {
  const dimensions = [...new Set(vectors.map((vector) => vector.length))].sort(
    (left, right) => left - right
  );
  const norms = vectors.map((vector) =>
    Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0))
  );
  const finite = vectors.every((vector) => vector.every(Number.isFinite));
  const dimensionsCorrect = vectors.every(
    (vector) => vector.length === expectedDimensions
  );
  const normalized = norms.every(
    (norm) => Number.isFinite(norm) && Math.abs(norm - 1) <= l2Tolerance
  );
  return {
    expectedDimensions,
    observedDimensions: dimensions,
    minimumL2Norm: roundMetric(norms.length > 0 ? Math.min(...norms) : 0),
    maximumL2Norm: roundMetric(norms.length > 0 ? Math.max(...norms) : 0),
    meanL2Norm: roundMetric(mean(norms)),
    fingerprintCorrect: true,
    adapterIdCorrect: true,
    allVectorsValid:
      vectors.length > 0 && finite && dimensionsCorrect && normalized,
  };
}

async function readObservedRssBytes(processIds) {
  const ids = [...new Set(processIds.filter(Number.isInteger))];
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const shell = path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const command = `$sum=(Get-Process -Id ${ids.join(",")} -ErrorAction SilentlyContinue | Measure-Object -Property WorkingSet64 -Sum).Sum; if ($null -eq $sum) { [Console]::Write('0') } else { [Console]::Write($sum) }`;
      const { stdout } = await execFileAsync(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: 10_000, windowsHide: true }
      );
      const bytes = Number.parseInt(stdout.trim(), 10);
      return Number.isFinite(bytes) && bytes > 0
        ? bytes
        : process.memoryUsage().rss;
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "rss=", "-p", ids.join(",")],
      { timeout: 10_000 }
    );
    const kilobytes = stdout
      .trim()
      .split(whitespaceRegex)
      .map((value) => Number.parseInt(value, 10))
      .filter(Number.isFinite)
      .reduce((sum, value) => sum + value, 0);
    return kilobytes > 0 ? kilobytes * 1024 : process.memoryUsage().rss;
  } catch {
    return process.memoryUsage().rss;
  }
}

let cachedTemperatureUnavailableReason = null;

async function readTemperatureObservation() {
  const observedAt = new Date().toISOString();
  if (cachedTemperatureUnavailableReason) {
    return {
      status: "unavailable",
      source: process.platform,
      observedAt,
      celsius: null,
      reason: cachedTemperatureUnavailableReason,
    };
  }
  try {
    if (process.platform === "win32") {
      const systemRoot = process.env.SystemRoot || "C:\\Windows";
      const shell = path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe"
      );
      const command =
        "$values=@(Get-CimInstance -Namespace root/wmi -ClassName MSAcpi_ThermalZoneTemperature -ErrorAction SilentlyContinue | ForEach-Object { ($_.CurrentTemperature / 10) - 273.15 }); if ($values.Count -gt 0) { [Console]::Write((($values | Measure-Object -Average).Average).ToString([Globalization.CultureInfo]::InvariantCulture)) }";
      const { stdout } = await execFileAsync(
        shell,
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: 5000, windowsHide: true }
      );
      const celsius = Number.parseFloat(stdout.trim());
      if (Number.isFinite(celsius)) {
        return {
          status: "available",
          source: "windows-acpi-wmi-average",
          observedAt,
          celsius: roundMetric(celsius),
          reason: null,
        };
      }
      cachedTemperatureUnavailableReason =
        "No ACPI thermal-zone temperature was exposed by Windows";
    } else if (process.platform === "linux") {
      const thermalRoot = "/sys/class/thermal";
      const entries = fs.existsSync(thermalRoot)
        ? fs
            .readdirSync(thermalRoot)
            .filter((entry) => entry.startsWith("thermal_zone"))
        : [];
      const values = entries
        .map((entry) => path.join(thermalRoot, entry, "temp"))
        .filter((filePath) => fs.existsSync(filePath))
        .map((filePath) => Number.parseFloat(fs.readFileSync(filePath, "utf8")))
        .filter(Number.isFinite)
        .map((value) => (value > 1000 ? value / 1000 : value));
      if (values.length > 0) {
        return {
          status: "available",
          source: "linux-sysfs-average",
          observedAt,
          celsius: roundMetric(mean(values)),
          reason: null,
        };
      }
      cachedTemperatureUnavailableReason =
        "No readable Linux thermal-zone sensor was found";
    } else {
      cachedTemperatureUnavailableReason = `No temperature reader is implemented for ${process.platform}`;
    }
  } catch (error) {
    cachedTemperatureUnavailableReason = `Temperature probe failed: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return {
    status: "unavailable",
    source: process.platform,
    observedAt,
    celsius: null,
    reason: cachedTemperatureUnavailableReason,
  };
}

async function captureMemoryObservation(stage, processIds) {
  const ids = [...new Set(processIds.filter(Number.isInteger))];
  return {
    stage,
    observedAt: new Date().toISOString(),
    processIds: ids,
    combinedRssBytes: await readObservedRssBytes(ids),
    systemFreeBytes: os.freemem(),
  };
}

function makePhotoRequest(sample) {
  return { id: sample.id, path: sample.filePath };
}

async function runProfile({
  hotIterations,
  includeQuality,
  manifest,
  productionContext,
  profile,
  queryDefinitions,
  samples,
  trial,
}) {
  const temperatureAtStart = await readTemperatureObservation();
  const memoryObservations = [
    await captureMemoryObservation("runner-start", [process.pid]),
  ];
  const startedAtIso = new Date().toISOString();
  const startedAt = performance.now();
  const imageHandles = [];
  let textHandle = null;
  const imageErrors = [];
  const textErrors = [];
  try {
    const imageLoadStartedAt = performance.now();
    for (let index = 0; index < profile.actual.workers; index += 1) {
      imageHandles.push(
        launchImageWorker(
          productionContext.workerAdapter,
          profile.actual.threadsPerWorker,
          index
        )
      );
    }
    await Promise.all(imageHandles.map((handle) => handle.ready));
    const imageLoadWallMs = performance.now() - imageLoadStartedAt;
    memoryObservations.push(
      await captureMemoryObservation("image-model-loaded", [
        process.pid,
        ...imageHandles.map((handle) => handle.child.pid),
      ])
    );

    const firstImage = await embedImages(
      imageHandles[0],
      productionContext.workerAdapter,
      [makePhotoRequest(samples[0])]
    );
    imageErrors.push(...getImageErrors([firstImage]));

    const hotResponses = [];
    for (let index = 0; index < hotIterations; index += 1) {
      hotResponses.push(
        await embedImages(imageHandles[0], productionContext.workerAdapter, [
          makePhotoRequest(samples[index % samples.length]),
        ])
      );
    }
    imageErrors.push(...getImageErrors(hotResponses));

    const chunks = splitEvenly(samples, imageHandles.length);
    const batchStartedAt = performance.now();
    const batchResponses = await Promise.all(
      chunks.map((chunk, index) =>
        chunk.length > 0
          ? embedImages(
              imageHandles[index],
              productionContext.workerAdapter,
              chunk.map(makePhotoRequest)
            )
          : Promise.resolve({ latencyMs: 0, results: [] })
      )
    );
    const batchWallMs = performance.now() - batchStartedAt;
    imageErrors.push(...getImageErrors(batchResponses));
    memoryObservations.push(
      await captureMemoryObservation("image-batch-complete", [
        process.pid,
        ...imageHandles.map((handle) => handle.child.pid),
      ])
    );

    const imageVectors = getSuccessfulImageVectors(batchResponses);
    const hotLatencies = hotResponses.map((response) => response.latencyMs);

    textHandle = launchTextWorker(productionContext.workerAdapter);
    await textHandle.ready;
    memoryObservations.push(
      await captureMemoryObservation("text-model-loaded", [
        process.pid,
        ...imageHandles.map((handle) => handle.child.pid),
        textHandle.child.pid,
      ])
    );
    const firstText = await embedTexts(
      textHandle,
      productionContext.workerAdapter,
      [queryDefinitions.queries[0].prompt]
    );
    if (firstText.vectors.length !== 1) {
      throw new Error("Text worker did not return the first embedding");
    }

    const textVectors = [];
    const textLatencies = [];
    for (const query of queryDefinitions.queries) {
      const response = await embedTexts(
        textHandle,
        productionContext.workerAdapter,
        [query.prompt]
      );
      if (response.vectors.length !== 1) {
        textErrors.push(`${query.id}: text worker returned no vector`);
        continue;
      }
      textVectors.push({ id: query.id, vector: response.vectors[0] });
      textLatencies.push({ id: query.id, latencyMs: response.latencyMs });
    }
    const qualitySearchRun = includeQuality
      ? await executeQualitySearch({
          adapter: productionContext.workerAdapter,
          candidateMinimumSimilarity:
            productionContext.thresholdProfile.semanticSearch
              .candidateMinimumSimilarity,
          imageVectors,
          manifest,
          queryDefinitions,
          textHandle,
        })
      : null;
    memoryObservations.push(
      await captureMemoryObservation("text-and-search-complete", [
        process.pid,
        ...imageHandles.map((handle) => handle.child.pid),
        textHandle.child.pid,
      ])
    );

    const finishedAt = performance.now();
    const finishedAtIso = new Date().toISOString();
    const imageVectorValues = imageVectors.map((entry) => entry.vector);
    const textVectorValues = textVectors.map((entry) => entry.vector);
    const imageValidation = summarizeVectors(
      imageVectorValues,
      productionContext.runtimeInfo.dimensions
    );
    const textValidation = summarizeVectors(
      textVectorValues,
      productionContext.runtimeInfo.dimensions
    );
    if (!imageValidation.allVectorsValid) {
      imageErrors.push(
        "One or more image vectors failed dimension, finite-value, or L2 validation"
      );
    }
    if (!textValidation.allVectorsValid) {
      textErrors.push(
        "One or more text vectors failed dimension, finite-value, or L2 validation"
      );
    }
    const errors = [...imageErrors, ...textErrors];
    const temperatureAtEnd = await readTemperatureObservation();
    const peakMemory = Math.max(
      ...memoryObservations.map((observation) => observation.combinedRssBytes)
    );

    return {
      artifacts: {
        imageVectors,
        qualitySearchRun,
        textLatencies,
        textVectors,
      },
      metrics: {
        metricSemantics: getPerformanceMetricSemantics(),
        phases: {
          imageModelLoad: {
            scope:
              "fresh-worker-process-load; operating-system file cache not flushed",
            wallMs: roundMetric(imageLoadWallMs),
            perWorkerMs: imageHandles.map((handle) =>
              roundMetric(handle.loadMs)
            ),
          },
          firstImageInference: {
            scope: "first image request after worker ready",
            latencyMs: roundMetric(firstImage.latencyMs),
          },
          hotSingleImageInference: {
            scope: "one image per sequential production-worker request",
            samplesMs: hotLatencies.map(roundMetric),
            distribution: summarizeDistribution(hotLatencies),
          },
          batchImageEmbedding: {
            scope: "manifest images split across configured production workers",
            itemCount: imageVectors.length,
            wallMs: roundMetric(batchWallMs),
            throughputPerSecond: roundMetric(
              imageVectors.length / (batchWallMs / 1000)
            ),
          },
          textModelLoad: {
            scope:
              "fresh text-worker process load; operating-system file cache not flushed",
            wallMs: roundMetric(textHandle.loadMs),
          },
          textEncoding: {
            scope: "one prompt per sequential production text-worker request",
            firstRequestMs: roundMetric(firstText.latencyMs),
            samplesMs: textLatencies.map((entry) =>
              roundMetric(entry.latencyMs)
            ),
            distribution: summarizeDistribution(
              textLatencies.map((entry) => entry.latencyMs)
            ),
          },
        },
        image: {
          coldStartModelLoadMs: roundMetric(imageLoadWallMs),
          perWorkerLoadMs: imageHandles.map((handle) =>
            roundMetric(handle.loadMs)
          ),
          firstImageInferenceMs: roundMetric(firstImage.latencyMs),
          hotSingleAverageMs: roundMetric(mean(hotLatencies)),
          batchWallMs: roundMetric(batchWallMs),
          batchThroughputPerSecond: roundMetric(
            imageVectors.length / (batchWallMs / 1000)
          ),
          latencyP50Ms: roundMetric(percentile(hotLatencies, 0.5)),
          latencyP95Ms: roundMetric(percentile(hotLatencies, 0.95)),
          workerCount: imageHandles.length,
          threadsPerWorker: profile.actual.threadsPerWorker,
          errors: imageErrors.length,
          vectorValidation: imageValidation,
        },
        text: {
          coldStartModelLoadMs: roundMetric(textHandle.loadMs),
          firstEmbeddingMs: roundMetric(firstText.latencyMs),
          averageEmbeddingMs: roundMetric(
            mean(textLatencies.map((entry) => entry.latencyMs))
          ),
          latencyP50Ms: roundMetric(
            percentile(
              textLatencies.map((entry) => entry.latencyMs),
              0.5
            )
          ),
          latencyP95Ms: roundMetric(
            percentile(
              textLatencies.map((entry) => entry.latencyMs),
              0.95
            )
          ),
          errors: textErrors.length,
          vectorValidation: textValidation,
        },
        errorsTotal: errors.length,
        observedPeakProcessMemoryBytes: peakMemory,
      },
      resourceObservations: {
        memory: {
          samples: memoryObservations,
          observedPeakCombinedRssBytes: peakMemory,
        },
        temperature: {
          start: temperatureAtStart,
          end: temperatureAtEnd,
        },
        workerProcesses: {
          imageWorkerPids: imageHandles.map((handle) => handle.child.pid),
          textWorkerPid: textHandle.child.pid,
        },
      },
      run: {
        startedAt: startedAtIso,
        finishedAt: finishedAtIso,
        durationMs: roundMetric(finishedAt - startedAt),
        errors,
      },
      trial,
    };
  } finally {
    await Promise.allSettled([
      ...imageHandles.map(shutdownWorker),
      ...(textHandle ? [shutdownWorker(textHandle)] : []),
    ]);
  }
}

function cosine(left, right) {
  let score = 0;
  for (let index = 0; index < left.length; index += 1) {
    score += left[index] * right[index];
  }
  return score;
}

async function executeQualitySearch({
  adapter,
  candidateMinimumSimilarity,
  imageVectors,
  manifest,
  queryDefinitions,
  textHandle,
}) {
  const startedAt = performance.now();
  const startedAtIso = new Date().toISOString();
  const imageVectorById = new Map(
    imageVectors.map((entry) => [entry.id, entry.vector])
  );
  const queries = [];
  for (const query of queryDefinitions.queries) {
    const endToEndStartedAt = performance.now();
    const textResponse = await embedTexts(textHandle, adapter, [query.prompt]);
    if (textResponse.vectors.length !== 1) {
      throw new Error(`Missing text vector for quality query ${query.id}`);
    }

    const scoringStartedAt = performance.now();
    const scored = manifest.samples.map((sample) => {
      const imageVector = imageVectorById.get(sample.id);
      if (!imageVector) {
        throw new Error(`Missing image vector for quality sample ${sample.id}`);
      }
      return {
        contentHash: sample.id,
        score: cosine(textResponse.vectors[0], imageVector),
      };
    });
    const scoringMs = performance.now() - scoringStartedAt;

    const filteringStartedAt = performance.now();
    const filtered = scored.filter(
      (result) => result.score >= candidateMinimumSimilarity
    );
    const filteringMs = performance.now() - filteringStartedAt;

    const sortingStartedAt = performance.now();
    filtered.sort((left, right) => right.score - left.score);
    const sortingMs = performance.now() - sortingStartedAt;
    const endToEndSearchMs = performance.now() - endToEndStartedAt;

    queries.push({
      id: query.id,
      latencyMs: roundMetric(endToEndSearchMs),
      latencyPhases: {
        textEncodingMs: roundMetric(textResponse.latencyMs),
        scoringMs: roundMetric(scoringMs),
        filteringMs: roundMetric(filteringMs),
        sortingMs: roundMetric(sortingMs),
        endToEndSearchMs: roundMetric(endToEndSearchMs),
      },
      results: filtered,
    });
  }
  const finishedAt = performance.now();
  return {
    scope:
      "production text-worker encoding + in-memory cosine scoring + production candidate threshold + score sorting",
    excludes: [
      "semantic query planning",
      "translation",
      "database/vector-index I/O",
      "renderer IPC",
    ],
    run: {
      startedAt: startedAtIso,
      finishedAt: new Date().toISOString(),
      durationMs: roundMetric(finishedAt - startedAt),
      errors: [],
    },
    queries,
  };
}

function buildQualityMetrics({
  manifest,
  qualitySearchRun,
  queryDefinitions,
  thresholdProfile,
}) {
  const candidateMinimumSimilarity =
    thresholdProfile.semanticSearch.candidateMinimumSimilarity;
  const evaluatorManifest = {
    version: manifest.datasetVersion,
    errorCategoryByContentHash: Object.fromEntries(
      manifest.samples.map((sample) => [sample.id, sample.errorCategory])
    ),
    queries: queryDefinitions.queries.map((query) => ({
      id: query.id,
      query: query.text,
      category: query.category,
      intent: query.intent,
      relevantContentHashes: query.relevantSampleIds,
      hardNegativeContentHashes: query.hardNegativeSampleIds ?? [],
    })),
  };
  const evaluated = evaluateSemanticRun(evaluatorManifest, {
    queries: qualitySearchRun.queries,
  });
  return {
    queryCount: evaluated.queries,
    candidateMinimumSimilarity,
    searchLatencyScope: {
      scope: qualitySearchRun.scope,
      excludes: qualitySearchRun.excludes,
    },
    canonical: {
      hitAt1: evaluated.macro.hitAt1,
      hitAt3: evaluated.macro.hitAt3,
      hitAt5: evaluated.macro.hitAt5,
      hitAt10: evaluated.macro.hitAt10,
      meanReciprocalRank: evaluated.macro.meanReciprocalRank,
      recallAt5: evaluated.macro.recallAt5,
      recallAt10: evaluated.macro.recallAt10,
      fixedCutoffPrecisionAt5: evaluated.macro.fixedCutoffPrecisionAt5,
      fixedCutoffPrecisionAt10: evaluated.macro.fixedCutoffPrecisionAt10,
      fixedCutoffPrecisionAt20: evaluated.macro.fixedCutoffPrecisionAt20,
      fixedCutoffPrecisionAt50: evaluated.macro.fixedCutoffPrecisionAt50,
      hardNegativeFalsePositiveRateAt1:
        evaluated.macro.hardNegativeFalsePositiveRateAt1,
      hardNegativeFalsePositiveRateAt3:
        evaluated.macro.hardNegativeFalsePositiveRateAt3,
      hardNegativeFalsePositiveRateAt5:
        evaluated.macro.hardNegativeFalsePositiveRateAt5,
      hardNegativeFalsePositiveRateAt10:
        evaluated.macro.hardNegativeFalsePositiveRateAt10,
      hardNegativeQueryCount: evaluated.macro.hardNegativeQueryCount,
      ndcgAt50: evaluated.macro.ndcgAt50,
      returnedCountDistribution: evaluated.returnedCountDistribution,
      latencyPhases: evaluated.latencyPhases,
    },
    macro: {
      precisionAt20: evaluated.macro.precisionAt20,
      precisionAt50: evaluated.macro.precisionAt50,
      recallAt50: evaluated.macro.recallAt50,
      recallAt200: evaluated.macro.recallAt200,
      ndcgAt50: evaluated.macro.ndcgAt50,
      p95LatencyMs: evaluated.macro.p95LatencyMs,
      emptyResultRate: evaluated.macro.emptyResultRate,
    },
    metricSemantics: evaluated.metricSemantics,
    errorCategories: evaluated.errorCategories,
    perQuery: evaluated.perQuery,
  };
}

function buildAdapterIdentity(productionContext) {
  const runtime = productionContext.runtimeInfo;
  return {
    adapterId: runtime.adapterId,
    modelId: runtime.modelId,
    revision: runtime.revision,
    embeddingFingerprint: runtime.fingerprint,
    embeddingDimensions: runtime.dimensions,
    thresholdProfileId: runtime.thresholdProfileId,
  };
}

function buildBenchmarkIdentity({
  datasetManifestFingerprint,
  datasetVersion,
  queryDefinitions,
  queryDefinitionFingerprint,
  queryPlanFingerprint,
  sampleCount,
}) {
  return {
    datasetVersion,
    datasetManifestFingerprint,
    queryDefinitionVersion: queryDefinitions.queryDefinitionVersion,
    queryDefinitionFingerprint,
    queryPlanFingerprint,
    sampleCount,
    queryCount: queryDefinitions.queries.length,
  };
}

function ensureReportsOutput(outputDir) {
  const relative = path.relative(reportsRoot, outputDir);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Benchmark reports must be written below ${reportsRoot}`);
  }
}

async function writeReport(outputDir, fileName, report) {
  const filePath = path.join(outputDir, fileName);
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.tmp-${process.pid}`;
  await fs.promises.writeFile(
    temporaryPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
  );
  await fs.promises.rename(temporaryPath, filePath);
  return filePath;
}

function makeRunId() {
  return `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`;
}

function selectProfileIds(options, qualityRequested) {
  if (options.mode === "quality") {
    return ["standard"];
  }
  const selected =
    options.profile === "all" ? ["low", "standard", "high"] : [options.profile];
  if (qualityRequested && !selected.includes("standard")) {
    selected.push("standard");
  }
  return selected;
}

function buildTrialSchedule(profileIds, trialsPerProfile) {
  const schedule = [];
  let executionOrder = 1;
  for (let round = 1; round <= trialsPerProfile; round += 1) {
    const offset = (round - 1) % profileIds.length;
    const profileOrder = [
      ...profileIds.slice(offset),
      ...profileIds.slice(0, offset),
    ];
    for (const profileId of profileOrder) {
      schedule.push({
        profileId,
        trialNumber: round,
        trialsPerProfile,
        round,
        executionOrder,
        profileOrder,
        freshWorkerProcesses: true,
      });
      executionOrder += 1;
    }
  }
  return schedule;
}

function getPerformanceMetricSemantics() {
  return {
    "metrics.image.coldStartModelLoadMs": {
      status: "legacy-compatible",
      canonicalReplacement: "metrics.phases.imageModelLoad.wallMs",
      caveat:
        "Fresh worker process load; operating-system file cache is not flushed",
    },
    "metrics.image.firstImageInferenceMs": {
      status: "legacy-compatible",
      canonicalReplacement: "metrics.phases.firstImageInference.latencyMs",
    },
    "metrics.image.hotSingleAverageMs": {
      status: "legacy-compatible",
      canonicalReplacement:
        "metrics.phases.hotSingleImageInference.distribution",
    },
    "metrics.image.batchThroughputPerSecond": {
      status: "legacy-compatible",
      canonicalReplacement:
        "metrics.phases.batchImageEmbedding.throughputPerSecond",
    },
    "metrics.text.averageEmbeddingMs": {
      status: "legacy-compatible",
      canonicalReplacement: "metrics.phases.textEncoding.distribution",
      caveat: "Text encoding only; not end-to-end search latency",
    },
    "metrics.text.latencyP95Ms": {
      status: "legacy-compatible",
      canonicalReplacement: "metrics.phases.textEncoding.distribution.p95",
      caveat: "Text encoding only; never compare directly with search P95",
    },
  };
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: CLI orchestration keeps validation, trial scheduling, and artifact generation in one auditable entry point.
export async function runSiglipV1Baseline(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  if (options.help) {
    printHelp();
    return { reports: [] };
  }
  const definitions = loadAndValidateDefinitions();
  if (options.validateOnly) {
    const result = {
      datasetVersion: definitions.manifest.datasetVersion,
      queryDefinitionVersion:
        definitions.queryDefinitions.queryDefinitionVersion,
      samples: definitions.manifest.samples.length,
      queries: definitions.queryDefinitions.queries.length,
      ...definitions.fingerprints,
    };
    console.log(JSON.stringify(result, null, 2));
    return { reports: [], validation: result };
  }

  const productionContext = await loadProductionContext(options.modelRoot);
  const profiles = resolveProfiles(productionContext.automaticWorkerConfig);
  const environment = getEnvironment();
  const adapter = buildAdapterIdentity(productionContext);
  const runId = makeRunId();
  const outputDir = options.outputDir
    ? options.outputDir
    : path.join(reportsRoot, "siglip-v1-baseline", runId);
  ensureReportsOutput(outputDir);

  const qualityRequested = options.mode === "all" || options.mode === "quality";
  const performanceRequested =
    options.mode === "all" || options.mode === "performance";
  const baselineSamples =
    qualityRequested || !options.performanceInput
      ? resolveBaselineSamples(
          definitions.manifest,
          options.datasetRoot,
          performanceRequested ? options.sampleLimit : null
        )
      : null;
  const performanceSamples = options.performanceInput
    ? resolveAdHocSamples(options.performanceInput, options.sampleLimit)
    : baselineSamples;
  const selectedProfileIds = selectProfileIds(options, qualityRequested);
  const uniqueProfileIds = [...new Set(selectedProfileIds)];
  const schedule = buildTrialSchedule(uniqueProfileIds, options.trials);
  const rawTrials = [];

  const adHocIdentity = options.performanceInput
    ? {
        datasetVersion: "ad-hoc-performance-input-v1",
        datasetManifestFingerprint: sha256Canonical(
          performanceSamples.map((sample) => ({
            fileName: sample.fileName,
            sizeBytes: fs.statSync(sample.filePath).size,
          }))
        ),
      }
    : {
        datasetVersion: definitions.manifest.datasetVersion,
        datasetManifestFingerprint:
          definitions.fingerprints.datasetManifestFingerprint,
      };

  if (environment.nodeBaselineStatus !== "supported") {
    console.error(
      `[siglip-baseline] warning: Node 22 is required for acceptance; current=${environment.nodeVersion}`
    );
  }

  for (const trial of schedule) {
    const profile = profiles[trial.profileId];
    console.error(
      `[siglip-baseline] order=${trial.executionOrder} round=${trial.round} ${trial.profileId} trial=${trial.trialNumber}/${trial.trialsPerProfile}: ${profile.actual.workers} worker(s), ${profile.actual.threadsPerWorker} thread(s)`
    );
    const samples =
      trial.profileId === "standard" && qualityRequested
        ? resolveBaselineSamples(
            definitions.manifest,
            options.datasetRoot,
            null
          )
        : performanceSamples;
    const result = await runProfile({
      hotIterations: options.hotIterations,
      includeQuality: qualityRequested && trial.profileId === "standard",
      manifest: definitions.manifest,
      productionContext,
      profile,
      queryDefinitions: definitions.queryDefinitions,
      samples,
      trial,
    });
    if (performanceRequested) {
      const benchmark = buildBenchmarkIdentity({
        ...adHocIdentity,
        queryDefinitions: definitions.queryDefinitions,
        queryDefinitionFingerprint:
          definitions.fingerprints.queryDefinitionFingerprint,
        queryPlanFingerprint: definitions.fingerprints.queryPlanFingerprint,
        sampleCount: samples.length,
      });
      const report = {
        schemaVersion: 2,
        reportType: "performance-trial",
        adapter,
        benchmark,
        environment,
        performanceProfile: profile,
        trial,
        run: result.run,
        resourceObservations: result.resourceObservations,
        metrics: result.metrics,
      };
      const fileName = path.join(
        "trials",
        `performance-${trial.profileId}-trial-${String(trial.trialNumber).padStart(2, "0")}.json`
      );
      await writeReport(outputDir, fileName, report);
      rawTrials.push({
        fileName: fileName.replaceAll("\\", "/"),
        reportType: report.reportType,
        profileId: trial.profileId,
        trialNumber: trial.trialNumber,
        executionOrder: trial.executionOrder,
      });
    }
    if (qualityRequested && trial.profileId === "standard") {
      const qualitySearchRun = result.artifacts.qualitySearchRun;
      if (!qualitySearchRun) {
        throw new Error("The standard trial did not produce quality searches");
      }
      const qualityMetrics = buildQualityMetrics({
        manifest: definitions.manifest,
        qualitySearchRun,
        queryDefinitions: definitions.queryDefinitions,
        thresholdProfile: productionContext.thresholdProfile,
      });
      const qualityReport = {
        schemaVersion: 2,
        reportType: "quality-trial",
        adapter,
        benchmark: buildBenchmarkIdentity({
          datasetVersion: definitions.manifest.datasetVersion,
          datasetManifestFingerprint:
            definitions.fingerprints.datasetManifestFingerprint,
          queryDefinitions: definitions.queryDefinitions,
          queryDefinitionFingerprint:
            definitions.fingerprints.queryDefinitionFingerprint,
          queryPlanFingerprint: definitions.fingerprints.queryPlanFingerprint,
          sampleCount: definitions.manifest.samples.length,
        }),
        environment,
        performanceProfile: profiles.standard,
        trial,
        run: {
          ...qualitySearchRun.run,
          errors: [...result.run.errors, ...qualitySearchRun.run.errors],
        },
        resourceObservations: result.resourceObservations,
        metrics: qualityMetrics,
      };
      const fileName = path.join(
        "trials",
        `quality-standard-trial-${String(trial.trialNumber).padStart(2, "0")}.json`
      );
      await writeReport(outputDir, fileName, qualityReport);
      rawTrials.push({
        fileName: fileName.replaceAll("\\", "/"),
        reportType: qualityReport.reportType,
        profileId: trial.profileId,
        trialNumber: trial.trialNumber,
        executionOrder: trial.executionOrder,
      });
    }
  }

  const indexPath = await writeReport(outputDir, "run-index.json", {
    schemaVersion: 2,
    runId,
    createdAt: new Date().toISOString(),
    adapter,
    definitions: {
      datasetVersion: definitions.manifest.datasetVersion,
      datasetManifestFingerprint:
        definitions.fingerprints.datasetManifestFingerprint,
      queryDefinitionVersion:
        definitions.queryDefinitions.queryDefinitionVersion,
      queryDefinitionFingerprint:
        definitions.fingerprints.queryDefinitionFingerprint,
      queryPlanFingerprint: definitions.fingerprints.queryPlanFingerprint,
    },
    environment,
    trialPlan: {
      trialsPerProfile: options.trials,
      scheduling: "deterministic-rotating-round-robin",
      executionOrder: schedule,
    },
    rawTrials,
    reports: [],
    generatedArtifacts: null,
  });
  const generated = await generateRunArtifacts(outputDir);
  const result = {
    outputDir,
    index: indexPath,
    reports: generated.reportPaths,
    summaryJson: generated.summaryJsonPath,
    summaryMarkdown: generated.summaryMarkdownPath,
  };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runSiglipV1Baseline().catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exitCode = 1;
  });
}
