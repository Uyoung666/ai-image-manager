import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const repo = process.cwd();
const fixtureRoot = path.join(repo, "reports/search-optimization/unit-summary");
const summarizer = path.join(repo, "scripts/search-benchmark/summarize.mjs");
const hashes = {
  baseline: "a".repeat(64),
  optimized: "b".repeat(64),
  head: "c".repeat(64),
};
let container: string;
let root: string;
let electronDirectory: string;

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function readJson(file: string) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeMatrix(): void {
  const runs: Array<{
    variant: keyof typeof hashes;
    name: string;
    output: string;
    size: number;
    qualityOnly: boolean;
    exitCode: number;
  }> = [];
  for (const scope of ["development", "holdout", "10000", "50000"]) {
    const variants =
      scope === "development" || scope === "holdout"
        ? (["head", "baseline", "optimized"] as const)
        : (["baseline", "optimized"] as const);
    for (const variant of variants) {
      const synthetic = scope === "10000" || scope === "50000";
      const name = `${variant}-${variant === "head" ? "quality-" : ""}${scope}`;
      const output = path.join(root, name);
      const p95 = variant === "optimized" ? 100 : 200;
      writeJson(path.join(output, "report.json"), {
        sourceTreeHash: hashes[variant],
        scope: synthetic
          ? "synthetic-performance-only"
          : "production-api-real-images",
        definitionHash: "same-definitions",
        queries: [{ id: scope, results: [{ photoId: 1 }] }],
        quality: {
          metrics: {
            ndcgAt10: 1,
            mrr: 1,
            recallAt50: 1,
            hardNegativeRateAt10: 0,
            emptyFalsePositiveRate: 0,
            judgmentCoverage: 1,
          },
          perQuery: [{ emptyFalsePositive: null }],
        },
        peakHostRssBytes: 1024 ** 2,
        performance: {
          cold: { elapsedMs: 200, completion: "complete" },
          scenarios: Object.fromEntries(
            ["warm-new-query", "continuous-switch"].map((scenario) => [
              scenario,
              { p50: p95 / 2, p95, timeoutRatio: 0, partialRatio: 0 },
            ])
          ),
        },
      });
      runs.push({
        variant,
        name,
        output,
        size: synthetic ? Number(scope) : 0,
        qualityOnly: variant === "head",
        exitCode: 0,
      });
    }
  }
  writeJson(path.join(root, "matrix.json"), {
    schemaVersion: 2,
    finishedAt: "2026-10-08T00:00:00Z",
    qualityPassed: true,
    qualityAssessment: { accepted: true, warnings: [] },
    correctnessAssessment: { passed: true },
    runs,
  });
}

function electronReportFile(variant: "baseline" | "optimized"): string {
  return path.join(
    electronDirectory,
    `e2e-${variant}`,
    "semantic-chain-report.json"
  );
}

function writeElectronReports(): void {
  writeJson(path.join(electronDirectory, "build.json"), {
    rendererHash: "same-renderer",
    variants: {
      baseline: { sourceTreeHash: hashes.baseline },
      optimized: { sourceTreeHash: hashes.optimized },
    },
  });
  for (const variant of ["baseline", "optimized"] as const) {
    const firstPaintMs = variant === "baseline" ? 200 : 100;
    writeJson(electronReportFile(variant), {
      applicationSourceHash: `legacy-seven-ts-${variant}`,
      applicationRuntimeSourceHash: hashes[variant],
      fixtureRuntimeSourceHash: hashes.optimized,
      peakAppWorkingSetKB: 1024,
      coldStart: [],
      scenarios: Object.fromEntries(
        ["warm-new-query", "continuous-switch"].map((scenario) => [
          scenario,
          [0, 1].map(() => ({
            completion: "complete",
            timings: {
              ipcMs: firstPaintMs / 2,
              firstPaintMs,
              textEncodingMs: 10,
              serviceMs: firstPaintMs / 3,
            },
          })),
        ])
      ),
    });
  }
}

function executeSummary(withElectron = false) {
  return spawnSync(
    process.execPath,
    [summarizer, root, ...(withElectron ? [electronDirectory] : [])],
    {
      cwd: repo,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
      maxBuffer: 1024 ** 2,
    }
  );
}

beforeEach(() => {
  fs.mkdirSync(fixtureRoot, { recursive: true });
  container = fs.mkdtempSync(path.join(fixtureRoot, "summary-"));
  root = path.join(container, "matrix");
  electronDirectory = path.join(root, "electron-comparison");
  writeMatrix();
});

