import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TestRuntime } from "../helpers/test-runtime.ts";

function reportFixture(loaded = 1) {
  const runtime = new TestRuntime("gallery-perf-report");
  const scripts = path.join(runtime.root, "scripts");
  fs.mkdirSync(scripts);
  const script = path.join(scripts, "gallery-perf-report.mjs");
  fs.copyFileSync(path.resolve("scripts/gallery-perf-report.mjs"), script);
  const input = path.join(runtime.root, "snapshot.json");
  const bucket = { count: 1, total: 1, max: 1, samples: [1] };
  fs.writeFileSync(
    input,
    JSON.stringify({
      datasetCount: 1000,
      loaded,
      galleryPerf: {
        firstViewport80Ms: {
          count: 5,
          total: 110,
          max: 100,
          samples: [1, 2, 3, 4, 100],
        },
        scrollStop95Ms: bucket,
        frameIntervalMs: bucket,
      },
    })
  );
  return { runtime, script, input };
}

describe("gallery performance report CLI", () => {
  it("keeps the worst of five samples in nearest-rank P95 and P99", () => {
    const fixture = reportFixture();
    try {
      const result = spawnSync(
        process.execPath,
        [fixture.script, fixture.input],
        {
          encoding: "utf8",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }
      );
      expect(result.status, result.stderr).toBe(0);
      const reports = path.join(fixture.runtime.root, "reports");
      const file = fs
        .readdirSync(reports)
        .find((name) => name.endsWith(".json"));
      expect(file).toBeDefined();
      const report = JSON.parse(
        fs.readFileSync(path.join(reports, file), "utf8")
      );
      expect(report.galleryPerf.firstViewport80Ms).toMatchObject({
        p50: 3,
        p95: 100,
        p99: 100,
      });
    } finally {
      fixture.runtime.cleanup();
    }
  });

  it("rejects an empty gallery without writing a successful report", () => {
    const fixture = reportFixture(0);
    try {
      const result = spawnSync(
        process.execPath,
        [fixture.script, fixture.input],
        {
          encoding: "utf8",
          env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
        }
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("无效样本");
      expect(fs.existsSync(path.join(fixture.runtime.root, "reports"))).toBe(
        false
      );
    } finally {
      fixture.runtime.cleanup();
    }
  });
});
