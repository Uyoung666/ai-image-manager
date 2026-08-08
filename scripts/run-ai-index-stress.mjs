/**
 * Long-running SigLIP v1 production-chain acceptance workload.
 *
 * This runner deliberately creates a synthetic logical workload by cycling a
 * stable, sorted list of local source images. Reports must not be interpreted
 * as quality coverage for 500-5000 distinct real photos.
 */
import { execFile, fork } from "node:child_process";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { connect } from "@lancedb/lancedb";
import {
  Field,
  FixedSizeList,
  Float32,
  Float64,
  Int32,
  Schema,
} from "apache-arrow";
import { createServer } from "vite";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(import.meta.dirname, "..");
const reportsRoot = path.join(repoRoot, "reports");
const defaultModelRoot = path.join(repoRoot, "models");
const defaultInput = path.join(repoRoot, "images", "demo.png");
const sourceWorkerRoot = path.join(repoRoot, "scripts");
const imageExtensions = new Set([".avif", ".jpeg", ".jpg", ".png", ".webp"]);
const workerTimeoutMs = 300_000;
const l2Tolerance = 0.001;
const lineBreakRegex = /\r?\n/u;
const steadyStateWarmupSegmentCount = 2;
const whitespaceRegex = /\s+/u;

function takeOption(argv, index, label) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${label} requires a value`);
  }
  return value;
}

function parseInteger(value, label, minimum = 1) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || parsed < minimum) {
    throw new Error(`${label} must be an integer >= ${minimum}`);
  }
  return parsed;
}

function assertReportPath(outputDir) {
  const relative = path.relative(reportsRoot, outputDir);
  if (
    relative === "" ||
    relative.startsWith("..") ||
    path.isAbsolute(relative)
  ) {
    throw new Error("--output-dir must be a child directory of ./reports");
  }
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit CLI branches keep destructive-path and workload bounds auditable.
export function parseStressArguments(argv) {
  const options = {
    allowErrors: false,
    cancelAfter: null,
    count: 500,
    help: false,
    injectFailureAt: null,
    input: defaultInput,
    keepWorkdir: false,
    modelRoot: defaultModelRoot,
    outputDir: null,
    packagedResources: null,
    pauseAfter: null,
    pauseMs: 1000,
    restartWorkerAfter: null,
    segmentSize: null,
    validateOnly: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-errors") {
      options.allowErrors = true;
    } else if (argument === "--count") {
      options.count = parseInteger(
        takeOption(argv, index, "--count"),
        "--count"
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
      assertReportPath(options.outputDir);
      index += 1;
    } else if (argument === "--packaged-resources") {
      options.packagedResources = path.resolve(
        takeOption(argv, index, "--packaged-resources")
      );
      index += 1;
    } else if (argument === "--segment-size") {
      options.segmentSize = parseInteger(
        takeOption(argv, index, "--segment-size"),
        "--segment-size"
      );
      index += 1;
    } else if (argument === "--pause-after") {
      options.pauseAfter = parseInteger(
        takeOption(argv, index, "--pause-after"),
        "--pause-after"
      );
      index += 1;
    } else if (argument === "--pause-ms") {
      options.pauseMs = parseInteger(
        takeOption(argv, index, "--pause-ms"),
        "--pause-ms",
        0
      );
      index += 1;
    } else if (argument === "--restart-worker-after") {
      options.restartWorkerAfter = parseInteger(
        takeOption(argv, index, "--restart-worker-after"),
        "--restart-worker-after"
      );
      index += 1;
    } else if (argument === "--cancel-after") {
      options.cancelAfter = parseInteger(
        takeOption(argv, index, "--cancel-after"),
        "--cancel-after"
      );
      index += 1;
    } else if (argument === "--inject-failure-at") {
      options.injectFailureAt = parseInteger(
        takeOption(argv, index, "--inject-failure-at"),
        "--inject-failure-at"
      );
      index += 1;
    } else if (argument === "--keep-workdir") {
      options.keepWorkdir = true;
    } else if (argument === "--validate-only") {
      options.validateOnly = true;
    } else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }

  if (options.count < 500 || options.count > 5000) {
    throw new Error("--count must be between 500 and 5000");
  }
  for (const [label, value] of [
    ["--pause-after", options.pauseAfter],
    ["--restart-worker-after", options.restartWorkerAfter],
    ["--cancel-after", options.cancelAfter],
    ["--inject-failure-at", options.injectFailureAt],
  ]) {
    if (value !== null && value > options.count) {
      throw new Error(`${label} must not exceed --count`);
    }
  }
  if (
    options.restartWorkerAfter !== null &&
    options.restartWorkerAfter >= options.count
  ) {
    throw new Error("--restart-worker-after must be less than --count");
  }
  return options;
}

function printHelp() {
  console.log(`Usage:
  node scripts/run-ai-index-stress.mjs [options]

