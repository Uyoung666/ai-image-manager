/** Density acceptance: production bundles only; reuse one closed, unique fixture. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const COMPLETED_REPORT = /Gallery benchmark complete: (.+)/;
const option = (name, fallback) =>
  process.argv
    .find((arg) => arg.startsWith(`--${name}=`))
    ?.slice(name.length + 3) ?? fallback;
const phase = option("phase", "optimized");
const app = path.resolve(option("app", "."));
const count = Number(option("count", "10000"));
const variantCache = option("variant-cache", "legacy");
const reuseProfile = option("reuse-profile", "0") === "1";
const grids = option("grids", "140,220,320").split(",").map(Number);
const dprs = option("dprs", "1,2").split(",").map(Number);
if (
  !(
    [1000, 10_000].includes(count) &&
    ["legacy", "exact"].includes(variantCache) &&
    grids.every((grid) => [140, 220, 320].includes(grid)) &&
    dprs.every((dpr) => [1, 2].includes(dpr))
  )
) {
  throw new Error("Invalid density matrix dimensions");
}
let fixture = option("fixture", "");
const baselineFile = option("baseline", "");
const baseline = baselineFile
  ? JSON.parse(fs.readFileSync(baselineFile, "utf8"))
  : undefined;
if (
  !(
    ["baseline", "optimized"].includes(phase) &&
    fs.existsSync(path.join(app, ".vite/build/bootstrap.js"))
  )
) {
  throw new Error("Specify a built production app and a valid phase");
}
if (phase === "optimized" && !baseline?.complete) {
  throw new Error(
    "Optimized acceptance requires a completed baseline manifest"
  );
}
const output = path.join(
  root,
  "reports/gallery",
  `density-${phase}-${Date.now()}`
);
fs.mkdirSync(output, { recursive: true });
const results = [];
function save(complete, failed) {
  fs.writeFileSync(
    path.join(output, "manifest.json"),
    JSON.stringify(
      { complete, phase, app, count, variantCache, fixture, failed, results },
      null,
      2
    )
  );
}
function assertBudgets(samples) {
  for (const sample of samples) {
    for (const [name, maximum] of [
      ["imageActive", 6],
      ["imagePrefetchActive", 2],
      ["galleryResidentPages", 20],
      ["galleryResidentPhotos", 2000],
      ["galleryResidentPhotoBytes", 16 * 1024 * 1024],
    ]) {
      if (
        !(
          Number.isFinite(sample.galleryPerf[name]?.max) &&
          sample.galleryPerf[name].max <= maximum
        )
      ) {
        throw new Error(`Invalid or exceeded budget: ${name}`);
      }
    }
    for (const [name, maximum] of [
      ["descriptorActive", 2],
      ["descriptorPrefetchActive", 1],
    ]) {
      if (sample.galleryPerf[name]?.max > maximum) {
        throw new Error(`Exceeded descriptor budget: ${name}`);
      }
    }
  }
}
function runCase(gridColumnWidth, dpr) {
  const name = `${gridColumnWidth}-${dpr}x`;
  const args = [
    "scripts/gallery-perf-auto.mjs",
    `--app=${app}`,
    `--count=${count}`,
    "--runs=5",
    "--seconds=5",
    "--entry-metric=1",
    "--controlled-scroll=1",
    "--fixture-long-edge=1024",
    `--variant-cache=${variantCache}`,
    `--grid-column-width=${gridColumnWidth}`,
    `--dpr=${dpr}`,
    `--scenario=density-${phase}-${name}`,
  ];
  if (fixture) {
    args.push(`--reuse-fixture=${fixture}`);
    if (reuseProfile) {
      args.push("--reuse-profile=1");
    }
    if (count === 1000 && !reuseProfile) {
      args.push("--subset-fixture=1");
    }
  } else {
    args.push("--keep-fixture=1");
  }
  const log = execFileSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(output, `${name}.log`), log);
  const report = log.match(COMPLETED_REPORT)?.[1]?.trim();
  if (!report) {
    throw new Error("Missing completed benchmark report");
  }
  const summary = JSON.parse(
    fs.readFileSync(path.join(report, "summary.json"), "utf8")
  );
  if (summary.results.length !== 5) {
    throw new Error("Density acceptance requires five valid runs");
  }
  fixture ||= summary.results[0].fixtureRoot;
  assertBudgets(summary.results);
  let comparison;
  if (phase === "optimized") {
    if (baseline.count !== count || baseline.variantCache !== variantCache) {
      throw new Error("Baseline density cache/data dimensions differ");
    }
    const before = baseline.results.find(
      (item) => item.gridColumnWidth === gridColumnWidth && item.dpr === dpr
    );
    if (!before) {
      throw new Error(`Missing matching baseline: ${name}`);
    }
    comparison = path.join(output, `comparison-${name}`);
    execFileSync(
      process.execPath,
      [
        "scripts/gallery-perf-compare.mjs",
        path.join(before.report, "summary.json"),
        path.join(report, "summary.json"),
        comparison,
        "entryFirstViewport80Ms",
        "density",
        "scriptedScrollStop95Ms",
      ],
      { cwd: root, encoding: "utf8" }
    );
  }
  results.push({ gridColumnWidth, dpr, report, comparison });
  save(false);
  console.log(`Density ${phase} ${name}: ${report}`);
}
for (const grid of grids) {
  for (const dpr of dprs) {
    try {
      runCase(grid, dpr);
    } catch (error) {
      save(false, `${grid}-${dpr}`);
      throw error;
    }
  }
}
save(true);
console.log(`Density matrix complete: ${output}`);
