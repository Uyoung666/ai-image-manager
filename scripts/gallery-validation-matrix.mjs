/** Sequential samples: never overlap Electron measurements with another build/test run. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
if (fs.existsSync(path.join(root, ".cache/gallery-source-invalid"))) {
  throw new Error(
    "Source changed after packaging; rebuild before performance validation"
  );
}
const output = path.join(root, "reports/gallery", `matrix-${Date.now()}`);
fs.mkdirSync(output, { recursive: true });
const baseline = JSON.parse(
  fs.readFileSync(
    path.join(root, "reports/gallery/baseline-build.json"),
    "utf8"
  )
).target;
const cases = [
  {
    name: "baseline-pressure-100k",
    app: baseline,
    count: 100_000,
    view: "album",
    pattern: "deep",
    trace: 1,
    allowFailure: true,
  },
  { name: "baseline-1k", app: baseline, count: 1000 },
  { name: "final-1k", count: 1000, seconds: 5, "entry-metric": 1 },
  { name: "final-10k", count: 10_000, seconds: 5, "entry-metric": 1, trace: 1 },
  { name: "compact-720-1x", count: 1000, width: 720, height: 480 },
  {
    name: "compact-720-2x-corrupt",
    count: 1000,
    width: 720,
    height: 480,
    dpr: 2,
    cache: "corrupt",
  },
  {
    name: "medium-900-1x-warm",
    count: 1000,
    width: 900,
    height: 600,
    cache: "warm",
  },
  {
    name: "medium-900-2x-missing",
    count: 10_000,
    width: 900,
    height: 600,
    dpr: 2,
    cache: "missing",
  },
  { name: "large-1280-2x", count: 1000, dpr: 2 },
  {
    name: "fractional-125",
    count: 1000,
    width: 900,
    height: 600,
    dpr: 1.25,
    runs: 1,
    seconds: 5,
  },
  {
    name: "fractional-150",
    count: 1000,
    width: 900,
    height: 600,
    dpr: 1.5,
    runs: 1,
    seconds: 5,
  },
  {
    name: "fractional-300",
    count: 1000,
    width: 900,
    height: 600,
    dpr: 3,
    runs: 1,
    seconds: 5,
  },
  {
    name: "pressure-100k-2x",
    interactions: 1,
    count: 100_000,
    width: 900,
    height: 600,
    dpr: 2,
    view: "both",
    pattern: "deep",
    anchor: 90_000,
    trace: 1,
    seconds: 35,
  },
  {
    name: "pressure-smart-100k-2x",
    interactions: 1,
    count: 100_000,
    width: 900,
    height: 600,
    dpr: 2,
    view: "album",
    "album-kind": "smart",
    pattern: "deep",
    trace: 1,
    seconds: 35,
  },
  {
    name: "packaged-10k",
    "instrument-executable": 1,
    count: 10_000,
    view: "both",
    pattern: "deep",
    anchor: 9000,
    interactions: 1,
    trace: 1,
    executable: path.join(
      root,
      "out/AI Image Manager-win32-x64/ai-image-manager.exe"
    ),
  },
];
const only = process.argv
  .find((argument) => argument.startsWith("--only="))
  ?.slice(7);
const from = process.argv
  .find((argument) => argument.startsWith("--from="))
  ?.slice(7);
const pressureFixture = process.argv
  .find((argument) => argument.startsWith("--reuse-pressure-fixture="))
  ?.slice("--reuse-pressure-fixture=".length);
if (from && cases.findIndex((item) => item.name === from) < 0) {
  throw new Error(`Unknown starting matrix case: ${from}`);
}
const selected = only
  ? cases.filter((item) => item.name === only)
  : cases.slice(from ? cases.findIndex((item) => item.name === from) : 0);
if (selected.length === 0) {
  throw new Error(`Unknown matrix case: ${only}`);
}
const results = [];
for (const item of selected) {
  const { name, allowFailure, ...options } = item;
  if (name.startsWith("pressure-") && pressureFixture) {
    options["reuse-fixture"] = path.resolve(pressureFixture);
  }
  const args = Object.entries({
    runs: 5,
    seconds: 15,
    ...options,
    scenario: name,
  }).map(([key, value]) => `--${key}=${value}`);
  const log = path.join(output, `${name}.log`);
  try {
    const stdout = execFileSync(
      process.execPath,
      [path.join(root, "scripts/gallery-perf-auto.mjs"), ...args],
      {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        maxBuffer: 64 * 1024 * 1024,
      }
    );
    fs.writeFileSync(log, stdout);
    const report = stdout
      .match(/Gallery benchmark complete: (.+)/)?.[1]
      ?.trim();
    if (!(report && fs.existsSync(path.join(report, "summary.json")))) {
      throw new Error("No completed benchmark report");
    }
    const samples = JSON.parse(
      fs.readFileSync(path.join(report, "summary.json"), "utf8")
    ).results;
    for (const sample of samples) {
      for (const [metric, limit] of [
        ["imageActive", 6],
        ["imagePrefetchActive", 2],
        ["galleryResidentPages", 20],
        ["galleryResidentPhotos", 2000],
        ["galleryResidentPhotoBytes", 16 * 1024 * 1024],
      ]) {
        const value = sample.galleryPerf[metric]?.max;
        if (!(Number.isFinite(value) && value <= limit)) {
          throw new Error(`${name}: ${metric} is missing or exceeds ${limit}`);
        }
      }
      if (
        options.cache === "warm" &&
        sample.cachePrime?.images !== options.count
      ) {
        throw new Error(`${name}: browser cache was not fully primed`);
      }
    }
    results.push({ name, options, report, log });
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify({ complete: false, results }, null, 2)
    );
    console.log(
      `Matrix ${results.length}/${selected.length}: ${name} → ${report}`
    );
  } catch (error) {
    fs.writeFileSync(
      log,
      `${error.stdout ?? ""}\n${error.stderr ?? ""}\n${error.stack}`
    );
    fs.writeFileSync(
      path.join(output, "manifest.json"),
      JSON.stringify({ complete: false, results, failed: name, log }, null, 2)
    );
    if (allowFailure) {
      results.push({ name, options, failed: true, log });
      console.log(
        `Baseline pressure case failed; diagnostics retained: ${log}`
      );
      continue;
    }
    throw error;
  }
}
fs.writeFileSync(
  path.join(output, "manifest.json"),
  JSON.stringify({ complete: true, results }, null, 2)
);
console.log(`Matrix complete: ${output}`);