Options:
  --allow-errors              Exit zero when the report contains expected item errors
  --count <500-5000>          Synthetic logical image count (default: 500)
  --input <file-or-dir>       Stable local source image(s) (default: images/demo.png)
  --model-root <dir>          Current model asset root (default: ./models)
  --segment-size <count>      Logical items per measured segment
  --pause-after <count>       Pause once after this many logical items, then resume
  --pause-ms <ms>             Pause duration (default: 1000)
  --restart-worker-after <n>  Restart image worker(s) at a batch boundary
  --cancel-after <count>      Stop at a batch boundary and verify no fingerprint publish
  --inject-failure-at <id>    Replace one logical path with a missing path
  --packaged-resources <dir>  Compare source and packaged image/text worker behavior
  --output-dir <reports/...>  Report directory (must remain below ./reports)
  --keep-workdir              Preserve temporary userData/vector files below the report
  --validate-only             Validate the 500-5000 synthetic workload plan only`);
}

async function collectImageFiles(inputPath) {
  const stat = await fsPromises.stat(inputPath);
  if (stat.isFile()) {
    if (!imageExtensions.has(path.extname(inputPath).toLowerCase())) {
      throw new Error(`Unsupported image input: ${inputPath}`);
    }
    return [path.resolve(inputPath)];
  }
  if (!stat.isDirectory()) {
    throw new Error(`Input is not a file or directory: ${inputPath}`);
  }
  const files = [];
  const pending = [path.resolve(inputPath)];
  while (pending.length > 0) {
    const directory = pending.pop();
    const entries = await fsPromises.readdir(directory, {
      withFileTypes: true,
    });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (
        entry.isFile() &&
        imageExtensions.has(path.extname(entry.name).toLowerCase())
      ) {
        files.push(entryPath);
      }
    }
  }
  files.sort((left, right) => left.localeCompare(right));
  if (files.length === 0) {
    throw new Error(`No supported images found under ${inputPath}`);
  }
  return files;
}

export function buildSyntheticWorkload(
  sourceImages,
  count,
  missingPath,
  failureAt
) {
  if (!Array.isArray(sourceImages) || sourceImages.length === 0) {
    throw new Error("Synthetic workload requires at least one source image");
  }
  return Array.from({ length: count }, (_, index) => ({
    id: index + 1,
    path:
      failureAt === index + 1
        ? missingPath
        : sourceImages[index % sourceImages.length],
    sourceIndex: index % sourceImages.length,
  }));
}

function round(value, digits = 3) {
  return Number(value.toFixed(digits));
}

export function summarizeMemoryTrend(samples, scope = "fullRun") {
  const valid = samples.filter(
    (sample) =>
      Number.isFinite(sample.completed) && Number.isFinite(sample.totalRssBytes)
  );
  if (valid.length === 0) {
    return {
      assessment: "rss-unavailable",
      firstRssBytes: null,
      lastRssBytes: null,
      leakReviewRecommended: false,
      peakRssBytes: null,
      rssDeltaBytes: null,
      rssSlopeBytesPer100Items: null,
      sampleCount: 0,
    };
  }
  const first = valid[0].totalRssBytes;
  const last = valid.at(-1).totalRssBytes;
  const meanX =
    valid.reduce((sum, sample) => sum + sample.completed, 0) / valid.length;
  const meanY =
    valid.reduce((sum, sample) => sum + sample.totalRssBytes, 0) / valid.length;
  const numerator = valid.reduce(
    (sum, sample) =>
      sum + (sample.completed - meanX) * (sample.totalRssBytes - meanY),
    0
  );
  const denominator = valid.reduce(
    (sum, sample) => sum + (sample.completed - meanX) ** 2,
    0
  );
  const slopePer100 = denominator > 0 ? (numerator / denominator) * 100 : 0;
  const rssDeltaBytes = last - first;
  const sustainedUpwardTrend =
    valid.length >= 3 && slopePer100 > 0 && rssDeltaBytes > 0;
  let assessment = "no-upward-rss-trend-observed-not-proof-of-no-leak";
  if (valid.length < 3) {
    assessment = "insufficient-segment-samples";
  } else if (sustainedUpwardTrend && scope === "steadyState") {
    assessment = "steady-state-upward-rss-trend-observed-review-required";
  } else if (sustainedUpwardTrend) {
    assessment = "full-run-upward-rss-trend-includes-warmup-no-leak-conclusion";
  }
  return {
    assessment,
    firstRssBytes: first,
    lastRssBytes: last,
    leakReviewRecommended: scope === "steadyState" && sustainedUpwardTrend,
    peakRssBytes: Math.max(...valid.map((sample) => sample.totalRssBytes)),
    rssDeltaBytes,
    rssSlopeBytesPer100Items: round(slopePer100),
    sampleCount: valid.length,
  };
}

export function summarizeMemoryTrends(samples) {
  const processingSamples = samples.filter(
    (sample) =>
      sample.phase === undefined ||
      sample.phase === "workers-ready" ||
      sample.phase === "workers-restarted" ||
      sample.phase === "segment"
  );
  const steadyStateSamples = processingSamples.slice(
    steadyStateWarmupSegmentCount
  );
  return {
    fullRun: summarizeMemoryTrend(processingSamples, "fullRun"),
    steadyState: summarizeMemoryTrend(steadyStateSamples, "steadyState"),
    warmupCutoff: {
      completedLogicalItems:
        processingSamples[steadyStateWarmupSegmentCount]?.completed ?? null,
      sampleIndex: steadyStateWarmupSegmentCount,
      skippedSegmentCount: steadyStateWarmupSegmentCount,
      strategy: "skip-first-segments-use-cutoff-sample-as-steady-baseline",
    },
  };
}

export function summarizeMemoryEpochs(samples) {
  const generations = [
    ...new Set(
      samples.map((sample) => sample.workerGeneration).filter(Number.isInteger)
    ),
  ];
  return Object.fromEntries(
    generations.map((generation) => {
      const epochSamples = samples.filter(
        (sample) =>
          sample.workerGeneration === generation &&
          ["workers-ready", "workers-restarted", "segment"].includes(
            sample.phase
          )
      );
      return [String(generation), summarizeMemoryTrends(epochSamples)];
    })
  );
}

export function resolveStressExitCode(report) {
  return report?.status === "completed-with-errors" &&
    report.controls?.allowErrors !== true
    ? 1
    : 0;
}

async function loadProductionContext(modelRoot) {
  const virtualElectronId = "\0ai-index-stress-electron";
  const server = await createServer({
    appType: "custom",
    configFile: false,
    logLevel: "silent",
    plugins: [
      {
        name: "ai-index-stress-electron-stub",
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
            getAppPath: () => process.cwd(),
            getPath: () => process.cwd()
          };`;
        },
      },
    ],
    resolve: { alias: { "@": path.join(repoRoot, "src") } },
    root: repoRoot,
    server: { middlewareMode: true },
    ssr: { noExternal: ["electron"] },
  });
  try {
    const [modelConfig, fingerprintModule, workerPool] = await Promise.all([
      server.ssrLoadModule("/src/services/ai/model-config.ts"),
      server.ssrLoadModule("/src/services/ai/model-fingerprint.ts"),
      server.ssrLoadModule("/src/services/embed-worker-pool.ts"),
    ]);
    const runtimeInfo = modelConfig.getActiveEmbeddingRuntimeInfo();
    const workerAdapter =
      modelConfig.getActiveEmbeddingWorkerAdapter(modelRoot);
    const artifactsValid = await fingerprintModule.verifyAdapterArtifacts(
      modelRoot,
      (
        await server.ssrLoadModule("/src/services/ai/model-adapter.ts")
      ).getActiveEmbeddingAdapter().artifacts
    );
    if (!artifactsValid) {
      throw new Error(
        `Active adapter artifacts failed validation: ${modelRoot}`
      );
    }
    return {
      close: () => server.close(),
      createWorkerAdapter: (root) =>
        modelConfig.getActiveEmbeddingWorkerAdapter(root),
      inspectStoredVectorFingerprint:
        fingerprintModule.inspectStoredVectorFingerprint,
      runtimeInfo,
      shouldPublishVectorFingerprint:
        fingerprintModule.shouldPublishVectorFingerprint,
      workerAdapter,
      workerConfig: workerPool.resolveEmbedPoolConfig(os.cpus().length, false),
      writeStoredVectorFingerprint:
        fingerprintModule.writeStoredVectorFingerprint,
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}

function launchWorker(scriptPath, env) {
  let stderr = "";
  const child = fork(scriptPath, [], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.on("data", (chunk) => {
    stderr = `${stderr}${chunk.toString()}`.slice(-4000);
  });
  return { child, scriptPath, stderrTail: () => stderr };
}

function requestWorker(handle, message, predicate, description) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      handle.child.off("error", onError);
      handle.child.off("exit", onExit);
      handle.child.off("message", onMessage);
    };
    const fail = (error) => {
      cleanup();
      reject(error);
    };
    const onError = (error) => fail(error);
    const onExit = (code, signal) =>
      fail(
        new Error(
          `${description}: worker exited code=${String(code)} signal=${String(signal)} ${handle.stderrTail()}`
        )
      );
    const onMessage = (response) => {
      if (!predicate(response)) {
        return;
      }
      cleanup();
      resolve(response);
    };
    const timeout = setTimeout(
      () =>
        fail(
          new Error(
            `${description}: timed out after ${workerTimeoutMs}ms ${handle.stderrTail()}`
          )
        ),
      workerTimeoutMs
    );
    handle.child.on("error", onError);
    handle.child.on("exit", onExit);
    handle.child.on("message", onMessage);
    handle.child.send(message);
  });
}

