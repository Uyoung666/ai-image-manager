import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCorrectnessBaseline,
  reconstructCorrectnessSources,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/create-correctness-baseline.mjs";
import {
  evaluateSearchRun,
  measuredDistribution,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/evaluate.mjs";
// @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
import { createNativeModuleBridge } from "../../../scripts/search-benchmark/native-module-bridge.mjs";
import {
  encodeTraceTexts,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/quality-trace.mjs";
import {
  assessSearchCorrectness,
  assessSearchQuality,
  checkSearchRegressions,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/regression-gate.mjs";
import {
  copyRendererArtifacts,
  fingerprintRendererArtifacts,
  resolveComparisonRendererSources,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/renderer-artifacts.mjs";
import {
  fingerprintModelArtifacts,
  freezeWorkspace,
  hashRuntimeSourceTree,
  linkSharedModelArtifacts,
  // @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
} from "../../../scripts/search-benchmark/source-snapshot.mjs";
// @ts-expect-error Evaluation intentionally remains runnable as plain Node ESM.
import { verifyBenchmarkVectors } from "../../../scripts/search-benchmark/vector-integrity.mjs";

const fixtures: string[] = [];
const fixtureRoot = path.resolve(
  import.meta.dirname,
  "../../../reports/search-optimization/unit-source-snapshots"
);
const fixture = () => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const directory = fs.mkdtempSync(
    path.join(fixtureRoot, "search-source-snapshot-")
  );
  fixtures.push(directory);
  return directory;
};
const writeFixture = (root: string, relative: string, value: string) => {
  const target = path.join(root, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
};
afterEach(async () => {
  for (const directory of fixtures.splice(0)) {
    const resolved = fs.realpathSync(directory);
    const intendedRoot = fs.realpathSync(fixtureRoot);
    if (
      !(
        resolved.startsWith(intendedRoot + path.sep) &&
        path.basename(resolved).startsWith("search-source-snapshot-")
      )
    ) {
      throw new Error("Fixture cleanup escaped its isolated temporary root");
    }
    await fs.promises.rm(resolved, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("reproducible search runtime", () => {
  it("loads native CommonJS packages without treating them as Vite source", async () => {
    const bridge = createNativeModuleBridge();
    try {
      expect(bridge.resolveId("electron")).toBeNull();
      expect(bridge.resolveId("@/services/ai/search")).toBeNull();
      expect(bridge.resolveId("node:fs")).toBeNull();
      const code = await bridge.load(bridge.resolveId("pino"));
      const namespace = await import(
        `data:text/javascript;base64,${Buffer.from(code).toString("base64")}`
      );
      expect(typeof namespace.default).toBe("function");
      expect(typeof namespace.stdSerializers.err).toBe("function");
    } finally {
      bridge.closeBundle();
    }
  });

  it("rejects image tampering, duplicate IDs and wrong vector shapes before indexing", () => {
    const root = fixture();
    const filePath = path.join(root, "fixture.jpg");
    fs.writeFileSync(filePath, "image-content");
    const sha256 = createHash("sha256").update("image-content").digest("hex");
    const samples = [{ id: "fixture", index: 0, filePath, source: { sha256 } }];
    const row = { id: 1, sha256, vector: [1, 0] };
    expect(verifyBenchmarkVectors(samples, [row], 2).verifiedImages).toBe(1);
    expect(() => verifyBenchmarkVectors(samples, [row, row], 2)).toThrow(
      "Duplicate"
    );
    expect(() => verifyBenchmarkVectors(samples, [row], 3)).toThrow(
      "dimensions"
    );
    expect(() =>
      verifyBenchmarkVectors(samples, [{ ...row, vector: [0.1, 0] }], 2)
    ).toThrow("Unnormalized");
    fs.writeFileSync(filePath, "tampered");
    expect(() => verifyBenchmarkVectors(samples, [row], 2)).toThrow("mismatch");
  });
  it("makes shared weights resolvable from the frozen cwd and preserves frozen configs", () => {
    const root = fixture();
    writeFixture(root, "models/model/preprocessor_config.json", "config");
    writeFixture(root, "models/model/onnx/model.onnx", "weights");
    const frozen = path.join(root, "reports/frozen");
    fs.mkdirSync(path.dirname(frozen), { recursive: true });
    const metadata = freezeWorkspace(root, frozen);
    writeFixture(root, "models/model/preprocessor_config.json", "live changed");
    linkSharedModelArtifacts(root, frozen);
    linkSharedModelArtifacts(root, frozen);
    expect(
      fs.readFileSync(path.join(frozen, "models/model/onnx/model.onnx"), "utf8")
    ).toBe("weights");
    expect(
      fs.readFileSync(
        path.join(frozen, "models/model/preprocessor_config.json"),
        "utf8"
      )
    ).toBe("config");
    expect(hashRuntimeSourceTree(frozen)).toBe(metadata.sourceTreeHash);
    expect(fingerprintModelArtifacts(frozen)).toEqual(
      fingerprintModelArtifacts(root)
    );
    fs.unlinkSync(path.join(frozen, "models/model/onnx/model.onnx"));
    writeFixture(frozen, "models/model/onnx/model.onnx", "stale");
    expect(() => linkSharedModelArtifacts(root, frozen)).toThrow(
      "already exists"
    );
    expect(
      fs.readFileSync(path.join(root, "models/model/onnx/model.onnx"), "utf8")
    ).toBe("weights");
  });
  it("freezes production workers, helpers, migrations, model configs and lockfile", () => {
    const root = fixture();
    writeFixture(root, "src/services/ai/search.ts", "source");
    writeFixture(root, "scripts/embed-worker.mjs", "worker");
    writeFixture(root, "scripts/image-preprocessing.mjs", "helper");
    writeFixture(root, "drizzle/0053_search.sql", "migration");
    writeFixture(root, "package-lock.json", "lock");
    writeFixture(root, "models/model/preprocessor_config.json", "config");
    writeFixture(root, "models/model/onnx/model.onnx", "weights");
    writeFixture(root, "reports/unrelated.json", "ignored");
    const frozen = path.join(root, "reports/frozen");
    fs.mkdirSync(path.dirname(frozen), { recursive: true });
    const metadata = freezeWorkspace(root, frozen);
    expect(metadata.files).toContain("scripts/image-preprocessing.mjs");
    expect(metadata.files).toContain("package-lock.json");
    expect(metadata.files).toContain("models/model/preprocessor_config.json");
    expect(metadata.files).not.toContain("models/model/onnx/model.onnx");
    expect(metadata.sourceTreeHash).toBe(hashRuntimeSourceTree(frozen));
    const before = hashRuntimeSourceTree(root);
    writeFixture(root, "scripts/image-preprocessing.mjs", "new helper");
    expect(hashRuntimeSourceTree(root)).not.toBe(before);
    expect(hashRuntimeSourceTree(frozen)).toBe(metadata.sourceTreeHash);
    writeFixture(root, "scripts/image-preprocessing.mjs", "helper");
    writeFixture(root, "package-lock.json", "new lock");
    expect(hashRuntimeSourceTree(root)).not.toBe(before);
  });
  it("fingerprints weights separately without pretending they are Git source", () => {
    const root = fixture();
    writeFixture(root, "models/model/onnx/model.onnx", "weights");
    expect(fingerprintModelArtifacts(root)).toEqual([
      {
        file: "models/model/onnx/model.onnx",
        size: 7,
        sha256: createHash("sha256").update("weights").digest("hex"),
      },
    ]);
  });
  it("reconstructs full reads without nesting vector queues or changing encoding and cancellation", () => {
    const root = fixture();
    const repo = path.resolve(import.meta.dirname, "../../..");
    const source = fs
      .readFileSync(path.join(repo, "src/services/ai/search.ts"), "utf8")
      .replaceAll("\r\n", "\n");
    const handler = fs
      .readFileSync(
        path.join(repo, "src/ipc/photos/handlers/search.ts"),
        "utf8"
      )
      .replaceAll("\r\n", "\n");
    writeFixture(root, "src/services/ai/search.ts", source);
    writeFixture(root, "src/ipc/photos/handlers/search.ts", handler);
    writeFixture(
      root,
      "src/services/search-control.ts",
      "controller?.abort();"
    );
    writeFixture(root, "scripts/embed-worker.mjs", "frozen worker");
    writeFixture(
      root,
      "scripts/image-preprocessing.mjs",
      "frozen bicubic helper"
    );
    writeFixture(root, "package-lock.json", "frozen lock");
    fs.mkdirSync(path.join(root, "reports/search-optimization"), {
      recursive: true,
    });
    const target = createCorrectnessBaseline(
      root,
      "baseline",
      path.join(root, "src")
    );
    const reconstructed = fs.readFileSync(
      path.join(target, "services/ai/search.ts"),
      "utf8"
    );
    expect(reconstructed).toContain("modelInstance.embedTexts([text])");
    expect(reconstructed).toContain("start += 500");
    expect(reconstructed).not.toContain(
      "return withVectorDbOperation(() => performTextSearch("
    );
    expect(reconstructed).not.toContain('vq = vq.select(["photo_id"]);');
    expect(
      fs.readFileSync(path.join(target, "services/search-control.ts"), "utf8")
    ).toBe("controller?.abort();");
    expect(
      fs.readFileSync(
        path.join(target, "../scripts/image-preprocessing.mjs"),
        "utf8"
      )
    ).toBe("frozen bicubic helper");
    for (const file of [
      "services/ai/search.ts",
      "ipc/photos/handlers/search.ts",
    ]) {
      const result = ts.transpileModule(
        fs.readFileSync(path.join(target, file), "utf8"),
        {
          compilerOptions: { target: ts.ScriptTarget.ESNext },
          reportDiagnostics: true,
        }
      );
      expect(
        result.diagnostics?.filter(
          (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error
        )
      ).toEqual([]);
    }
    expect(() =>
      reconstructCorrectnessSources("changed source", handler)
    ).toThrow("vector projection");
  });
  it("encodes every traced concept separately including reused and negative texts", async () => {
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map((text) => [text.length, 1])
    );
    const vectors = await encodeTraceTexts({ embedTexts }, [
      "primary",
      "focused",
      "primary",
      "negative",
    ]);
    expect(embedTexts.mock.calls.map(([texts]) => texts)).toEqual([
      ["primary"],
      ["focused"],
      ["negative"],
    ]);
    expect(vectors).toEqual([
      [7, 1],
      [7, 1],
      [7, 1],
      [8, 1],
    ]);
    await expect(
      encodeTraceTexts({ embedTexts: async () => [[Number.NaN]] }, ["invalid"])
    ).rejects.toThrow("Invalid single-text");
  });
  it("requires independent version-matched functional evidence even when model differences are warnings", () => {
    expect(
      assessSearchQuality(
        [{ passed: false, regressions: [{ incomplete: false }] }],
        "current-model"
      ).accepted
    ).toBe(true);
    expect(
      assessSearchCorrectness([{ sourceTreeHash: "current" }]).passed
    ).toBe(false);
    const report = {
      sourceTreeHash: "current",
      correctness: {
        sourceTreeHash: "current",
        passed: true,
        checks: {
          exactPaginationReachability: true,
          semanticPaginationReachability: true,
          pageSizeInvariant: true,
          hardFilters: true,
          exactTotalAndCompletion: true,
        },
      },
    };
    expect(assessSearchCorrectness([report]).passed).toBe(true);
    expect(
      assessSearchCorrectness([{ ...report, sourceTreeHash: "changed" }]).passed
    ).toBe(false);
    expect(
      assessSearchCorrectness([
        {
          ...report,
          correctness: {
            ...report.correctness,
            checks: { ...report.correctness.checks, pageSizeInvariant: false },
          },
        },
      ]).passed
    ).toBe(false);
  });
});

describe("Electron comparison renderer artifacts", () => {
  const renderer = (root: string, relative: string, script: string) => {
    const directory = path.join(root, relative);
    writeFixture(
      directory,
      "main_window/index.html",
      "<script src='./assets/app.js'></script>"
    );
    writeFixture(directory, "main_window/assets/app.js", script);
    writeFixture(
      directory,
      "main_window/assets/app.css",
      "body { color: red; }"
    );
    writeFixture(directory, "main_window/assets/image.webp", "image fixture");
    return directory;
  };

  it("keeps the shared renderer default and accepts an explicit frozen baseline", () => {
    const root = fixture();
    const current = renderer(root, "current", "current");
    const frozen = renderer(root, "frozen", "frozen");
    expect(resolveComparisonRendererSources([], current)).toEqual({
      baseline: current,
      optimized: current,
    });
    expect(
      resolveComparisonRendererSources(["--baseline-renderer", frozen], current)
    ).toEqual({ baseline: frozen, optimized: current });
    expect(() =>
      resolveComparisonRendererSources(["--baseline-renderer"], current)
    ).toThrow("Expected optional");
    expect(() =>
      resolveComparisonRendererSources(["--unknown", frozen], current)
    ).toThrow("Expected optional");
    expect(() =>
      resolveComparisonRendererSources(
        ["--baseline-renderer", path.join(root, "missing")],
        current
      )
    ).toThrow();
  });

  it("checks every copied artifact and leaves both input renderers unchanged", () => {
    const root = fixture();
    const current = renderer(root, "current", "current");
    const frozen = renderer(root, "frozen", "frozen");
    const currentBefore = fingerprintRendererArtifacts(current);
    const frozenBefore = fingerprintRendererArtifacts(frozen);
    expect(currentBefore.entrySha256).toBe(frozenBefore.entrySha256);
    expect(currentBefore.sha256).not.toBe(frozenBefore.sha256);
    expect(
      frozenBefore.files.map((file: { file: string }) => file.file)
    ).toContain("main_window/assets/image.webp");
    const destination = path.join(root, "copied");
    expect(copyRendererArtifacts(frozen, destination, frozenBefore)).toEqual(
      frozenBefore
    );
    expect(fingerprintRendererArtifacts(current)).toEqual(currentBefore);
    expect(fingerprintRendererArtifacts(frozen)).toEqual(frozenBefore);
    writeFixture(destination, "main_window/assets/app.css", "changed output");
    expect(fingerprintRendererArtifacts(destination).sha256).not.toBe(
      frozenBefore.sha256
    );
    expect(fingerprintRendererArtifacts(frozen)).toEqual(frozenBefore);
    expect(() =>
      copyRendererArtifacts(frozen, path.join(frozen, "nested"), frozenBefore)
    ).toThrow("must not overlap");
    expect(() => copyRendererArtifacts(frozen, root, frozenBefore)).toThrow(
      "must not overlap"
    );
  });

  it("rejects missing built entries, changed source artifacts and existing output", () => {
    const root = fixture();
    const source = renderer(root, "source", "source");
    const before = fingerprintRendererArtifacts(source);
    const destination = path.join(root, "copied");
    copyRendererArtifacts(source, destination, before);
    expect(() => copyRendererArtifacts(source, destination, before)).toThrow(
      "already exists"
    );
    writeFixture(source, "main_window/assets/app.js", "changed source");
    expect(() =>
      copyRendererArtifacts(source, path.join(root, "other"), before)
    ).toThrow("changed before copying");
    expect(fs.existsSync(path.join(root, "other"))).toBe(false);
    const empty = path.join(root, "empty");
    fs.mkdirSync(empty);
    expect(() => fingerprintRendererArtifacts(empty)).toThrow(
      "entry is missing"
    );
  });

  it("rejects linked renderer roots, linked ancestors and linked artifacts", () => {
    const root = fixture();
    const source = renderer(root, "source", "source");
    const linked = path.join(root, "linked");
    fs.symlinkSync(source, linked, "junction");
    expect(() =>
      resolveComparisonRendererSources(["--baseline-renderer", linked], source)
    ).toThrow("ordinary directories");
    expect(() =>
      fingerprintRendererArtifacts(path.join(linked, "main_window"))
    ).toThrow("ordinary directories");
    fs.symlinkSync(
      path.join(source, "main_window/assets"),
      path.join(source, "linked-assets"),
      "junction"
    );
    expect(() => fingerprintRendererArtifacts(source)).toThrow(
      "must not contain links"
    );
  });

  it("rejects copied artifacts that differ from the frozen input", () => {
    const root = fixture();
    const source = renderer(root, "source", "source");
    const before = fingerprintRendererArtifacts(source);
    const actualCopy = fs.cpSync;
    const copy = vi
      .spyOn(fs, "cpSync")
      .mockImplementation((from, to, options) => {
        actualCopy(from, to, options);
        writeFixture(String(to), "main_window/assets/app.js", "altered output");
      });
    try {
      expect(() =>
        copyRendererArtifacts(source, path.join(root, "copied"), before)
      ).toThrow("changed during copying");
      expect(fingerprintRendererArtifacts(source)).toEqual(before);
    } finally {
      copy.mockRestore();
    }
  });
});

describe("search quality evaluation", () => {
  it("reports model quality differences without hiding the strict result", () => {
    const row = {
      id: "q",
      lostRelevant: ["a"],
      addedHardNegatives: ["h"],
      incomplete: false,
    };
    const gates = [{ passed: false, regressions: [row] }];
    expect(assessSearchQuality(gates).accepted).toBe(false);
    expect(assessSearchQuality(gates, "current-model")).toMatchObject({
      accepted: true,
      noQualityRegressions: false,
      warnings: [row],
    });
    expect(() => assessSearchQuality(gates, "ignore-all")).toThrow(
      "Unknown quality policy"
    );
  });
  it("still rejects incomplete searches under the current-model policy", () => {
    const row = { id: "q", incomplete: true };
    expect(
      assessSearchQuality(
        [{ passed: false, regressions: [row] }],
        "current-model"
      )
    ).toMatchObject({ accepted: false, failures: [row], warnings: [] });
  });
  it("rejects a per-query recall loss even when macro quality improves", () => {
    const definition = {
      queries: [
        {
          id: "q",
          split: "regression",
          relevantSampleIds: ["a", "b"],
          hardNegativeSampleIds: ["h"],
        },
      ],
    };
    const baseline = {
      split: "regression",
      scope: "production-api-real-images",
      definitionHash: createHash("sha256")
        .update(JSON.stringify(definition))
        .digest("hex"),
      queries: [{ id: "q", results: ["a", "b"], completion: "complete" }],
    };
    const candidate = {
      ...baseline,
      queries: [{ id: "q", results: ["a", "h"], completion: "complete" }],
    };
    const result = checkSearchRegressions(
      definition,
      {
        ...baseline,
        quality: evaluateSearchRun(definition, baseline),
      },
      { ...candidate, quality: evaluateSearchRun(definition, candidate) }
    );
    expect(result.passed).toBe(false);
    expect(result.regressions[0]).toMatchObject({
      lostRelevant: ["b"],
      addedHardNegatives: ["h"],
    });
  });
  it("rejects changed judgments and incomplete quality runs", () => {
    expect(() =>
      checkSearchRegressions(
        { queries: [] },
        { definitionHash: "a" },
        { definitionHash: "b" }
      )
    ).toThrow("definitions differ");
    const definition = {
      queries: [
        {
          id: "q",
          split: "regression",
          relevantSampleIds: ["a"],
          hardNegativeSampleIds: [],
        },
      ],
    };
    const run = {
      split: "regression",
      scope: "production-api-real-images",
      definitionHash: createHash("sha256")
        .update(JSON.stringify(definition))
        .digest("hex"),
      queries: [{ id: "q", results: ["a"], completion: "partial" }],
    };
    const report = { ...run, quality: evaluateSearchRun(definition, run) };
    const baselineRun = {
      ...run,
      queries: [{ id: "q", results: ["a"], completion: "complete" }],
    };
    const baseline = {
      ...baselineRun,
      quality: evaluateSearchRun(definition, baselineRun),
    };
    expect(checkSearchRegressions(definition, baseline, report).passed).toBe(
      false
    );
    expect(() =>
      checkSearchRegressions(definition, baseline, baseline, {
        requireHead: true,
      })
    ).toThrow("frozen HEAD");
    const historical = {
      ...baseline,
      sourceTreeHash: "tree",
      headSnapshot: {
        kind: "git-head",
        commit: "a".repeat(40),
        sourceTreeHash: "tree",
      },
      queries: [{ id: "q", results: ["a"], completion: "legacy" }],
    };
    expect(
      checkSearchRegressions(definition, historical, baseline, {
        requireHead: true,
      }).passed
    ).toBe(true);
    expect(() =>
      checkSearchRegressions(
        definition,
        { ...historical, headSnapshot: null },
        baseline
      )
    ).toThrow("Incomplete HEAD");
  });
  it("keeps missing measurements unknown and reports unjudged coverage", () => {
    expect(measuredDistribution([null, undefined])).toEqual({
      count: 0,
      p50: null,
      p95: null,
      max: null,
    });
    const result = evaluateSearchRun(
      {
        queries: [
          {
            id: "q",
            split: "holdout",
            relevantSampleIds: ["a", "b"],
            unjudgedSampleIds: ["u"],
            hardNegativeSampleIds: ["h"],
          },
        ],
      },
      {
        queries: [
          {
            id: "q",
            scopeSize: 4,
            results: ["u", "a", "h"],
            completion: "partial",
          },
        ],
      }
    );
    expect(result.metrics).toMatchObject({
      recallAt50: 0.5,
      mrr: 1,
      hardNegativeRateAt10: 1,
      judgmentCoverage: 0.75,
      returnedJudgmentCoverage: 2 / 3,
    });
    expect(result.perQuery[0].unjudgedReturned).toEqual(["u"]);
  });
  it("does not turn one returned relevant result into perfect recall or nDCG", () => {
    const result = evaluateSearchRun(
      {
        queries: [
          {
            id: "q",
            split: "holdout",
            relevantSampleIds: ["a", "b"],
            unjudgedSampleIds: [],
            hardNegativeSampleIds: [],
          },
        ],
      },
      { queries: [{ id: "q", scopeSize: 3, results: ["a"] }] }
    );
    expect(result.metrics.recallAt50).toBe(0.5);
    expect(result.metrics.ndcgAt10).toBeLessThan(1);
    expect(result.metrics.emptyFalsePositiveRate).toBeNull();
  });
});