afterEach(async () => {
  if (container && path.dirname(path.resolve(container)) === fixtureRoot) {
    await fs.promises.rm(container, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

describe("search benchmark summary provenance and acceptance", () => {
  it("keeps missing Electron measurements explicitly pending", () => {
    expect(executeSummary().status).toBe(0);
    const summary = readJson(path.join(root, "summary.json"));
    expect(summary.electron).toBeNull();
    expect(summary.acceptance.electronFirstPaintHotP95Target).toBeNull();
    const report = fs.readFileSync(path.join(root, "summary.md"), "utf8");
    expect(report).toContain("尚未合并真实 Electron 链路结果");
    expect(report).not.toContain("electron.directory 所指目录");
    expect(report).toContain("本矩阵的固定查询结果见上表");
  });
  it("describes a follow-up comparator without calling it a reconstructed historical version", () => {
    const matrix = readJson(path.join(root, "matrix.json"));
    matrix.comparison =
      "Previous verified optimized code versus exact predicate compression";
    matrix.comparisonDescription =
      "Follow-up reuses the recorded predecessor samples and changes only the predicate expression.";
    writeJson(path.join(root, "matrix.json"), matrix);
    expect(executeSummary().status).toBe(0);
    expect(readJson(path.join(root, "summary.json")).comparison).toBe(
      matrix.comparison
    );
    expect(fs.readFileSync(path.join(root, "summary.md"), "utf8")).toContain(
      matrix.comparisonDescription
    );
  });
  it("only imports validation and cleanup records inside this matrix", () => {
    writeJson(path.join(container, "validation.json"), {
      checks: [{ command: "old-tests", exitCode: 0, result: "1722 passed" }],
    });
    writeJson(path.join(container, "cleanup.json"), {
      removed: ["old-output"],
      removedBytes: 100,
    });
    expect(executeSummary().status).toBe(0);
    const old = readJson(path.join(root, "summary.json"));
    expect(old.validation).toBeNull();
    expect(old.cleanup).toBeNull();

    const validation = {
      checks: [{ command: "current-tests", exitCode: 0, result: "passed" }],
    };
    const cleanup = { removed: [], removedBytes: 0 };
    writeJson(path.join(root, "validation.json"), validation);
    writeJson(path.join(root, "cleanup.json"), cleanup);
    expect(executeSummary().status).toBe(0);
    const current = readJson(path.join(root, "summary.json"));
    expect(current.validation).toEqual(validation);
    expect(current.cleanup).toEqual(cleanup);
  });

  it("checks and preserves complete runtime hashes for both applications", () => {
    writeElectronReports();
    expect(executeSummary(true).status).toBe(0);
    const summary = readJson(path.join(root, "summary.json"));
    for (const variant of ["baseline", "optimized"] as const) {
      expect(summary.electron.variants[variant]).toMatchObject({
        applicationSourceHash: `legacy-seven-ts-${variant}`,
        applicationRuntimeSourceHash: hashes[variant],
        fixtureRuntimeSourceHash: hashes.optimized,
      });
    }
    expect(summary.acceptance.electronFirstPaintHotP95Target).toBe(true);
    expect(summary.acceptance.electronFirstPaintSwitchingP95Target).toBe(true);
  });

  it.each([
    "application",
    "fixture",
    "build",
    "legacy",
  ])("rejects an unrelated or missing %s runtime fingerprint", (field) => {
    writeElectronReports();
    if (field === "build") {
      const file = path.join(electronDirectory, "build.json");
      const build = readJson(file);
      build.variants.optimized.sourceTreeHash = hashes.baseline;
      writeJson(file, build);
    } else {
      const file = electronReportFile("optimized");
      const report = readJson(file);
      if (field === "application") {
        report.applicationRuntimeSourceHash = hashes.baseline;
      } else if (field === "fixture") {
        report.fixtureRuntimeSourceHash = hashes.head;
      } else {
        report.applicationRuntimeSourceHash = undefined;
        report.fixtureRuntimeSourceHash = undefined;
      }
      writeJson(file, report);
    }
    const result = executeSummary(true);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Electron runtime source does not match");
  });

  it.each([
    ["optimized", "partial", "semantic-unavailable"],
    ["optimized", "complete", "deadline"],
    ["baseline", "cancelled", "cancelled"],
    ["baseline", "legacy", undefined],
  ] as const)("does not accept faster first paint with %s %s results", (variant, completion, incompleteReason) => {
    writeElectronReports();
    const file = electronReportFile(variant);
    const report = readJson(file);
    Object.assign(report.scenarios["warm-new-query"][0], {
      completion,
      incompleteReason,
    });
    writeJson(file, report);
    expect(executeSummary(true).status).toBe(0);
    const summary = readJson(path.join(root, "summary.json"));
    expect(summary.acceptance.electronFirstPaintHotP95Target).toBe(false);
    expect(summary.acceptance.electronFirstPaintSwitchingP95Target).toBe(true);
  });
});