function assertIdentity(message, adapter, label) {
  if (
    message.adapterId !== adapter.adapterId ||
    message.fingerprint !== adapter.fingerprint
  ) {
    throw new Error(`${label} returned stale adapter identity`);
  }
}

function validateVector(vector, dimensions, label) {
  if (
    !Array.isArray(vector) ||
    vector.length !== dimensions ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(`${label} must contain ${dimensions} finite values`);
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (!Number.isFinite(norm) || Math.abs(norm - 1) > l2Tolerance) {
    throw new Error(`${label} is not L2 normalized (norm=${String(norm)})`);
  }
  return norm;
}

async function launchImageWorker(scriptPath, adapter, threads, env) {
  const handle = launchWorker(scriptPath, env);
  const ready = await requestWorker(
    handle,
    {
      type: "init",
      adapter,
      execution: { intraOpNumThreads: threads, provider: "cpu" },
    },
    (message) => message.type === "ready" || message.type === "init-error",
    `Initialize image worker ${scriptPath}`
  );
  if (ready.type === "init-error") {
    throw new Error(ready.error ?? "Image worker initialization failed");
  }
  assertIdentity(ready, adapter, "Image worker ready");
  return handle;
}

async function embedImageBatch(handle, adapter, items) {
  const response = await requestWorker(
    handle,
    {
      type: "embed",
      photos: items.map(({ id, path: imagePath }) => ({ id, path: imagePath })),
    },
    (message) => message.type === "result",
    "Image worker batch"
  );
  assertIdentity(response, adapter, "Image worker result");
  if (!Array.isArray(response.results)) {
    throw new Error("Image worker result did not contain a results array");
  }
  return response.results;
}

async function launchTextWorker(scriptPath, adapter, env) {
  const handle = launchWorker(scriptPath, env);
  const ready = await requestWorker(
    handle,
    { type: "init", adapter },
    (message) => message.type === "ready" || message.type === "init-error",
    `Initialize text worker ${scriptPath}`
  );
  if (ready.type === "init-error") {
    throw new Error(ready.error ?? "Text worker initialization failed");
  }
  assertIdentity(ready, adapter, "Text worker ready");
  return handle;
}

async function embedText(handle, adapter, text, requestId) {
  const response = await requestWorker(
    handle,
    { type: "embed", requestId, texts: [text] },
    (message) =>
      message.requestId === requestId &&
      (message.type === "result" || message.type === "error"),
    "Text worker request"
  );
  if (response.type === "error") {
    throw new Error(response.error ?? "Text worker request failed");
  }
  assertIdentity(response, adapter, "Text worker result");
  const vector = response.vectors?.[0];
  validateVector(vector, adapter.text.dimensions, "Text worker vector");
  return vector;
}

async function shutdownWorker(handle) {
  if (!handle || handle.child.exitCode !== null) {
    return;
  }
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      handle.child.kill();
      resolve();
    }, 1000);
    handle.child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      handle.child.send({ type: "shutdown" });
    } catch {
      handle.child.kill();
    }
  });
}

