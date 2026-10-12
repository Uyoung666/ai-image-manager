import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { measuredDistribution } from "./evaluate.mjs";
import { checkSearchRegressions } from "./regression-gate.mjs";
import { hashRuntimeSourceTree } from "./source-snapshot.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const mode = process.argv[2];
const root = path.resolve(
  process.argv[3] ?? "reports/search-optimization/implement-recall-20261010"
);
const current = path.join(root, "start-workspace");
const finalName = process.argv[4] ?? "final-workspace";
if (!/^final-workspace(?:-[a-z0-9-]+)?$/.test(finalName)) {
  throw new Error(
    "Final source must be a named frozen workspace in study-root"
  );
}
const suffix = finalName.slice("final-workspace".length);
const final = path.join(root, finalName);
const baseline = path.join(root, "revision-91f3b6e");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const runner = path.join(repo, "scripts/run-search-benchmark.mjs");
const runnerHash = sha256(fs.readFileSync(runner));
const registryFile = path.join(root, `final-runs${suffix}.json`);
const registry = fs.existsSync(registryFile) ? read(registryFile) : {};
const study = read(path.join(root, "study-runs.json"));

function completedStudy(name, split) {
  return read(
    path.join(
      study[`${name}-${split}`] ?? path.join(root, `${name}-${split}`),
      "report.json"
    )
  );
}

function run(key, source, split, definition, flags) {
  const metadata = read(path.join(source, "source.json"));
  if (metadata.sourceTreeHash !== hashRuntimeSourceTree(source)) {
    throw new Error(`Frozen source changed: ${source}`);
  }
  let output = registry[key] ?? path.join(root, `${key}${suffix}`);
  const definitionHash = sha256(
    JSON.stringify(read(path.join(repo, definition)))
  );
  if (!fs.existsSync(path.join(output, "report.json"))) {
    let attempt = 1;
    while (fs.existsSync(path.join(output, "profile"))) {
      output = path.join(root, `${key}${suffix}-retry-${attempt++}`);
    }
    const log = fs.openSync(`${output}.log`, "a");
    console.log(`Validation: ${key}`);
    const child = spawnSync(
      process.execPath,
      [
        runner,
        "--source",
        path.join(source, "src"),
        "--split",
        split,
        "--definition",
        definition,
        "--output",
        output,
        ...flags,
      ],
      { cwd: repo, stdio: ["ignore", log, log], env: { ...process.env } }
    );
    fs.closeSync(log);
    if (child.error || child.status !== 0) {
      throw new Error(`Validation failed: ${output}.log`);
    }
    registry[key] = output;
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  }
  const report = read(path.join(output, "report.json"));
  if (
    report.sourceTreeHash !== metadata.sourceTreeHash ||
    report.definitionHash !== definitionHash ||
    report.benchmarkRunnerHash !== runnerHash
  ) {
    throw new Error(`Stale validation conditions: ${output}`);
  }
  return { output, report };
}

