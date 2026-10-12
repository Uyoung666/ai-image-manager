import fs from "node:fs";
import path from "node:path";
import { checkSearchRegressions } from "./regression-gate.mjs";

const root = path.resolve(
  "reports/search-optimization/implement-recall-20261010"
);
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const registryFile = path.join(root, "study-runs.json");
const registry = fs.existsSync(registryFile) ? read(registryFile) : {};
function report(name, split) {
  return read(
    path.join(
      registry[`${name}-${split}`] ?? path.join(root, `${name}-${split}`),
      "report.json"
    )
  );
}
const gates = [];
for (const [dataset, baseline, candidate, file] of [
  [
    "v1",
    "current-trace",
    "candidate-v1",
    "scripts/search-benchmark/queries.v1.json",
  ],
  [
    "v2",
    "current-v2",
    "candidate-v2",
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  [
    "fresh",
    "current-fresh",
    "candidate-fresh",
    path.join(root, "queries.v3-sealed.json"),
  ],
]) {
  if (
    ["development", "holdout"].some(
      (split) =>
        !fs.existsSync(
          path.join(
            registry[`${candidate}-${split}`] ??
              path.join(root, `${candidate}-${split}`),
            "report.json"
          )
        )
    )
  ) {
    continue;
  }
  for (const split of ["development", "holdout"]) {
    gates.push({
      dataset,
      ...checkSearchRegressions(
        read(file),
        report(baseline, split),
        report(candidate, split)
      ),
    });
  }
}
fs.writeFileSync(
  path.join(root, "candidate-quality-gates.json"),
  JSON.stringify(
    { passed: gates.length >= 4 && gates.every((gate) => gate.passed), gates },
    null,
    2
  )
);
console.log(
  JSON.stringify(
    gates.map((gate) => ({
      dataset: gate.dataset,
      split: gate.split,
      passed: gate.passed,
      regressions: gate.regressions,
    })),
    null,
    2
  )
);