async function readWorkerMemory(processIds) {
  const ids = processIds.filter((id) => Number.isInteger(id) && id > 0);
  if (ids.length === 0) {
    return [];
  }
  try {
    if (process.platform === "win32") {
      const idList = ids.join(",");
      const command = `$items = Get-Process -Id ${idList} -ErrorAction SilentlyContinue; $items | ForEach-Object { "$($_.Id),$($_.WorkingSet64)" }`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { timeout: 10_000 }
      );
      return stdout
        .split(lineBreakRegex)
        .filter(Boolean)
        .map((line) => {
          const [pid, rssBytes] = line.trim().split(",").map(Number);
          return { pid, rssBytes };
        })
        .filter(
          (entry) =>
            Number.isInteger(entry.pid) && Number.isFinite(entry.rssBytes)
        );
    }
    const { stdout } = await execFileAsync(
      "ps",
      ["-o", "pid=,rss=", "-p", ids.join(",")],
      { timeout: 10_000 }
    );
    const values = stdout.split(whitespaceRegex).filter(Boolean).map(Number);
    const workers = [];
    for (let index = 0; index < values.length; index += 2) {
      const pid = values[index];
      const rssKilobytes = values[index + 1];
      if (Number.isInteger(pid) && Number.isFinite(rssKilobytes)) {
        workers.push({ pid, rssBytes: rssKilobytes * 1024 });
      }
    }
    return workers;
  } catch {
    return null;
  }
}

async function sampleMemory(
  completed,
  handles,
  phase = "segment",
  workerGeneration = 1
) {
  const parentUsage = process.memoryUsage();
  const workerProcesses = await readWorkerMemory(
    handles.map((handle) => handle.child.pid)
  );
  const workerRssBytes =
    workerProcesses === null
      ? null
      : workerProcesses.reduce((sum, worker) => sum + worker.rssBytes, 0);
  return {
    completed,
    parentMemory: {
      arrayBuffersBytes: parentUsage.arrayBuffers,
      externalBytes: parentUsage.external,
      heapTotalBytes: parentUsage.heapTotal,
      heapUsedBytes: parentUsage.heapUsed,
      rssBytes: parentUsage.rss,
    },
    parentRssBytes: parentUsage.rss,
    phase,
    sampledAt: new Date().toISOString(),
    totalRssBytes:
      workerRssBytes === null ? null : parentUsage.rss + workerRssBytes,
    workerGeneration,
    workerProcesses,
    workerRssBytes,
  };
}

