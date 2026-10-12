/** Production compound-search API; every write stays in a fresh ignored profile. */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { call } from "@orpc/server";
import { eq } from "drizzle-orm";
import { createServer } from "vite";
import { diagnosticTranslationPlugin } from "./search-benchmark/diagnostic-translation.mjs";
import {
  evaluateSearchRun,
  measuredDistribution,
} from "./search-benchmark/evaluate.mjs";
import { historicalSearchTracePlugin } from "./search-benchmark/historical-trace.mjs";
import { createNativeModuleBridge } from "./search-benchmark/native-module-bridge.mjs";
import {
  fingerprintModelArtifacts,
  hashRuntimeSourceTree,
  linkSharedModelArtifacts,
  runtimeSourceFiles,
} from "./search-benchmark/source-snapshot.mjs";
import {
  switchTimingQueries,
  warmTimingQuery,
} from "./search-benchmark/timing-workload.mjs";
import { validateSearchDefinition } from "./search-benchmark/validate.mjs";
import { verifyBenchmarkVectors } from "./search-benchmark/vector-integrity.mjs";

const DATA_PATH_RE = /\/utils\/data-path(?:\.ts)?$/;
const repo = path.resolve(import.meta.dirname, "..");
const args = process.argv.slice(2);
const value = (key, fallback) =>
  args.includes(key) ? args[args.indexOf(key) + 1] : fallback;
const source = path.resolve(value("--source", path.join(repo, "src")));
const runtimeRoot = path.dirname(source);
if (!fs.existsSync(path.join(runtimeRoot, "scripts/embed-worker.mjs"))) {
  throw new Error(
    "Source snapshots must include their production workers; start a fresh runtime snapshot"
  );
}
const label = value("--label", "optimized");
const split = value("--split", "holdout");
const size = Number(value("--synthetic", "0"));
const coldOnly = args.includes("--cold-only");
const performanceOnly = args.includes("--performance-only");
const rounds =
  args.includes("--quality-only") || coldOnly
    ? 0
    : Number(value("--rounds", "3"));
const roundOffset = Number(value("--round-offset", "0"));
if (!([0, 1, 3].includes(rounds) && [0, 1, 2].includes(roundOffset))) {
  throw new Error("Timing rounds must be 1 or 3, with offset 0..2");
}
const traceQuality = args.includes("--trace-quality");
const diagnosticImageCache = value("--diagnostic-image-cache", null);
const translationControl = value("--diagnostic-translations", null);
const verifyVectorCount = Number(value("--verify-vector-count", "0"));
const probeTextEncoding = args.includes("--probe-text-encoding");
if (
  !Number.isInteger(verifyVectorCount) ||
  verifyVectorCount < 0 ||
  ((verifyVectorCount || probeTextEncoding) && !args.includes("--quality-only"))
) {
  throw new Error("Vector verification and text probes require --quality-only");
}
if (translationControl && !args.includes("--quality-only")) {
  throw new Error("Translation counterfactuals require --quality-only");
}
if (diagnosticImageCache && !args.includes("--quality-only")) {
  throw new Error("Counterfactual image vectors require --quality-only");
}
const steadyStateOnly = args.includes("--steady-state-only");
if (steadyStateOnly && size) {
  throw new Error("Historical steady-state comparisons require real images");
}
if (traceQuality && rounds) {
  throw new Error(
    "Quality tracing requires --quality-only; exclude traces from speed comparisons"
  );
}
const reports = path.join(repo, "reports/search-optimization");
const output = path.resolve(
  value("--output", path.join(reports, `${label}-${split}-${Date.now()}`))
);
if (!output.startsWith(reports + path.sep)) {
  throw new Error("Output must remain inside reports/search-optimization");
}
fs.mkdirSync(output, { recursive: true });
if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)("electron");
  const result = spawnSync(
    electron,
    [import.meta.filename, ...args, "--output", output],
    {
      cwd: repo,
      stdio: "inherit",
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        APPDATA: path.join(output, "appdata"),
        LOCALAPPDATA: path.join(output, "local"),
        AI_EMBED_WORKERS: "1",
        AI_EMBED_THREADS: "4",
      },
    }
  );
  if (result.error) {
    throw result.error;
  }
  process.exit(result.status ?? 1);
}
// Worker lookup and migrations must resolve to this variant's frozen runtime.
// Translation resolves models from cwd independently of the text runtime.
linkSharedModelArtifacts(repo, runtimeRoot);
process.chdir(runtimeRoot);
const profile = path.join(output, "profile");
fs.mkdirSync(profile, { recursive: false });
const literal = JSON.stringify(profile);
const traceModule = fs.existsSync(
  path.join(source, "services/search-quality-trace.ts")
)
  ? path.join(source, "services/search-quality-trace.ts")
  : path.join(repo, "src/services/search-quality-trace.ts");
