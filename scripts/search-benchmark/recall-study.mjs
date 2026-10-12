import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { freezeWorkspace, hashRuntimeSourceTree } from "./source-snapshot.mjs";

const repo = path.resolve(import.meta.dirname, "../..");
const root = path.join(
  repo,
  "reports/search-optimization/implement-recall-20261010"
);
const start = path.join(root, "start-workspace");
const baseline = path.join(root, "revision-91f3b6e");
const SUBJECT_TEMPLATE_EXPRESSION = [
  "$",
  "{translateSlot(parsed.subject)}",
].join("");
const SUBJECT_PHOTOGRAPH_TEMPLATE = `a photograph of ${SUBJECT_TEMPLATE_EXPRESSION}`;
const SUBJECT_PHOTO_TEMPLATE = `a photo of ${SUBJECT_TEMPLATE_EXPRESSION}`;
function diagnosticVariant(name, modify) {
  const target = path.join(root, name);
  if (fs.existsSync(target)) {
    return target;
  }
  const metadata = freezeWorkspace(start, target);
  modify(target);
  metadata.sourceTreeHash = hashRuntimeSourceTree(target);
  metadata.diagnosticOnly = true;
  metadata.parentHash = hashRuntimeSourceTree(start);
  metadata.ablation = name;
  fs.writeFileSync(
    path.join(target, "source.json"),
    JSON.stringify(metadata, null, 2)
  );
  return target;
}
const text = diagnosticVariant("ablation-legacy-text-v2", (target) => {
  const file = "src/services/ai/search.ts";
  const current = fs.readFileSync(path.join(target, file), "utf8");
  const old = fs.readFileSync(path.join(baseline, file), "utf8");
  const from = old.indexOf("async function embedSearchTexts(");
  const to = old.indexOf("interface MultiPromptSearchResult", from);
  const a = current.indexOf("async function embedSearchTexts(");
  const b = current.indexOf("interface MultiPromptSearchResult", a);
  if ([from, to, a, b].some((index) => index < 0)) {
    throw new Error("Missing text ablation anchor");
  }
  fs.writeFileSync(
    path.join(target, file),
    current.slice(0, a) +
      "const pendingEmbeddingBatches = new Map<string,Promise<number[][]>>();\n" +
      old.slice(from, to) +
      current.slice(b)
  );
});
const parser = diagnosticVariant("ablation-legacy-parser-v2", (target) => {
  const file = "src/services/ai/query-parser.ts";
  const current = fs.readFileSync(path.join(target, file), "utf8");
  const old = fs.readFileSync(path.join(baseline, file), "utf8");
  const from = old.indexOf("export function parseChineseQuery(");
  const to = old.indexOf("function translateTerm(", from);
  const a = current.indexOf("export function parseChineseQuery(");
  const b = current.indexOf("function isKnownTermBoundary(", a);
  const parse = old
    .slice(from, to)
    .replace(
      "getSortedDictKeys()",
      "Object.keys(dict).sort((a,b)=>b.length-a.length)"
    )
    .replaceAll("CJK_RE.test(char)", "DIAGNOSTIC_CJK_RE.test(char)");
  if ([from, to, a, b].some((index) => index < 0)) {
    throw new Error("Parser boundary anchor differs");
  }
  fs.writeFileSync(
    path.join(target, file),
    current.slice(0, a) +
      "const DIAGNOSTIC_CJK_RE = /[一-鿿]/;\n" +
      parse +
      current.slice(b)
  );
});
const focus = diagnosticVariant("ablation-focused-modifiers-v1", (target) => {
  const file = path.join(target, "src/services/ai/query-parser.ts");
  const source = fs.readFileSync(file, "utf8");
  const anchor = "(parsed.scene.length > 0 || parsed.activity.length > 0)";
  if (!source.includes(anchor)) {
    throw new Error("Missing focus anchor");
  }
  fs.writeFileSync(
    file,
    source.replace(
      anchor,
      "(parsed.scene.length > 0 || parsed.activity.length > 0 || parsed.color.length > 0 || parsed.style.length > 0)"
    )
  );
});
const floor = diagnosticVariant("ablation-composed-floor-control", (target) => {
  const file = path.join(target, "src/services/ai/scoring.ts");
  const source = fs.readFileSync(file, "utf8");
  const anchor = "base: 0.045,";
  if (source.split(anchor).length !== 2) {
    throw new Error("Floor anchor differs");
  }
  fs.writeFileSync(file, source.replace(anchor, "base: 0.04,"));
});
const template = diagnosticVariant("ablation-focused-template", (target) => {
  const file = path.join(target, "src/services/ai/query-parser.ts");
  const source = fs.readFileSync(file, "utf8");
  const anchor = SUBJECT_PHOTOGRAPH_TEMPLATE;
  if (source.split(anchor).length !== 2) {
    throw new Error("Focused template anchor differs");
  }
  fs.writeFileSync(file, source.replace(anchor, SUBJECT_PHOTO_TEMPLATE));
});
const focusedCombination = diagnosticVariant(
  "ablation-focused-combination",
  (target) => {
    const file = path.join(target, "src/services/ai/query-parser.ts");
    fs.copyFileSync(path.join(focus, "src/services/ai/query-parser.ts"), file);
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      source.replace(SUBJECT_PHOTOGRAPH_TEMPLATE, SUBJECT_PHOTO_TEMPLATE)
    );
  }
);
const objectColors = diagnosticVariant("ablation-object-colors", (target) => {
  const file = path.join(target, "src/services/ai/query-parser.ts");
  const source = fs.readFileSync(file, "utf8");
  const anchor = "(parsed.scene.length > 0 || parsed.activity.length > 0)";
  if (source.split(anchor).length !== 2) {
    throw new Error("Object color anchor differs");
  }
  fs.writeFileSync(
    file,
    source.replace(
      anchor,
      "(parsed.scene.length > 0 || parsed.activity.length > 0 || (parsed.color.length > 0 && parsed.subject.every(term => getMergedDict()[term]?.category === 'object')))"
    )
  );
});
const objectColorTemplate = diagnosticVariant(
  "ablation-object-color-template",
  (target) => {
    const file = path.join(target, "src/services/ai/query-parser.ts");
    fs.copyFileSync(
      path.join(objectColors, "src/services/ai/query-parser.ts"),
      file
    );
    const source = fs.readFileSync(file, "utf8");
    fs.writeFileSync(
      file,
      source.replace(SUBJECT_PHOTOGRAPH_TEMPLATE, SUBJECT_PHOTO_TEMPLATE)
    );
  }
);
const jobs = [
  [
    "current-fresh",
    start,
    "reports/search-optimization/implement-recall-20261010/queries.v3-sealed.json",
  ],
  [
    "candidate-fresh",
    path.join(root, "candidate-object-calibration"),
    "reports/search-optimization/implement-recall-20261010/queries.v3-sealed.json",
  ],
  [
    "candidate-v1",
    path.join(root, "candidate-object-calibration"),
    "scripts/search-benchmark/queries.v1.json",
  ],
  [
    "candidate-v2",
    path.join(root, "candidate-object-calibration"),
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  ["baseline", baseline, "scripts/search-benchmark/queries.v1.json"],
  [
    "baseline-v2",
    baseline,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  [
    "optimization",
    path.join(root, "revision-465fb61"),
    "scripts/search-benchmark/queries.v1.json",
  ],
  [
    "followup",
    path.join(root, "revision-38a04f5"),
    "scripts/search-benchmark/queries.v1.json",
  ],
  ["current-v2", start, "scripts/search-benchmark/queries.v2-calibration.json"],
  ["object-colors", objectColors, "scripts/search-benchmark/queries.v1.json"],
  [
    "object-colors-v2",
    objectColors,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  [
    "object-color-template",
    objectColorTemplate,
    "scripts/search-benchmark/queries.v1.json",
  ],
  [
    "object-color-template-v2",
    objectColorTemplate,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  ["focused-template", template, "scripts/search-benchmark/queries.v1.json"],
  [
    "focused-combination",
    focusedCombination,
    "scripts/search-benchmark/queries.v1.json",
  ],
  [
    "focused-combination-v2",
    focusedCombination,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  ["floor-control", floor, "scripts/search-benchmark/queries.v1.json"],
  [
    "floor-control-v2",
    floor,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
  [
    "translation-control",
    start,
    "scripts/search-benchmark/queries.v1.json",
    "--diagnostic-translations",
    "reports/search-optimization/implement-recall-20261010/equivalent-main-translations.json",
  ],
  [
    "legacy-image",
    start,
    "scripts/search-benchmark/queries.v1.json",
    "--diagnostic-image-cache",
    "reports/search-optimization/image-vectors.3783e26470a9c860ebc1.json",
  ],
  ["legacy-text", text, "scripts/search-benchmark/queries.v1.json"],
  ["legacy-parser", parser, "scripts/search-benchmark/queries.v1.json"],
  ["focused-modifiers", focus, "scripts/search-benchmark/queries.v1.json"],
  [
    "focused-modifiers-v2",
    focus,
    "scripts/search-benchmark/queries.v2-calibration.json",
  ],
];
const requested = process.argv[2];
const registryFile = path.join(root, "study-runs.json");
const registry = fs.existsSync(registryFile)
  ? JSON.parse(fs.readFileSync(registryFile, "utf8"))
  : {};
for (const [name, source, definition, ...extra] of jobs.filter((job) =>
  requested ? requested.split(",").includes(job[0]) : !job[0].endsWith("fresh")
)) {
  if (name.endsWith("fresh")) {
    const gates = JSON.parse(
      fs.readFileSync(path.join(root, "candidate-quality-gates.json"), "utf8")
    );
    const seal = JSON.parse(
      fs.readFileSync(path.join(root, "validation-seal.json"), "utf8")
    );
    const definitionBytes = fs.readFileSync(path.join(repo, definition));
    const manifestBytes = fs.readFileSync(
      path.join(repo, JSON.parse(definitionBytes).sourceManifest)
    );
    const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
    if (
      sha256(definitionBytes) !== seal.fileHash ||
      sha256(manifestBytes) !== seal.manifestHash
    ) {
      throw new Error("Sealed validation judgments or images changed");
    }
    if (!gates.passed || gates.gates.length < 4) {
      throw new Error("Fresh validation requires frozen v1/v2 gates");
    }
    const metadata = JSON.parse(
      fs.readFileSync(
        path.join(root, "candidate-object-calibration/source.json"),
        "utf8"
      )
    );
    if (
      metadata.sourceTreeHash !==
      hashRuntimeSourceTree(path.join(root, "candidate-object-calibration"))
    ) {
      throw new Error("Candidate changed before fresh validation");
    }
    const useFile = path.join(root, "validation-use.json");
    if (!fs.existsSync(useFile)) {
      fs.writeFileSync(
        useFile,
        JSON.stringify(
          {
            startedAt: new Date().toISOString(),
            candidateHash: metadata.sourceTreeHash,
            definitionHash: seal.definitionHash,
            oneShot: true,
          },
          null,
          2
        ),
        { flag: "wx" }
      );
    } else if (
      JSON.parse(fs.readFileSync(useFile, "utf8")).candidateHash !==
      metadata.sourceTreeHash
    ) {
      throw new Error("Fresh validation is spent; do not retune");
    }
  }
  for (const split of ["development", "holdout"]) {
    const key = `${name}-${split}`;
    let output = registry[key] ?? path.join(root, key);
    if (fs.existsSync(path.join(output, "report.json"))) {
      continue;
    }
    let attempt = 1;
    while (fs.existsSync(path.join(output, "profile"))) {
      output = path.join(root, `${key}-retry-${attempt++}`);
    }
    const log = fs.openSync(`${output}.log`, "a");
    console.log(`Study: ${name} ${split}`);
    const result = spawnSync(
      process.execPath,
      [
        path.join(repo, "scripts/run-search-benchmark.mjs"),
        "--source",
        path.join(source, "src"),
        "--definition",
        definition,
        "--split",
        split,
        "--quality-only",
        "--trace-quality",
        "--output",
        output,
        ...extra,
      ],
      { cwd: repo, stdio: ["ignore", log, log], env: { ...process.env } }
    );
    fs.closeSync(log);
    if (result.error || result.status !== 0) {
      throw new Error(`${name} ${split} failed: see ${output}.log`);
    }
    registry[key] = output;
    fs.writeFileSync(registryFile, JSON.stringify(registry, null, 2));
  }
}