async function launchImageWorkerSet({
  adapter,
  count,
  env,
  scriptPath,
  threads,
}) {
  const handles = [];
  for (let index = 0; index < count; index += 1) {
    handles.push(await launchImageWorker(scriptPath, adapter, threads, env));
  }
  return handles;
}

function splitAcrossWorkers(items, workerCount) {
  const chunks = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < items.length; index += 1) {
    chunks[index % workerCount].push(items[index]);
  }
  return chunks;
}

function extractStoredVector(row) {
  const raw = row?.vector;
  if (Array.isArray(raw)) {
    return raw;
  }
  if (raw && typeof raw.toArray === "function") {
    return Array.from(raw.toArray());
  }
  if (ArrayBuffer.isView(raw)) {
    return Array.from(raw);
  }
  return null;
}

function cosine(left, right) {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftNorm += left[index] ** 2;
    rightNorm += right[index] ** 2;
  }
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

async function runPackagedParityProbe(
  productionContext,
  packagedResources,
  sourceImage,
  temporaryEnv
) {
  const packagedWorkerRoot = path.join(
    packagedResources,
    "app.asar.unpacked",
    "scripts"
  );
  const packagedModelRoot = path.join(packagedResources, "models-release");
  const sourceAdapter = productionContext.workerAdapter;
  const packagedAdapter =
    productionContext.createWorkerAdapter(packagedModelRoot);
  const paths = {
    sourceImage: path.join(sourceWorkerRoot, "embed-worker.mjs"),
    sourceText: path.join(sourceWorkerRoot, "text-embed-worker.mjs"),
    packagedImage: path.join(packagedWorkerRoot, "embed-worker.mjs"),
    packagedText: path.join(packagedWorkerRoot, "text-embed-worker.mjs"),
  };
  for (const [label, scriptPath] of Object.entries(paths)) {
    if (!fs.existsSync(scriptPath)) {
      throw new Error(`${label} worker is missing: ${scriptPath}`);
    }
  }

  let sourceImageHandle;
  let packagedImageHandle;
  let sourceTextHandle;
  let packagedTextHandle;
  try {
    [sourceImageHandle, packagedImageHandle] = await Promise.all([
      launchImageWorker(paths.sourceImage, sourceAdapter, 1, temporaryEnv),
      launchImageWorker(paths.packagedImage, packagedAdapter, 1, temporaryEnv),
    ]);
    const [sourceImageResult, packagedImageResult] = await Promise.all([
      embedImageBatch(sourceImageHandle, sourceAdapter, [
        { id: 1, path: sourceImage },
      ]),
      embedImageBatch(packagedImageHandle, packagedAdapter, [
        { id: 1, path: sourceImage },
      ]),
    ]);
    const sourceImageVector = sourceImageResult[0]?.vector;
    const packagedImageVector = packagedImageResult[0]?.vector;
    validateVector(
      sourceImageVector,
      sourceAdapter.image.dimensions,
      "Source parity image vector"
    );
    validateVector(
      packagedImageVector,
      packagedAdapter.image.dimensions,
      "Packaged parity image vector"
    );
    await Promise.all([
      shutdownWorker(sourceImageHandle),
      shutdownWorker(packagedImageHandle),
    ]);
    sourceImageHandle = null;
    packagedImageHandle = null;

    [sourceTextHandle, packagedTextHandle] = await Promise.all([
      launchTextWorker(paths.sourceText, sourceAdapter, temporaryEnv),
      launchTextWorker(paths.packagedText, packagedAdapter, temporaryEnv),
    ]);
    const [sourceTextVector, packagedTextVector] = await Promise.all([
      embedText(sourceTextHandle, sourceAdapter, "a photo", 1),
      embedText(packagedTextHandle, packagedAdapter, "a photo", 2),
    ]);
    const imageCosine = cosine(sourceImageVector, packagedImageVector);
    const textCosine = cosine(sourceTextVector, packagedTextVector);
    return {
      adapterIdMatches: sourceAdapter.adapterId === packagedAdapter.adapterId,
      fingerprintMatches:
        sourceAdapter.fingerprint === packagedAdapter.fingerprint,
      image: {
        cosineSimilarity: round(imageCosine, 8),
        dimensions: sourceImageVector.length,
        equivalent: imageCosine > 0.999_999,
      },
      passed:
        sourceAdapter.adapterId === packagedAdapter.adapterId &&
        sourceAdapter.fingerprint === packagedAdapter.fingerprint &&
        imageCosine > 0.999_999 &&
        textCosine > 0.999_999,
      text: {
        cosineSimilarity: round(textCosine, 8),
        dimensions: sourceTextVector.length,
        equivalent: textCosine > 0.999_999,
      },
    };
  } finally {
    await Promise.all([
      shutdownWorker(sourceImageHandle),
      shutdownWorker(packagedImageHandle),
      shutdownWorker(sourceTextHandle),
      shutdownWorker(packagedTextHandle),
    ]);
  }
}