const v1 = "scripts/search-benchmark/queries.v1.json";
const v2 = "scripts/search-benchmark/queries.v2-calibration.json";
if (mode === "diagnostics") {
  for (const [name, source] of [
    ["baseline", baseline],
    ["current", current],
  ]) {
    for (const split of ["development", "holdout"]) {
      run(`provenance-${name}-${split}`, source, split, v1, [
        "--quality-only",
        "--trace-quality",
        "--verify-vector-count",
        "160",
        "--probe-text-encoding",
      ]);
    }
  }
} else if (mode === "quality") {
  const gates = [];
  let equivalent = true;
  for (const [dataset, control, approved, definition] of [
    ["v1", "current-trace", "candidate-v1", v1],
    ["v2", "current-v2", "candidate-v2", v2],
  ]) {
    for (const split of ["development", "holdout"]) {
      const { report } = run(
        `final-${dataset}-${split}`,
        final,
        split,
        definition,
        ["--quality-only", "--trace-quality"]
      );
      gates.push({
        dataset,
        ...checkSearchRegressions(
          read(path.join(repo, definition)),
          completedStudy(control, split),
          report
        ),
      });
      const frozen = completedStudy(approved, split);
      equivalent &&= report.queries.every(
        (query) =>
          JSON.stringify(query.results) ===
          JSON.stringify(
            frozen.queries.find((row) => row.id === query.id)?.results
          )
      );
    }
  }
  fs.writeFileSync(
    path.join(root, `production-quality-gates${suffix}.json`),
    JSON.stringify(
      {
        passed:
          equivalent &&
          gates.length === 4 &&
          gates.every((gate) => gate.passed),
        implementationEquivalentToSealedCandidate: equivalent,
        gates,
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      equivalent,
      gates: gates.map((gate) => ({
        dataset: gate.dataset,
        split: gate.split,
        passed: gate.passed,
      })),
    })
  );
} else if (mode === "performance") {
  const approved = read(path.join(root, "candidate-quality-gates.json"));
  if (
    !approved.passed ||
    approved.gates.length !== 6 ||
    !read(path.join(root, `production-quality-gates${suffix}.json`)).passed
  ) {
    throw new Error("Timing requires all per-query quality gates");
  }
  for (let round = 0; round < 3; round++) {
    const order =
      round % 2
        ? [
            ["final", final],
            ["current", current],
          ]
        : [
            ["current", current],
            ["final", final],
          ];
    for (const [name, source] of order) {
      run(`timing-warm-${round}-${name}`, source, "holdout", v1, [
        "--performance-only",
        "--steady-state-only",
        "--rounds",
        "1",
        "--round-offset",
        String(round),
      ]);
    }
  }
  for (let trial = 0; trial < 10; trial++) {
    const order =
      trial % 2
        ? [
            ["final", final],
            ["current", current],
          ]
        : [
            ["current", current],
            ["final", final],
          ];
    for (const [name, source] of order) {
      run(`timing-cold-${trial}-${name}`, source, "holdout", v1, [
        "--cold-only",
      ]);
    }
  }
  const summaries = {};
  const scenarios = ["warm-new-query", "cache-hit", "continuous-switch"];
  const allReports = [];
  for (const name of ["current", "final"]) {
    const warm = Array.from({ length: 3 }, (_, round) =>
      read(path.join(registry[`timing-warm-${round}-${name}`], "report.json"))
    );
    const cold = Array.from({ length: 10 }, (_, trial) =>
      read(path.join(registry[`timing-cold-${trial}-${name}`], "report.json"))
    );
    allReports.push(...warm, ...cold);
    const rows = warm.flatMap((report) => report.performance.observations);
    const summarize = (samples) => ({
      ...measuredDistribution(samples.map((row) => row.elapsedMs)),
      incomplete: samples.filter((row) => row.completion !== "complete").length,
      partial: samples.filter((row) => row.completion === "partial").length,
      timeouts: samples.filter((row) => row.incompleteReason === "deadline")
        .length,
      unknown: samples.filter((row) => row.completion === "legacy").length,
      cacheHits: samples.filter((row) => row.diagnostics?.cacheHit).length,
    });
    summaries[name] = Object.fromEntries(
      scenarios.map((scenario) => [
        scenario,
        summarize(rows.filter((row) => row.scenario === scenario)),
      ])
    );
    summaries[name].cold = summarize(
      cold.map((report) => report.performance.cold)
    );
    summaries[name].rounds = warm.map((report) => report.performance.scenarios);
  }
  const conditionHashes = new Set(
    allReports.map((report) =>
      JSON.stringify({
        machine: report.machine,
        driver: report.benchmarkDriver,
        runner: report.benchmarkRunnerHash,
        definition: report.definitionHash,
        vectors: report.vectorCache.sha256,
        dependencies: report.dependencyLockHash,
      })
    )
  );
  const regressions = ["warm-new-query", "continuous-switch"].filter(
    (scenario) =>
      summaries.final[scenario].p95 > summaries.current[scenario].p95 * 1.1
  );
  const completionValid = ["current", "final"].every((name) =>
    [...scenarios, "cold"].every(
      (scenario) => summaries[name][scenario].incomplete === 0
    )
  );
  const workloadsValid = ["current", "final"].every(
    (name) =>
      scenarios.every((scenario) => summaries[name][scenario].count === 90) &&
      summaries[name].cold.count === 10 &&
      summaries[name]["cache-hit"].cacheHits === 90
  );
  const result = {
    generatedAt: new Date().toISOString(),
    passed:
      conditionHashes.size === 1 &&
      !regressions.length &&
      completionValid &&
      workloadsValid,
    matchingConditions: conditionHashes.size === 1,
    completionValid,
    workloadsValid,
    regressions,
    summaries,
    p95Change: Object.fromEntries(
      [...scenarios, "cold"].map((scenario) => [
        scenario,
        summaries.final[scenario].p95 / summaries.current[scenario].p95 - 1,
      ])
    ),
    order:
      "Serial alternating versions; warm rounds AB/BA/AB; cold trials alternate order",
    osCache:
      "Model and fixture verification already touched OS file caches; process cold only",
    baseline: read(path.join(current, "source.json")),
    candidate: read(path.join(final, "source.json")),
    reports: Object.entries(registry).filter(([key]) =>
      key.startsWith("timing-")
    ),
  };
  fs.writeFileSync(
    path.join(root, `performance-gate${suffix}.json`),
    JSON.stringify(result, null, 2)
  );
  console.log(
    JSON.stringify({
      ...result,
      baseline: undefined,
      candidate: undefined,
      reports: undefined,
    })
  );
} else {
  throw new Error(
    "Usage: validate-recall-change.mjs diagnostics|quality|performance [study-root] [final-workspace-name]"
  );
}