const server = await createServer({
  configFile: false,
  root: repo,
  appType: "custom",
  logLevel: "silent",
  resolve: { alias: { "@": source } },
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  ssr: { noExternal: ["electron"] },
  plugins: [
    createNativeModuleBridge(),
    ...(traceQuality ? [historicalSearchTracePlugin(traceModule)] : []),
    ...(translationControl
      ? [
          diagnosticTranslationPlugin(
            JSON.parse(
              fs.readFileSync(path.resolve(repo, translationControl), "utf8")
            )
          ),
        ]
      : []),
    {
      name: "isolated-search-runtime",
      enforce: "pre",
      resolveId(id) {
        if (id === "electron") {
          return "\0search-electron";
        }
        if (DATA_PATH_RE.test(id.replaceAll("\\", "/"))) {
          return "\0search-data-path";
        }
        return null;
      },
      load(id) {
        if (id === "\0search-data-path") {
          return `export const getDataPath=()=>${literal};export const initDataPath=getDataPath;`;
        }
        if (id === "\0search-electron") {
          return `export const app={isPackaged:false,getAppPath:()=>process.cwd(),getPath:()=>${literal},getVersion:()=>"2.2.3",getLocale:()=>"zh-CN"};export const BrowserWindow={getAllWindows:()=>[]};export const screen={getPrimaryDisplay:()=>({scaleFactor:1})};`;
        }
        return null;
      },
    },
  ],
});
const load = async (relative) => {
  console.log(`Loading production module ${relative}`);
  const loaded = await server.ssrLoadModule(path.join(source, relative));
  console.log(`Loaded production module ${relative}`);
  return loaded;
};
let database, vectors, pool, textWorker, translation;
const modelArtifacts = fingerprintModelArtifacts(repo);
let peakRss = process.memoryUsage().rss;
const memoryTimer = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 20);
const definitionPath = path.resolve(
  repo,
  value(
    "--definition",
    path.join(repo, "scripts/search-benchmark/queries.v1.json")
  )
);
const definition = JSON.parse(fs.readFileSync(definitionPath, "utf8"));
const manifest = JSON.parse(
  fs.readFileSync(path.join(repo, definition.sourceManifest), "utf8")
);
validateSearchDefinition(definition, manifest);
const hash = (text) => createHash("sha256").update(text).digest("hex");
const sourceHash = hash(
  [
    "ipc/photos/handlers/search.ts",
    "services/ai/search.ts",
    "services/query-rewrite.ts",
    "services/ai/semantic-query-plan.ts",
    "services/ai/scoring.ts",
    "services/search-control.ts",
    "services/search-revision.ts",
  ]
    .filter((file) => fs.existsSync(path.join(source, file)))
    .map((file) => fs.readFileSync(path.join(source, file), "utf8"))
    .join("\n")
);
const sourceTreeHash = hashRuntimeSourceTree(runtimeRoot);
const snapshotFile = path.join(source, "../source.json");
const sourceSnapshot = fs.existsSync(snapshotFile)
  ? JSON.parse(fs.readFileSync(snapshotFile, "utf8"))
  : null;
if (
  sourceSnapshot &&
  (sourceSnapshot.schemaVersion !== 2 ||
    sourceSnapshot.sourceTreeHash !== sourceTreeHash)
) {
  throw new Error(
    "Frozen runtime sources changed or use an incomplete snapshot format"
  );
}
const headSnapshot =
  sourceSnapshot?.kind === "git-head" ? sourceSnapshot : null;