function createRunId() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the runner keeps worker, vector-store, reporting, and cleanup invariants in one auditable lifecycle.
export async function runAiIndexStress(argv = process.argv.slice(2)) {
  const options = parseStressArguments(argv);
  if (options.help) {
    printHelp();
    return null;
  }
  const sourceImages = await collectImageFiles(options.input);
  const planningSummary = {
    count: options.count,
    input: options.input,
    sourceImageCount: sourceImages.length,
    synthetic: true,
    reuseStrategy: "stable-sorted-cyclic-path-reuse",
    warning:
      "Synthetic workload: repeated logical items do not represent 500-5000 distinct real photos or quality coverage.",
  };
  if (options.validateOnly) {
    console.log(JSON.stringify(planningSummary, null, 2));
    return { validationOnly: true, workload: planningSummary };
  }

  const outputDir =
    options.outputDir ??
    path.join(reportsRoot, "ai-index-stress", createRunId());
  assertReportPath(outputDir);
  await fsPromises.mkdir(outputDir, { recursive: true });
  const temporaryDataPath = path.join(outputDir, ".work-data");
  const temporaryUserDataPath = path.join(temporaryDataPath, "userData");
  const vectorPath = path.join(temporaryDataPath, "vectors");
  await fsPromises.mkdir(temporaryUserDataPath, { recursive: true });
  await fsPromises.mkdir(vectorPath, { recursive: true });
  const temporaryEnv = {
    AIM_STRESS_USER_DATA: temporaryUserDataPath,
    AIM_STRESS_VECTOR_DIR: vectorPath,
    ELECTRON_RUN_AS_NODE: "1",
  };
  const workload = buildSyntheticWorkload(
    sourceImages,
    options.count,
    path.join(temporaryDataPath, "intentionally-missing-image.png"),
    options.injectFailureAt
  );

  let productionContext;
  let vectorDb;
  let table;
  const workerHandles = [];
  const startedAt = new Date();
  const monotonicStartedAt = performance.now();
  const segments = [];
  const errors = [];
  const memorySamples = [];
  let completedLogicalItems = 0;
  let successfulVectors = 0;
  let paused = false;
  let cancelled = false;
  let workerGeneration = 1;
  let workerRestart = null;
  let packagedParity = null;
  let fingerprintPublished = false;
  let report;

  try {
    productionContext = await loadProductionContext(options.modelRoot);
    const { runtimeInfo, workerAdapter, workerConfig } = productionContext;
    const segmentSize =
      options.segmentSize ?? workerConfig.batchSize * workerConfig.workers;
    const schema = new Schema([
      new Field("photo_id", new Int32()),
      new Field(
        "vector",
        new FixedSizeList(
          runtimeInfo.dimensions,
          new Field("item", new Float32())
        )
      ),
      new Field("created_at", new Float64()),
    ]);
    vectorDb = await connect(vectorPath);
    table = await vectorDb.createEmptyTable("photo_embeddings", schema);

    const imageWorkerPath = path.join(sourceWorkerRoot, "embed-worker.mjs");
    workerHandles.push(
      ...(await launchImageWorkerSet({
        adapter: workerAdapter,
        count: workerConfig.workers,
        env: temporaryEnv,
        scriptPath: imageWorkerPath,
        threads: workerConfig.intraOpNumThreads,
      }))
    );
    memorySamples.push(
      await sampleMemory(0, workerHandles, "workers-ready", workerGeneration)
    );

    while (completedLogicalItems < workload.length) {
      if (
        options.cancelAfter !== null &&
        completedLogicalItems >= options.cancelAfter
      ) {
        cancelled = true;
        break;
      }
      if (
        options.pauseAfter !== null &&
        !paused &&
        completedLogicalItems >= options.pauseAfter
      ) {
        paused = true;
        await new Promise((resolve) => setTimeout(resolve, options.pauseMs));
      }
      if (
        options.restartWorkerAfter !== null &&
        workerRestart === null &&
        completedLogicalItems >= options.restartWorkerAfter
      ) {
        const beforeShutdown = await sampleMemory(
          completedLogicalItems,
          workerHandles,
          "before-worker-restart",
          workerGeneration
        );
        const previousProcessIds = workerHandles.map(
          (handle) => handle.child.pid
        );
        await Promise.all(workerHandles.splice(0).map(shutdownWorker));
        await new Promise((resolve) => setTimeout(resolve, 500));
        const afterShutdown = await sampleMemory(
          completedLogicalItems,
          workerHandles,
          "workers-stopped-for-restart",
          workerGeneration
        );
        workerGeneration += 1;
        workerHandles.push(
          ...(await launchImageWorkerSet({
            adapter: workerAdapter,
            count: workerConfig.workers,
            env: temporaryEnv,
            scriptPath: imageWorkerPath,
            threads: workerConfig.intraOpNumThreads,
          }))
        );
        const afterRestart = await sampleMemory(
          completedLogicalItems,
          workerHandles,
          "workers-restarted",
          workerGeneration
        );
        memorySamples.push(beforeShutdown, afterShutdown, afterRestart);
        workerRestart = {
          afterRestart,
          afterShutdown,
          beforeShutdown,
          completedLogicalItems,
          newProcessIds: workerHandles.map((handle) => handle.child.pid),
          previousProcessIds,
          workerRssReleasedBytes:
            beforeShutdown.workerRssBytes === null ||
            afterShutdown.workerRssBytes === null
              ? null
              : beforeShutdown.workerRssBytes - afterShutdown.workerRssBytes,
        };
      }
      const maximumEnd = Math.min(
        workload.length,
        completedLogicalItems + segmentSize,
        options.cancelAfter ?? workload.length
      );
      const segmentItems = workload.slice(completedLogicalItems, maximumEnd);
      if (segmentItems.length === 0) {
        cancelled = options.cancelAfter !== null;
        break;
      }
      const segmentStartedAt = performance.now();
      const chunks = splitAcrossWorkers(segmentItems, workerHandles.length);
      const resultGroups = await Promise.all(
        chunks.map((chunk, index) =>
          chunk.length > 0
            ? embedImageBatch(workerHandles[index], workerAdapter, chunk)
            : Promise.resolve([])
        )
      );
      const results = resultGroups.flat();
      const resultById = new Map(results.map((result) => [result.id, result]));
      const records = [];
      let segmentErrors = 0;
      for (const item of segmentItems) {
        const result = resultById.get(item.id);
        if (!result?.vector) {
          segmentErrors += 1;
          errors.push({
            id: item.id,
            message: result?.error ?? "worker returned no result",
          });
          continue;
        }
        validateVector(
          result.vector,
          runtimeInfo.dimensions,
          `Image vector ${item.id}`
        );
        records.push({
          photo_id: item.id,
          vector: result.vector,
          created_at: Date.now(),
        });
      }
      if (records.length > 0) {
        await table.add(records);
      }
      completedLogicalItems += segmentItems.length;
      successfulVectors += records.length;
      const elapsedMs = performance.now() - segmentStartedAt;
      const memory = await sampleMemory(
        completedLogicalItems,
        workerHandles,
        "segment",
        workerGeneration
      );
      memorySamples.push(memory);
      segments.push({
        completed: completedLogicalItems,
        elapsedMs: round(elapsedMs),
        endId: segmentItems.at(-1).id,
        errorCount: segmentErrors,
        items: segmentItems.length,
        memory,
        startId: segmentItems[0].id,
        throughputPerSecond: round(
          segmentItems.length / Math.max(elapsedMs / 1000, 0.001)
        ),
      });
      console.log(
        `[ai-index-stress] ${completedLogicalItems}/${workload.length} errors=${errors.length} throughput=${segments.at(-1).throughputPerSecond}/s`
      );
    }

    cancelled =
      cancelled ||
      (options.cancelAfter !== null && completedLogicalItems < workload.length);
    const indexReady = true;
    fingerprintPublished = productionContext.shouldPublishVectorFingerprint({
      hasVectorTable: Boolean(table),
      indexReady,
      processed: successfulVectors,
      runWritable: !cancelled,
      total: workload.length,
    });
    if (fingerprintPublished) {
      await productionContext.writeStoredVectorFingerprint(temporaryDataPath, {
        schemaVersion: 1,
        adapterId: runtimeInfo.adapterId,
        createdAt: new Date().toISOString(),
        dimensions: runtimeInfo.dimensions,
        fingerprint: runtimeInfo.fingerprint,
        source: "fresh-build",
      });
    }
    const marker =
      productionContext.inspectStoredVectorFingerprint(temporaryDataPath);
    if (fingerprintPublished !== (marker.state === "valid")) {
      throw new Error("Fingerprint publication invariant failed");
    }

    const storedRowCount = await table.countRows();
    const sampleRows = await table.query().limit(1).toArray();
    const storedSampleVector = extractStoredVector(sampleRows[0]);
    if (storedRowCount > 0) {
      validateVector(
        storedSampleVector,
        runtimeInfo.dimensions,
        "Vector store read-back sample"
      );
    }

    memorySamples.push(
      await sampleMemory(
        completedLogicalItems,
        workerHandles,
        "before-final-worker-shutdown",
        workerGeneration
      )
    );
    await Promise.all(workerHandles.splice(0).map(shutdownWorker));
    await new Promise((resolve) => setTimeout(resolve, 500));
    memorySamples.push(
      await sampleMemory(
        completedLogicalItems,
        workerHandles,
        "workers-stopped-final",
        workerGeneration
      )
    );
    if (vectorDb) {
      await vectorDb.close();
      vectorDb = null;
      table = null;
      await new Promise((resolve) => setTimeout(resolve, 500));
      memorySamples.push(
        await sampleMemory(
          completedLogicalItems,
          workerHandles,
          "vector-db-closed",
          workerGeneration
        )
      );
    }
    if (options.packagedResources) {
      packagedParity = await runPackagedParityProbe(
        productionContext,
        options.packagedResources,
        sourceImages[0],
        temporaryEnv
      );
      if (!packagedParity.passed) {
        throw new Error("Source/packaged worker parity probe failed");
      }
    }

    const finishedAt = new Date();
    const totalElapsedMs = performance.now() - monotonicStartedAt;
    let runStatus = "complete";
    if (cancelled) {
      runStatus = "cancelled";
    } else if (errors.length > 0) {
      runStatus = "completed-with-errors";
    }
    report = {
      schemaVersion: 1,
      reportType: "ai-index-production-stress",
      generatedAt: finishedAt.toISOString(),
      status: runStatus,
      syntheticWorkload: {
        ...planningSummary,
        logicalItemCount: workload.length,
        sourceImages: sourceImages.map((imagePath) =>
          path.relative(repoRoot, imagePath)
        ),
      },
      modelIdentity: {
        adapterId: runtimeInfo.adapterId,
        dimensions: runtimeInfo.dimensions,
        fingerprint: runtimeInfo.fingerprint,
        modelId: runtimeInfo.modelId,
        revision: runtimeInfo.revision,
      },
      environment: {
        arch: process.arch,
        cpu: os.cpus()[0]?.model ?? "unknown",
        cpuCount: os.cpus().length,
        node: process.version,
        platform: process.platform,
        totalMemoryBytes: os.totalmem(),
      },
      execution: {
        batchSize: workerConfig.batchSize,
        segmentSize,
        threadsPerWorker: workerConfig.intraOpNumThreads,
        workerCount: workerConfig.workers,
      },
      controls: {
        allowErrors: options.allowErrors,
        cancelAfter: options.cancelAfter,
        cancelled,
        failureInjectedAt: options.injectFailureAt,
        pauseAfter: options.pauseAfter,
        pauseDurationMs: paused ? options.pauseMs : 0,
        pausedAndResumed: paused,
        restartWorkerAfter: options.restartWorkerAfter,
        workerRestart,
      },
      results: {
        completedLogicalItems,
        errorCount: errors.length,
        errorRate:
          completedLogicalItems > 0
            ? round(errors.length / completedLogicalItems, 6)
            : 0,
        errors,
        fingerprintMarkerState: marker.state,
        fingerprintPublished,
        storedRowCount,
        successfulVectors,
        vectorReadBackValidated: storedRowCount > 0,
      },
      performance: {
        elapsedMs: round(totalElapsedMs),
        finishedAt: finishedAt.toISOString(),
        segments,
        startedAt: startedAt.toISOString(),
        throughputPerSecond: round(
          completedLogicalItems / Math.max(totalElapsedMs / 1000, 0.001)
        ),
      },
      memory: {
        epochTrends: summarizeMemoryEpochs(memorySamples),
        samples: memorySamples,
        trend: summarizeMemoryTrends(memorySamples),
        warning:
          "fullRun includes worker and ORT arena warmup and is not used for leak review. Only a sustained positive steadyState delta and slope recommends review; a flat or negative steadyState trend is still not proof that no memory leak exists.",
        followUp:
          "When steady-state growth is observed, repeat 1000-5000 items at least three times and compare parentRssBytes and workerRssBytes separately before making a leak conclusion.",
      },
      packagedParity,
      temporaryIsolation: {
        cleanedAfterReport: !options.keepWorkdir,
        realUserDataTouched: false,
        root: path.relative(repoRoot, temporaryDataPath),
      },
    };
    const reportPath = path.join(outputDir, "ai-index-stress.json");
    await fsPromises.writeFile(
      reportPath,
      `${JSON.stringify(report, null, 2)}\n`,
      "utf-8"
    );
    console.log(`[ai-index-stress] report: ${reportPath}`);
    return { report, reportPath };
  } finally {
    await Promise.all(workerHandles.splice(0).map(shutdownWorker));
    if (vectorDb) {
      try {
        await vectorDb.close();
      } catch {
        // best-effort test resource cleanup
      }
    }
    if (productionContext) {
      await productionContext.close();
    }
    if (!options.keepWorkdir && fs.existsSync(temporaryDataPath)) {
      const resolvedWorkdir = path.resolve(temporaryDataPath);
      const resolvedOutput = path.resolve(outputDir);
      if (resolvedWorkdir.startsWith(`${resolvedOutput}${path.sep}`)) {
        await fsPromises.rm(resolvedWorkdir, { force: true, recursive: true });
      }
    }
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runAiIndexStress()
    .then((result) => {
      const exitCode = resolveStressExitCode(result?.report);
      if (exitCode !== 0) {
        console.error(
          "[ai-index-stress] completed with item errors; exiting non-zero (use --allow-errors only for expected error-path acceptance)"
        );
        process.exitCode = exitCode;
      }
    })
    .catch((error) => {
      console.error(
        `[ai-index-stress] ${error instanceof Error ? error.stack : String(error)}`
      );
      process.exitCode = 1;
    });
}
