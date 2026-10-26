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

describe("controlled gallery performance comparisons", () => {
  it("compares the explicit final stop and rejects different operation protocols", () => {
    const runtime = new TestRuntime("gallery-perf-compare");
    const before = path.join(runtime.root, "before.json");
    const after = path.join(runtime.root, "after.json");
    const output = path.join(runtime.root, "comparison");
    const bucket = (value) => ({
      count: 1,
      total: value,
      max: value,
      samples: [value],
    });
    const samples = (first, stop, protocol) => ({
      results: Array.from({ length: 5 }, () => ({
        datasetCount: 10_000,
        loaded: 20,
        bundleHash: String(first),
        viewport: { width: 1280, height: 800, dpr: 2 },
        gridColumnWidth: 140,
        cache: "browser-cold",
        view: "home",
        pattern: "scroll",
        durationSeconds: 5,
        scrollProtocol: protocol,
        scrollPosition: { top: 4000, target: 4000 },
        entryDefinition: "toolbar to decoded viewport",
        runtime: { cpu: "fixture" },
        galleryPerf: {
          entryFirstViewport80Ms: bucket(first),
          scrollStop95Ms: bucket(8000 - first),
          scriptedScrollStop95Ms: bucket(stop),
          frameIntervalMs: bucket(16),
          imageActive: bucket(6),
          imagePrefetchActive: bucket(2),
          galleryResidentPages: bucket(20),
          galleryResidentPhotos: bucket(2000),
          galleryResidentPhotoBytes: bucket(16_000_000),
        },
      })),
    });
    const run = () =>
      spawnSync(
        process.execPath,
        [
          path.resolve("scripts/gallery-perf-compare.mjs"),
          before,
          after,
          output,
          "entryFirstViewport80Ms",
          "density",
          "scriptedScrollStop95Ms",
        ],
        { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } }
      );
    try {
      fs.writeFileSync(
        before,
        JSON.stringify(
          samples(100, 200, "fixed-42-steps-absolute-final-stop-v2")
        )
      );
      fs.writeFileSync(
        after,
        JSON.stringify(
          samples(80, 150, "fixed-42-steps-absolute-final-stop-v2")
        )
      );
      const accepted = run();
      expect(accepted.status, accepted.stderr).toBe(0);
      const result = JSON.parse(fs.readFileSync(`${output}.json`, "utf8"));
      expect(result.optimized.stopP95Ms).toBe(150);
      expect(result.targets).toMatchObject({ first: true, stop: true });
      const missed = samples(80, 150, "fixed-42-steps-absolute-final-stop-v2");
      missed.results[2].scrollPosition.top = 3000;
      fs.writeFileSync(after, JSON.stringify(missed));
      expect(run().stderr).toContain(
        "Final viewport missed its fixed scroll target"
      );

      fs.writeFileSync(
        after,
        JSON.stringify(
          samples(80, 150, "fixed-43-steps-absolute-final-stop-v2")
        )
      );
      const incompatible = run();
      expect(incompatible.status).not.toBe(0);
      expect(incompatible.stderr).toContain(
        "Comparison conditions differ: scrollProtocol"
      );
    } finally {
      runtime.cleanup();
    }
  });
});