const runtimeFiles = runtimeSourceFiles(runtimeRoot);
for (const relative of runtimeFiles.filter((file) =>
  file.startsWith("models/")
)) {
  if (
    hash(fs.readFileSync(path.join(runtimeRoot, relative))) !==
    hash(fs.readFileSync(path.join(repo, relative)))
  ) {
    throw new Error(
      `Shared model resource differs from its frozen config: ${relative}`
    );
  }
}
const dependencyLockHash = hash(
  fs.readFileSync(path.join(repo, "package-lock.json"))
);
const snapshotDependencyLockHash = hash(
  fs.readFileSync(path.join(runtimeRoot, "package-lock.json"))
);
const run = {
  schemaVersion: 1,
  label,
  split,
  sourceHash,
  sourceTreeHash,
  headSnapshot,
  sourceSnapshot,
  modelArtifacts,
  runtimeFiles,
  dependencyLockHash,
  snapshotDependencyLockHash,
  dependencyLockMatchesSnapshot:
    dependencyLockHash === snapshotDependencyLockHash,
  definitionHash: hash(JSON.stringify(definition)),
  definitionPath,
  benchmarkRunnerHash: hash(fs.readFileSync(import.meta.filename)),
  benchmarkDriver: {
    qualityTracing: traceQuality,
    timingWorkloadHash: hash(
      fs.readFileSync(
        path.join(repo, "scripts/search-benchmark/timing-workload.mjs")
      )
    ),
    diagnosticTranslations: translationControl,
    packageLoading: "native-module-namespace-bridge",
    bridgeHash: hash(
      fs.readFileSync(
        path.join(repo, "scripts/search-benchmark/native-module-bridge.mjs")
      )
    ),
    node: process.versions.node,
    threads: 4,
    workers: 1,
  },
  machine: {
    cpu: os.cpus()[0].model,
    logicalCores: os.cpus().length,
    memoryBytes: os.totalmem(),
    electron: process.versions.electron,
  },
  scope: size ? "synthetic-performance-only" : "production-api-real-images",
  performanceMode: steadyStateOnly ? "steady-state-only" : "all-scenarios",
  coldOnly,
  performanceOnly,
  roundOffset,
  queries: [],
  performance: {},
  limitations: [
    "This runner measures the production API in Electron-as-Node. IPC and first paint are measured only by the Electron E2E runner; missing values stay null.",
    "Peak RSS here covers the host process; worker memory is reported separately when sampled by Electron E2E.",
    "The index-batch-write scenario overlaps real LanceDB replacement writes with search; it does not simulate concurrent image encoding.",
    "Cold includes vector reopen and model/translation worker startup; fixture preparation has already warmed OS file caches.",
  ],
};
try {
  database = await load("db/index.ts");
  const db = database.initDatabase();
  const schema = await load("db/schema.ts");
  const state = await load("services/ai/state.ts");
  const search = await load("services/ai/search.ts");
  vectors = await load("services/ai/vector-db.ts");
  textWorker = await load("services/ai/text-worker-client.ts");
  translation = await load("services/ai/translation-worker-client.ts");
  state.setLocalModelPath(path.join(runtimeRoot, "models"));
  await vectors.initVectorDB();
  const samples = size
    ? Array.from({ length: size }, (_, index) => ({
        id: `synthetic-${index + 1}`,
        filePath: path.join(profile, `synthetic-${index + 1}.jpg`),
        index,
      }))
    : manifest.samples
        .map((sample, index) => ({ ...sample, index }))
        .filter((sample) => sample.split === split);
  // Synthetic paths never leave this isolated profile; no real semantic claims.
  const ids = new Map(samples.map((sample) => [sample.index + 1, sample.id]));
  db.transaction(() => {
    for (const sample of samples) {
      const id = sample.index + 1;
      db.insert(schema.photos)
        .values({
          id,
          path: sample.filePath,
          filename: `${sample.id}.jpg`,
          fileDate: id,
          width: 224,
          height: 224,
          isAiProcessed: true,
          isIndexed: true,
        })
        .run();
      db.insert(schema.exifData)
        .values({
          photoId: id,
          cameraModel: id % 2 ? "Nikon" : "Canon",
          iso: id % 3 ? 100 : 800,
          dateTaken: new Date(2025, 6, (id % 28) + 1, 12).getTime(),
          artist: id % 2 ? "Reviewer-A" : "Reviewer-B",
        })
        .run();
    }
    if (!size) {
      const personId = split === "development" ? 20 : 21;
      const personName = split === "development" ? "林先生" : "小美";
      const identity = db
        .insert(schema.faceIdentities)
        .values({ name: personName, isConfirmed: true })
        .returning()
        .get();
      const face = db
        .insert(schema.faceVectors)
        .values({
          photoId: personId,
          bboxX: 0.1,
          bboxY: 0.1,
          bboxWidth: 0.2,
          bboxHeight: 0.2,
        })
        .returning()
        .get();
      db.insert(schema.faceIdentityMembers)
        .values({ identityId: identity.id, faceVectorId: face.id })
        .run();
    }
  });
  let imageVectors;
  if (size) {
    const syntheticVector = (id) => {
      let seed = (id * 2_654_435_761) % 4_294_967_296;
      const vector = Array.from({ length: 768 }, () => {
        seed = (seed * 1_664_525 + 1_013_904_223) % 4_294_967_296;
        return seed / 4_294_967_296 - 0.5;
      });
      vector[0] += Math.sqrt(768) * 0.5;
      const norm = Math.hypot(...vector);
      return vector.map((value) => value / norm);
    };
    imageVectors = samples.map((sample) => ({
      id: sample.index + 1,
      vector: syntheticVector(sample.index + 1),
    }));
    const modelConfig = await load("services/ai/model-config.ts");
    const threshold = await load("services/ai/threshold-profile.ts");
    state.setActiveEmbeddingRuntime({
      ...modelConfig.getActiveEmbeddingRuntimeInfo(),
      vectorCompatibility: "matching",
      calibrationStatus:
        threshold.getActiveThresholdProfile().calibrationStatus,
    });
    state.setEmbeddingModel({
      embedText: async (text) => syntheticVector(text.length),
      embedTexts: async (texts) =>
        texts.map((text) => syntheticVector(text.length)),
      embedImage: () => Promise.reject(new Error("synthetic only")),
    });
    state.setIsModelLoaded(true);
  } else {
    const adapter = await load("services/ai/model-config.ts");
    const fingerprint = adapter.getActiveEmbeddingRuntimeInfo().fingerprint;
    const modelArtifactHash = hash(JSON.stringify(modelArtifacts));
    const cache = diagnosticImageCache
      ? path.resolve(repo, diagnosticImageCache)
      : path.join(
          reports,
          `image-vectors.${hash(`${fingerprint}:${modelArtifactHash}`).slice(0, 20)}.json`
        );
    const existing = fs.existsSync(cache)
      ? JSON.parse(fs.readFileSync(cache, "utf8"))
      : { fingerprint, modelArtifactHash, vectors: [] };
    if (
      (!diagnosticImageCache && existing.fingerprint !== fingerprint) ||
      existing.modelArtifactHash !== modelArtifactHash
    ) {
      throw new Error("Cached vectors have a different model fingerprint");
    }
    const missing = samples.filter(
      (sample) =>
        !existing.vectors.some(
          (row) =>
            row.id === sample.index + 1 && row.sha256 === sample.source?.sha256
        )
    );
    if (diagnosticImageCache && missing.length) {
      throw new Error("Diagnostic cache is incomplete; never overwrite it");
    }
    if (missing.length) {
      pool = await load("services/embed-worker-pool.ts");
      await pool.initWorkerPool(path.join(runtimeRoot, "models"));
      const embedded = await pool.embedWithPool(
        missing.map((sample) => ({
          id: sample.index + 1,
          path: sample.filePath,
        })),
        (done, total) => {
          if (done % 20 === 0 || done === total) {
            console.log(`Image embeddings ${done}/${total}`);
          }
        }
      );
      for (const row of embedded) {
        if (!row.vector || row.error) {
          throw new Error(`Embedding failed for ${row.id}: ${row.error}`);
        }
        const sample = samples.find((item) => item.index + 1 === row.id);
        existing.vectors.push({ ...row, sha256: sample.source?.sha256 });
      }
      fs.writeFileSync(cache, JSON.stringify(existing));
      pool.shutdownPool();
    }
    imageVectors = existing.vectors.filter((row) => ids.has(row.id));
    run.vectorCache = {
      path: cache,
      sha256: hash(fs.readFileSync(cache)),
      fingerprint: existing.fingerprint,
      textFingerprint: fingerprint,
      modelArtifactHash,
      diagnosticOnly: Boolean(diagnosticImageCache),
      integrity: verifyBenchmarkVectors(
        samples,
        existing.vectors,
        adapter.getActiveEmbeddingModel().vectorDimensions
      ),
      provenance:
        "historical cache with declared model fingerprint; content and normalization verified",
      imageWorkerHash: hash(
        fs.readFileSync(path.join(runtimeRoot, "scripts/embed-worker.mjs"))
      ),
      preprocessingHash: fs.existsSync(
        path.join(runtimeRoot, "scripts/image-preprocessing.mjs")
      )
        ? hash(
            fs.readFileSync(
              path.join(runtimeRoot, "scripts/image-preprocessing.mjs")
            )
          )
        : null,
    };
    if (verifyVectorCount) {
      const count = Math.min(verifyVectorCount, samples.length);
      const selected = Array.from(
        { length: count },
        (_, index) => samples[Math.floor((index * samples.length) / count)]
      );
      pool = await load("services/embed-worker-pool.ts");
      await pool.initWorkerPool(path.join(runtimeRoot, "models"));
      const encoded = await pool.embedWithPool(
        selected.map((sample) => ({
          id: sample.index + 1,
          path: sample.filePath,
        })),
        (done, total) => {
          if (done % 20 === 0 || done === total) {
            console.log(`Verifying cached vectors ${done}/${total}`);
          }
        }
      );
      const comparisons = encoded.map((row) => {
        const cached = imageVectors.find((item) => item.id === row.id);
        if (row.error || !row.vector || !cached) {
          throw new Error(`Vector re-encoding failed for ${row.id}`);
        }
        const maximumAbsoluteError = Math.max(
          ...row.vector.map((component, index) =>
            Math.abs(component - cached.vector[index])
          )
        );
        if (maximumAbsoluteError > 0.000_001) {
          throw new Error(`Cached vector provenance mismatch for ${row.id}`);
        }
        return { photoId: row.id, maximumAbsoluteError };
      });
      if (comparisons.length !== count) {
        throw new Error("Missing re-encoded vectors");
      }
      pool.shutdownPool();
      run.vectorCache.reencodedVerification = comparisons;
      run.vectorCache.provenance =
        "verified by isolated production-worker re-encoding";
    }
  }
  for (let index = 0; index < imageVectors.length; index += 500) {
    await vectors.withVectorDbOperation(() =>
      state.photoTable.add(
        imageVectors.slice(index, index + 500).map((row) => ({
          photo_id: row.id,
          vector: row.vector,
          created_at: 1,
        }))
      )
    );
  }
  await vectors.persistActiveVectorFingerprint();
  if (size >= 10_000) {
    await vectors.ensureVectorIndex(true);
  }
  const { searchCompound } = await load("ipc/photos/handlers/search.ts");
  const traceApi = traceQuality
    ? await server.ssrLoadModule(traceModule)
    : null;
  const actualTextVectors = new Map();
  if (traceApi && state.embeddingModel) {
    const model = state.embeddingModel;
    const original = model.embedTexts?.bind(model);
    if (original) {
      model.embedTexts = async (texts) => {
        const encoded = await original(texts);
        traceApi.traceSearchQuality("worker-text-batch", () => ({
          texts,
          vectors: encoded,
          batchSize: texts.length,
        }));
        return encoded;
      };
    }
  }
  const invoke = async (params) => {
    const started = performance.now();
    const requestId = params.requestId ?? randomUUID();
    const events = [];
    const execute = () =>
      call(searchCompound, {
        ...params,
        requestId,
        limit: params.limit ?? 100,
      });
    const response = traceApi
      ? await traceApi.withSearchQualityTrace(
          requestId,
          (event) => {
            const captured = structuredClone(event);
            events.push(captured);
            if (captured.stage === "text-encoding") {
              captured.data.texts.forEach((text, index) => {
                actualTextVectors.set(text, captured.data.vectors[index]);
              });
            }
          },
          execute
        )
      : await execute();
    return {
      response,
      events,
      elapsedMs: performance.now() - started,
      rss: process.memoryUsage().rss,
    };
  };
  await vectors.closeVectorDB();
  // First request reopens the DB and starts the model/translation workers.
  const cold = await invoke({
    query: size ? "synthetic landscape" : "海边照片",
  });
  run.performance.cold = {
    elapsedMs: cold.elapsedMs,
    completion: cold.response.completion ?? "legacy",
    incompleteReason: cold.response.incompleteReason,
    diagnostics: cold.response.diagnostics ?? null,
  };
  if (!(size || coldOnly)) {
    await translation.warmupTranslationWorker(path.join(runtimeRoot, "models"));
  }
  if (!coldOnly) {
    await search.warmupAiSearch();
  }
  if (traceApi && state.embeddingModel) {
    const model = state.embeddingModel;
    const original = model.embedTexts?.bind(model);
    if (original) {
      model.embedTexts = async (texts) => {
        const encoded = await original(texts);
        traceApi.traceSearchQuality("worker-text-batch", () => ({
          texts,
          vectors: encoded,
          batchSize: texts.length,
        }));
        return encoded;
      };
    }
  }
  const selectedDefinition = {
    ...definition,
    queries: definition.queries.filter((query) => query.split === split),
  };
  if (!(size || performanceOnly || coldOnly)) {
    for (const query of selectedDefinition.queries) {
      const actual = await invoke({
        ...query.filters,
        query: query.query,
        limit: 50,
      });
      let qualityTrace;
      const executedPlan =
        actual.events.findLast((event) => event.stage === "query-plan")?.data
          .plan ??
        actual.events.findLast((event) => event.stage === "semantic-cache")
          ?.data.result.plan;
      if (traceQuality && executedPlan) {
        const plan = executedPlan;
        const texts = [
          ...plan.prompts.map((prompt) => prompt.text),
          ...plan.negativePrompts,
        ];
        const textVectors = texts.map((text) => actualTextVectors.get(text));
        if (textVectors.some((vector) => !vector)) {
          throw new Error(`Missing actual executed encoding for ${query.id}`);
        }
        qualityTrace = {
          plan,
          events: actual.events,
          encoding: {
            source: "actual-execution",
            texts,
            positiveCount: plan.prompts.length,
            negativeCount: plan.negativePrompts.length,
          },
          semantic: actual.response.semantic,
          candidates: samples.map((sample) => {
            const sampleId = sample.id;
            const vector = imageVectors.find(
              (row) => row.id === sample.index + 1
            ).vector;
            return {
              photoId: sample.index + 1,
              sampleId,
              relevant: query.relevantSampleIds.includes(sampleId),
              similarities: textVectors.map((textVector) => {
                let dot = 0,
                  left = 0,
                  right = 0;
                for (let i = 0; i < vector.length; i++) {
                  dot += textVector[i] * vector[i];
                  left += textVector[i] ** 2;
                  right += vector[i] ** 2;
                }
                return dot / Math.sqrt(left * right);
              }),
            };
          }),
        };
        qualityTrace.judgments = qualityTrace.candidates.filter(
          (candidate) =>
            query.relevantSampleIds.includes(candidate.sampleId) ||
            query.hardNegativeSampleIds.includes(candidate.sampleId)
        );
      } else if (traceQuality) {
        qualityTrace = {
          plan: null,
          events: actual.events,
          encoding: { source: "not-executed", texts: [] },
          semantic: actual.response.semantic,
          candidates: [],
          judgments: [],
        };
      }
      run.queries.push({
        id: query.id,
        scopeSize: samples.length,
        results: actual.response.results.map((row) => ids.get(row.id)),
        completion: actual.response.completion ?? "legacy",
        elapsedMs: actual.elapsedMs,
        diagnostics: actual.response.diagnostics ?? null,
        ...(qualityTrace ? { qualityTrace } : {}),
      });
    }
    run.quality = evaluateSearchRun(selectedDefinition, run);
  }
  const observations = [];
  if (probeTextEncoding) {
    const target = "This is a photo of a red flower.";
    const companion = "This is a photo of a dog.";
    const long =
      "a detailed photograph of a crowded city street with many buildings, windows, vehicles, people and signs, under a cloudy evening sky, with distant mountains and reflections in water";
    const batches = [
      [target],
      [target, companion],
      [companion, target],
      [target, long],
      [target],
    ];
    const actual = [];
    for (const texts of batches) {
      actual.push({
        texts,
        vectors: await state.embeddingModel.embedTexts(texts),
      });
    }
    const reference = actual[0].vectors[0];
    run.textEncodingProbe = actual.map(({ texts, vectors }) => {
      const vector = vectors[texts.indexOf(target)];
      return {
        texts,
        batchSize: texts.length,
        vector,
        maximumAbsoluteError: Math.max(
          ...vector.map((component, index) =>
            Math.abs(component - reference[index])
          )
        ),
        cosineToSingle: vector.reduce(
          (sum, component, index) => sum + component * reference[index],
          0
        ),
      };
    });
  }
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < 30; index++) {
      const query = size
        ? `synthetic landscape ${round}-${index}`
        : warmTimingQuery(round + roundOffset, index);
      const actual = await invoke({ query });
      observations.push({
        scenario: "warm-new-query",
        round,
        index,
        elapsedMs: actual.elapsedMs,
        completion: actual.response.completion ?? "legacy",
        incompleteReason: actual.response.incompleteReason,
        diagnostics: actual.response.diagnostics ?? null,
      });
    }
  }
  const cacheQuery = { query: size ? "synthetic cache" : "a dog" };
  if (rounds) {
    await invoke(cacheQuery);
  }
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < 30; index++) {
      const actual = await invoke(cacheQuery);
      observations.push({
        scenario: "cache-hit",
        round,
        index,
        elapsedMs: actual.elapsedMs,
        completion: actual.response.completion ?? "legacy",
        incompleteReason: actual.response.incompleteReason,
        diagnostics: actual.response.diagnostics ?? null,
      });
    }
  }
  const control = fs.existsSync(path.join(source, "services/search-control.ts"))
    ? await load("services/search-control.ts")
    : null;
  if (!size && rounds && !steadyStateOnly) {
    const thumbnailer = await load("services/thumbnailer.ts");
    thumbnailer.initThumbnailer();
    for (let round = 0; round < rounds; round++) {
      for (let index = 0; index < 30; index++) {
        const sample = samples[round * 30 + index];
        let writtenAt = null;
        const startedAt = performance.now();
        const writing = thumbnailer
          .generateThumbnail(sample.filePath, "md")
          .then((result) => {
            db.update(schema.photos)
              .set({ thumbnailPath: result.thumbnailPath })
              .where(eq(schema.photos.id, sample.index + 1))
              .run();
            writtenAt = performance.now();
          });
        const [actual] = await Promise.all([
          invoke({ query: `a tree near a window ${round}-${index}` }),
          writing,
        ]);
        if (actual.response.completion !== "complete") {
          throw new Error("Thumbnail backfill interrupted a semantic search");
        }
        observations.push({
          scenario: "thumbnail-backfill",
          round,
          index,
          elapsedMs: actual.elapsedMs,
          completion: actual.response.completion,
          thumbnailWorkMs: writtenAt - startedAt,
          writeBeforeSearchCompleted: writtenAt - startedAt <= actual.elapsedMs,
          diagnostics: actual.response.diagnostics ?? null,
        });
      }
    }
  }
  for (let round = 0; round < rounds; round++) {
    for (let index = 0; index < 30; index++) {
      const replacedId = randomUUID();
      const [firstQuery, secondQuery] = switchTimingQueries(
        round + roundOffset,
        index
      );
      const first = invoke({
        requestId: replacedId,
        query: firstQuery,
      });
      await new Promise((resolve) => setImmediate(resolve));
      control?.cancelSearchRequest(0, replacedId);
      const second = invoke({ query: secondQuery });
      const completed = await Promise.all([first, second]);
      observations.push({
        scenario: "continuous-switch",
        round,
        index,
        elapsedMs: completed[1].elapsedMs,
        completion: completed[1].response.completion ?? "legacy",
        incompleteReason: completed[1].response.incompleteReason,
        replacedCompletion: completed[0].response.completion ?? "legacy",
        diagnostics: completed[1].response.diagnostics ?? null,
      });
    }
  }
  const revision = fs.existsSync(
    path.join(source, "services/search-revision.ts")
  )
    ? await load("services/search-revision.ts")
    : null;
  for (let round = 0; round < (steadyStateOnly ? 0 : rounds); round++) {
    for (let index = 0; index < 30; index++) {
      const writing = vectors.withVectorDbOperation(async () => {
        revision?.invalidateVectorSearch();
        const row = imageVectors[index % imageVectors.length];
        await state.photoTable.delete(`photo_id = ${row.id}`);
        await state.photoTable.add([
          { photo_id: row.id, vector: row.vector, created_at: 1 },
        ]);
        revision?.invalidateVectorSearch();
      });
      const actual = await invoke({
        query: `landscape during index batch ${round}-${index}`,
      });
      await writing;
      observations.push({
        scenario: "index-batch-write",
        round,
        index,
        elapsedMs: actual.elapsedMs,
        completion: actual.response.completion ?? "legacy",
        incompleteReason: actual.response.incompleteReason,
        diagnostics: actual.response.diagnostics ?? null,
      });
    }
  }
  run.performance.observations = observations;
  run.performance.scenarios = Object.fromEntries(
    [...new Set(observations.map((row) => row.scenario))].map((scenario) => {
      const rows = observations.filter((row) => row.scenario === scenario);
      const completionMeasured = rows.every(
        (row) => row.completion !== "legacy"
      );
      return [
        scenario,
        {
          ...measuredDistribution(rows.map((row) => row.elapsedMs)),
          completionMeasured,
          timeoutRatio: completionMeasured
            ? rows.filter(
                (row) =>
                  row.incompleteReason === "deadline" ||
                  row.diagnostics?.timings.serviceMs >=
                    (row.diagnostics?.cold ? 10_000 : 2000)
              ).length / rows.length
            : null,
          partialRatio: completionMeasured
            ? rows.filter((row) => row.completion === "partial").length /
              rows.length
            : null,
          phases: Object.fromEntries(
            Object.keys(
              rows.find((row) => row.diagnostics)?.diagnostics.timings ?? {}
            ).map((phase) => [
              phase,
              measuredDistribution(
                rows.map((row) => row.diagnostics?.timings[phase] ?? null)
              ),
            ])
          ),
        },
      ];
    })
  );
  if (size) {
    const pages = [];
    let cursor;
    let finalExactPage;
    for (let index = 0; index <= Math.ceil(size / 100); index++) {
      const page = await invoke({
        query: "synthetic-*.jpg",
        limit: 100,
        cursor,
      });
      pages.push(...page.response.results.map((row) => row.id));
      finalExactPage = page.response;
      cursor = page.response.nextCursor;
      if (!page.response.hasMore) {
        break;
      }
    }
    run.performance.pagination = {
      returned: pages.length,
      unique: new Set(pages).size,
      expected: size,
      fullyReachable: pages.length === size && new Set(pages).size === size,
      totalExact: finalExactPage?.totalExact,
      total: finalExactPage?.total,
      hasMore: finalExactPage?.hasMore,
    };
    if (
      pages.length !== size ||
      new Set(pages).size !== size ||
      finalExactPage?.hasMore ||
      finalExactPage?.totalExact !== true ||
      finalExactPage?.total !== size ||
      finalExactPage?.completion !== "complete"
    ) {
      throw new Error(
        "Exact pagination did not reach every photo with an exact final total"
      );
    }
    // Exercise native semantic continuation as well as the exact filename path.
    const semanticIds = [];
    const semanticPages = [];
    let semanticCursor;
    let finalSemanticPage;
    for (let index = 0; index <= Math.ceil(size / 100); index++) {
      const page = await invoke({
        query: "synthetic landscape pagination",
        cameraModel: "Nikon",
        isoMin: 800,
        limit: 100,
        cursor: semanticCursor,
      });
      const pageIds = page.response.results.map((row) => row.id);
      if (pageIds.some((id) => id % 2 !== 1 || id % 3 !== 0)) {
        throw new Error("Native semantic pagination lost a hard filter");
      }
      semanticIds.push(...pageIds);
      semanticPages.push({
        count: pageIds.length,
        elapsedMs: page.elapsedMs,
        completion: page.response.completion,
        totalExact: page.response.totalExact,
      });
      finalSemanticPage = page.response;
      semanticCursor = page.response.nextCursor;
      if (!page.response.hasMore || page.response.completion !== "complete") {
        break;
      }
    }
    if (
      new Set(semanticIds).size !== semanticIds.length ||
      finalSemanticPage?.hasMore ||
      finalSemanticPage?.completion !== "complete" ||
      finalSemanticPage?.totalExact !== true ||
      finalSemanticPage?.total !== semanticIds.length
    ) {
      throw new Error("Native semantic pagination returned duplicate photos");
    }
    const alternateIds = [];
    let alternateCursor;
    let alternateFinalPage;
    for (let index = 0; index <= Math.ceil(size / 200); index++) {
      const page = await invoke({
        query: "synthetic landscape pagination",
        cameraModel: "Nikon",
        isoMin: 800,
        limit: 200,
        cursor: alternateCursor,
      });
      alternateIds.push(...page.response.results.map((row) => row.id));
      alternateFinalPage = page.response;
      alternateCursor = page.response.nextCursor;
      if (!page.response.hasMore || page.response.completion !== "complete") {
        break;
      }
    }
    const orderedIds = (rows) => [...rows].sort((a, b) => a - b);
    const pageSizeInvariant =
      JSON.stringify(orderedIds(semanticIds)) ===
      JSON.stringify(orderedIds(alternateIds));
    if (
      !pageSizeInvariant ||
      new Set(alternateIds).size !== alternateIds.length ||
      alternateFinalPage?.hasMore ||
      alternateFinalPage?.completion !== "complete" ||
      alternateFinalPage?.totalExact !== true ||
      alternateFinalPage?.total !== alternateIds.length
    ) {
      throw new Error(
        "Native semantic result reachability changes with display page size"
      );
    }
    run.performance.semanticPagination = {
      returned: semanticIds.length,
      unique: new Set(semanticIds).size,
      hardFiltersSatisfied: true,
      fullyTraversed: true,
      pageSizeInvariant,
      totalExact: finalSemanticPage.totalExact,
      total: finalSemanticPage.total,
      pages: semanticPages,
    };
    run.correctness = {
      sourceTreeHash,
      passed: true,
      checks: {
        exactPaginationReachability: true,
        semanticPaginationReachability: true,
        pageSizeInvariant: true,
        hardFilters: true,
        exactTotalAndCompletion: true,
      },
    };
    // Experiments use the isolated vector table only; production defaults stay unchanged.
    const vector = imageVectors[0].vector;
    const experiments = [];
    for (const nprobes of [10, 20]) {
      for (const refineFactor of [3, 5]) {
        for (const depth of [200, 500]) {
          const started = performance.now();
          const rows = await state.photoTable
            .vectorSearch(vector)
            .distanceType("cosine")
            .nprobes(nprobes)
            .refineFactor(refineFactor)
            .limit(depth)
            .select(["photo_id"])
            .toArray();
          experiments.push({
            nprobes,
            refineFactor,
            depth,
            elapsedMs: performance.now() - started,
            returned: rows.length,
          });
        }
      }
    }
    run.experiments = experiments;
  }
  run.peakHostRssBytes = peakRss;
  run.finishedAt = new Date().toISOString();
  fs.writeFileSync(
    path.join(output, "report.json"),
    JSON.stringify(run, null, 2)
  );
  console.log(
    JSON.stringify({
      output,
      quality: run.quality?.metrics,
      performance: Object.fromEntries(
        Object.entries(run.performance.scenarios).map(([key, row]) => [
          key,
          { p50: row.p50, p95: row.p95, timeoutRatio: row.timeoutRatio },
        ])
      ),
      peakHostRssBytes: peakRss,
    })
  );
} finally {
  clearInterval(memoryTimer);
  pool?.shutdownPool();
  textWorker?.shutdownTextWorker();
  translation?.shutdownTranslationWorker();
  await vectors?.closeVectorDB();
  database?.closeDatabase();
  await server.close();
}
