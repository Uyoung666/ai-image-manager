/** Serial matrix: do not run other tests/builds while collecting these timings. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  assessSearchCorrectness,
  assessSearchQuality,
  checkSearchRegressions,
} from "./regression-gate.mjs";
import { freezeHead, freezeWorkspace } from "./source-snapshot.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const stamp = process.argv[2] ?? `final-${Date.now()}`;
if (!/^[a-z0-9-]+$/i.test(stamp)) {
  throw new Error("Use a simple run directory name");
}
const root = path.join(repo, "reports/search-optimization", stamp);
const resume = process.argv.includes("--resume");
const policyIndex = process.argv.indexOf("--quality-policy");
const requestedPolicy =
  policyIndex < 0 ? undefined : process.argv[policyIndex + 1];
if (policyIndex >= 0) {
  assessSearchQuality([], requestedPolicy ?? "invalid");
}
const optimized = path.join(root, "optimized/src");
if (!resume) {
  fs.mkdirSync(path.dirname(root), { recursive: true });
  fs.mkdirSync(root, { recursive: false });
  freezeWorkspace(repo, path.dirname(optimized));
  freezeHead(repo, path.join(root, "head"));
}
const sources = {
  head: path.join(root, "head/src"),
  baseline: path.join(
    repo,
    "reports/search-optimization",
    `${stamp}-baseline/src`
  ),
  optimized,
};
const matrix = resume
  ? JSON.parse(fs.readFileSync(path.join(root, "matrix.json"), "utf8"))
  : {
      schemaVersion: 2,
      root,
      sources,
      startedAt: new Date().toISOString(),
      runs: [],
    };
if (matrix.schemaVersion !== 2) {
  throw new Error("Start a fresh matrix for the HEAD quality gate");
}
matrix.qualityPolicy = requestedPolicy ?? matrix.qualityPolicy ?? "strict";
function execute(run) {
  const name = `${run.variant}-${run.qualityOnly ? "quality-" : ""}${run.size || run.split}`;
  if (
    matrix.runs.some(
      (previous) => previous.name === name && previous.exitCode === 0
    )
  ) {
    return;
  }
  const output = path.join(
    root,
    fs.existsSync(path.join(root, name)) ? `${name}-retry-${Date.now()}` : name
  );
  const fd = fs.openSync(`${output}.log`, "w");
  const args = [
    path.join(repo, "scripts/run-search-benchmark.mjs"),
    "--source",
    matrix.sources[run.variant],
    "--label",
    run.variant,
    "--split",
    run.split,
    "--output",
    output,
  ];
  if (run.qualityOnly) {
    args.push("--quality-only");
    if (run.variant === "optimized") {
      args.push("--trace-quality");
    }
  }
  if (run.size) {
    args.push("--synthetic", String(run.size));
  }
  console.log(`Starting ${name}`);
  const result = spawnSync(process.execPath, args, {
    cwd: repo,
    stdio: ["ignore", fd, fd],
  });
  fs.closeSync(fd);
  matrix.runs = matrix.runs.filter((previous) => previous.name !== name);
  matrix.runs.push({
    ...run,
    name,
    output,
    exitCode: result.status,
    error: result.error?.message,
  });
  fs.writeFileSync(
    path.join(root, "matrix.json"),
    JSON.stringify(matrix, null, 2)
  );
  if (result.status !== 0) {
    throw new Error(`Failed ${name}; inspect its isolated log`);
  }
  console.log(`Completed ${name}`);
}
for (const split of ["development", "holdout"]) {
  for (const variant of ["head", "optimized"]) {
    execute({ variant, split, size: 0, qualityOnly: true });
  }
}
const readReport = (variant, split) => {
  const run = matrix.runs.find(
    (row) => row.name === `${variant}-quality-${split}` && row.exitCode === 0
  );
  return JSON.parse(
    fs.readFileSync(path.join(run.output, "report.json"), "utf8")
  );
};
const definition = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, "queries.v1.json"), "utf8")
);
const qualityGates = ["development", "holdout"].map((split) =>
  checkSearchRegressions(
    definition,
    readReport("head", split),
    readReport("optimized", split),
    { requireHead: true }
  )
);
matrix.qualityPassed = qualityGates.every((gate) => gate.passed);
matrix.qualityAssessment = assessSearchQuality(
  qualityGates,
  matrix.qualityPolicy
);
fs.writeFileSync(
  path.join(root, "quality-gate.json"),
  JSON.stringify(qualityGates, null, 2)
);
fs.writeFileSync(
  path.join(root, "matrix.json"),
  JSON.stringify(matrix, null, 2)
);
if (!matrix.qualityAssessment.accepted) {
  throw new Error(
    "Quality policy rejected this run; inspect quality-gate.json. Speed acceptance is blocked."
  );
}
if (matrix.qualityAssessment.warnings.length) {
  console.log(
    `Current-model policy: ${matrix.qualityAssessment.warnings.length} quality differences retained as warnings; this is not a no-regression claim.`
  );
}
if (!fs.existsSync(matrix.sources.baseline)) {
  const baseline = spawnSync(
    process.execPath,
    [
      path.join(import.meta.dirname, "create-correctness-baseline.mjs"),
      `${stamp}-baseline`,
      "--source",
      optimized,
    ],
    { cwd: repo, stdio: "inherit" }
  );
  if (baseline.error || baseline.status !== 0) {
    throw new Error("Could not freeze correctness comparator");
  }
}
for (const split of ["development", "holdout"]) {
  for (const variant of ["baseline", "optimized"]) {
    execute({ variant, split, size: 0 });
  }
}
for (const size of [10_000, 50_000]) {
  for (const variant of ["baseline", "optimized"]) {
    execute({ variant, split: "holdout", size });
  }
}
matrix.correctnessAssessment = assessSearchCorrectness(
  matrix.runs
    .filter((run) => run.size > 0)
    .map((run) =>
      JSON.parse(fs.readFileSync(path.join(run.output, "report.json"), "utf8"))
    )
);
if (!matrix.correctnessAssessment.passed) {
  fs.writeFileSync(
    path.join(root, "matrix.json"),
    JSON.stringify(matrix, null, 2)
  );
  throw new Error(
    "Software correctness gate rejected this matrix; numeric model warnings cannot override it"
  );
}
matrix.finishedAt = new Date().toISOString();
fs.writeFileSync(
  path.join(root, "matrix.json"),
  JSON.stringify(matrix, null, 2)
);
console.log(root);
