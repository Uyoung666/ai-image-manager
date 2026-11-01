/** @vitest-environment node */
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  latestReports,
  permittedSkip,
  snapshot,
  testsIn,
  validateReports,
  verifyInput,
} from "../../../scripts/release/parallel.mjs";

const identity = { commit: "abc", version: "2.2.6", buildId: "1-1" };
function fixture() {
  const expected = [1, 2, 3, 4].map((n) => ({
    key: String(n),
    file: "example.test.ts",
    title: `test ${n}`,
  }));
  const reports = expected.map((test, i) => ({
    ...identity,
    shard: i + 1,
    status: "passed",
    duration: 10,
    tests: [{ ...test, status: "expected" }],
  }));
  return { expected, reports };
}

describe("parallel release gates", () => {
  it("allows only the existing fixture-dependent skips", () => {
    expect(
      permittedSkip({
        file: "update-upgrade.spec.ts",
        title: "new skipped test",
      })
    ).toBe(false);
    expect(
      permittedSkip({
        file: "packaged-quit-cleanup.spec.ts",
        title: "packaged quit releases the main process and every worker",
      })
    ).toBe(true);
  });
  it("selects the latest matching report per shard across retry attempts", async () => {
    const parent = path.resolve(".test-runtime/release-parallel-unit");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "reports-"));
    try {
      const { expected, reports } = fixture();
      async function save(report, attempt) {
        const dir = path.join(
          root,
          `release-shard-1-${report.shard}-${attempt}`
        );
        await fs.mkdir(dir);
        await fs.writeFile(
          path.join(dir, "shard.json"),
          JSON.stringify(report)
        );
      }
      for (const report of reports) {
        await save(report, 1);
      }
      await save({ ...reports[0], duration: 20 }, 2);
      await save({ ...reports[0], buildId: "other", duration: 30 }, 3);
      const selected = await latestReports(root, identity, "1");
      expect(selected.find((report) => report.shard === 1).duration).toBe(20);
      expect(validateReports(expected, selected, identity).tests).toBe(4);
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
  it("accepts all four shards from a previously successful package attempt", () => {
    const { expected, reports } = fixture();
    expect(validateReports(expected, reports, identity).tests).toBe(4);
  });
  it.each([
    "missing",
    "duplicate",
    "identity",
    "failure",
    "skip",
    "coverage",
  ])("blocks %s reports", (kind) => {
    const { expected, reports } = fixture();
    if (kind === "missing") {
      reports.pop();
    }
    if (kind === "duplicate") {
      reports[1].tests = reports[0].tests;
    }
    if (kind === "identity") {
      reports[0].buildId = "other";
    }
    if (kind === "failure") {
      reports[0].status = "failed";
    }
    if (kind === "skip") {
      reports[0].tests[0].status = "skipped";
    }
    if (kind === "coverage") {
      reports[0].tests = [];
    }
    expect(() => validateReports(expected, reports, identity)).toThrow();
  });
  it("extracts stable project-qualified IDs through nested suites", () => {
    expect(
      testsIn({
        suites: [
          {
            specs: [
              {
                id: "a",
                file: "x.ts",
                title: "t",
                tests: [{ projectName: "chromium" }],
              },
            ],
          },
        ],
      })[0].key
    ).toBe("a:chromium");
  });
  it("rejects modified inputs and mismatched source identities", async () => {
    const parent = path.resolve(".test-runtime/release-parallel-unit");
    await fs.mkdir(parent, { recursive: true });
    const root = await fs.mkdtemp(path.join(parent, "input-"));
    try {
      await fs.writeFile(path.join(root, "bundle.js"), "original");
      await snapshot(root, identity);
      await verifyInput(root, identity);
      await expect(
        verifyInput(root, { ...identity, commit: "different" })
      ).rejects.toThrow("Release input identity mismatch");
      await fs.writeFile(path.join(root, "bundle.js"), "changed");
      await expect(verifyInput(root, identity)).rejects.toThrow(
        "Release input checksum mismatch"
      );
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
