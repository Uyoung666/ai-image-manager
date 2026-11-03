/** @vitest-environment node */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { TestRuntime } from "../helpers/test-runtime";

const { load } = createRequire(import.meta.url)("js-yaml");
const workflow = load(
  fs.readFileSync(".github/workflows/publish.yaml", "utf8")
);
const { jobs } = workflow;

it.skipIf(process.platform !== "win32")(
  "initializes skipped installer scripts before real Squirrel releasification",
  () => {
    const runtime = new TestRuntime("product-packaging-tools");
    try {
      const source = path.resolve("node_modules/electron-winstaller");
      const fixture = path.join(
        runtime.root,
        "node_modules/electron-winstaller"
      );
      const vendor = path.join(fixture, "vendor");
      fs.mkdirSync(vendor, { recursive: true });
      // npm's published package excludes these generated aliases. Model a fresh
      // --ignore-scripts install without touching the workspace's working tools.
      for (const name of fs.readdirSync(path.join(source, "vendor"))) {
        if (["7z.exe", "7z.dll"].includes(name) || name.endsWith(".log")) {
          continue;
        }
        fs.copyFileSync(
          path.join(source, "vendor", name),
          path.join(vendor, name)
        );
      }
      fs.cpSync(path.join(source, "script"), path.join(fixture, "script"), {
        recursive: true,
      });
      fs.copyFileSync(
        path.join(source, "package.json"),
        path.join(fixture, "package.json")
      );
      const installerVersion = JSON.parse(
        fs.readFileSync(path.join(fixture, "package.json"), "utf8")
      ).version;
      fs.writeFileSync(
        path.join(runtime.root, "package.json"),
        JSON.stringify({
          name: "isolated-product-tools",
          version: "1.0.0",
          private: true,
          dependencies: { "electron-winstaller": installerVersion },
        })
      );
      const scratch = path.join(runtime.root, "scratch");
      fs.mkdirSync(scratch);
      const options = {
        cwd: runtime.root,
        windowsHide: true,
        timeout: 60_000,
        encoding: "utf8",
        env: {
          ...process.env,
          TEMP: scratch,
          TMP: scratch,
          SQUIRREL_TEMP: scratch,
          npm_config_cache: path.join(runtime.root, "npm-cache"),
          npm_config_offline: "true",
        },
      };
      const run = (command, args) => {
        const result = spawnSync(command, args, options);
        if (result.error || result.signal) {
          // A timed-out parent does not prove all packaging children have exited.
          runtime.retain();
          console.error(
            `Packaging tools did not exit normally; retained ${runtime.root}`
          );
        }
        return result;
      };
      const assertSuccess = (result) => {
        expect(result.error).toBeUndefined();
        expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      };
      const payload = path.join(runtime.root, "payload");
      fs.mkdirSync(payload);
      fs.writeFileSync(
        path.join(payload, "fixture.txt"),
        "isolated packaging regression"
      );
      const spec = path.join(runtime.root, "fixture.nuspec");
      fs.writeFileSync(
        spec,
        '<?xml version="1.0"?><package><metadata><id>product-tools-fixture</id><version>1.0.0</version><authors>CI validation</authors><description>TEST ONLY</description></metadata><files><file src="**" target="lib\\net45" /></files></package>'
      );
      assertSuccess(
        run(path.join(vendor, "nuget.exe"), [
          "pack",
          spec,
          "-BasePath",
          payload,
          "-OutputDirectory",
          runtime.root,
        ])
      );
      const releasify = (name) =>
        run(path.join(vendor, "Squirrel.exe"), [
          "--releasify",
          path.join(runtime.root, "product-tools-fixture.1.0.0.nupkg"),
          "--releaseDir",
          path.join(runtime.root, name),
          "--no-msi",
        ]);
      const broken = releasify("before");
      expect(broken.error).toBeUndefined();
      expect(broken.status).not.toBe(0);
      expect(`${broken.stdout}\n${broken.stderr}`).toContain(
        "CreateZipFromDirectory"
      );

      const steps = jobs.smoke.steps;
      const install = steps.findIndex(
        (step) => step.run === "npm ci --ignore-scripts"
      );
      const initialize = steps.findIndex(
        (step) => step.name === "Initialize Squirrel packaging tools"
      );
      const smoke = steps.findIndex(
        (step) => step.run === "node scripts/release-pipeline.mjs smoke"
      );
      expect(install).toBeGreaterThan(-1);
      expect(initialize).toBeGreaterThan(install);
      expect(initialize).toBeLessThan(smoke);
      expect(steps[initialize]["continue-on-error"]).not.toBe(true);
      expect(steps[initialize].run).toBe(
        "npm rebuild electron-winstaller --foreground-scripts"
      );
      // Execute the actual workflow command in the fresh, offline dependency tree.
      assertSuccess(
        run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          steps[initialize].run,
        ])
      );
      for (const extension of ["exe", "dll"]) {
        expect(fs.readFileSync(path.join(vendor, `7z.${extension}`))).toEqual(
          fs.readFileSync(path.join(vendor, `7z-${process.arch}.${extension}`))
        );
      }
      assertSuccess(releasify("after"));
      const filename = "product-tools-fixture-1.0.0-full.nupkg";
      const bytes = fs.readFileSync(path.join(runtime.root, "after", filename));
      const sha1 = createHash("sha1").update(bytes).digest("hex").toUpperCase();
      expect(
        fs
          .readFileSync(path.join(runtime.root, "after", "RELEASES"), "utf8")
          .trim()
      ).toBe(`${sha1} ${filename} ${bytes.length}`);
    } finally {
      runtime.cleanup();
    }
  },
  120_000
);

describe("stable release workflow gates", () => {
  it("runs units and build from the same resolved commit in parallel", () => {
    expect([jobs.unit.needs].flat()).toEqual(["preflight"]);
    expect(jobs.package.needs).toEqual(["preflight"]);
    for (const job of [jobs.unit, jobs.package]) {
      expect(
        job.steps.some(
          // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression is intentionally literal.
          (step) => step.with?.ref === "${{ needs.preflight.outputs.commit }}"
        )
      ).toBe(true);
    }
    expect(jobs.unit.steps.some((step) => step.run?.includes("npm test"))).toBe(
      true
    );
  });

  it("does not seal recoverable artifacts before the unit gate succeeds", () => {
    expect(jobs.build.needs).toEqual(["preflight", "package", "unit", "e2e"]);
    for (const name of ["unit", "package", "e2e"]) {
      expect(jobs.build.if).toContain(`needs.${name}.result == 'success'`);
      expect(jobs.build.if).toContain(`needs.${name}.result == 'skipped'`);
    }
    const names = jobs.build.steps.map((step) => step.name);
    expect(names.indexOf("Seal release bundle")).toBeGreaterThan(
      names.indexOf(
        "Gate - complete Electron E2E against the built application"
      )
    );
  });

  it("keeps package gates blocking before exporting inputs", () => {
    const names = jobs.package.steps.map((step) => step.name);
    const stage = names.indexOf("Stage verified release inputs");
    for (const name of [
      "Gate - packaged Japanese locale installation",
      "Gate - real Electron GitHub update download and resume",
      "Verify Squirrel and WiX release payload",
    ]) {
      const index = names.indexOf(name);
      expect(index).toBeGreaterThan(-1);
      expect(index).toBeLessThan(stage);
      expect(jobs.package.steps[index]["continue-on-error"]).not.toBe(true);
    }
  });

  it("runs four independent single-worker shards without rebuilding", () => {
    expect(jobs.e2e.strategy).toEqual({
      "fail-fast": false,
      matrix: { shard: [1, 2, 3, 4] },
    });
    expect(
      jobs.e2e.steps.some((step) => step.run?.includes("parallel.mjs test app"))
    ).toBe(true);
    expect(
      jobs.e2e.steps.some((step) =>
        step.with?.["artifact-ids"]?.includes("viteArtifactId")
      )
    ).toBe(true);
    for (const job of [jobs.e2e, jobs.build]) {
      const downloads = job.steps.filter((step) => step.with?.["artifact-ids"]);
      expect(downloads.length).toBeGreaterThan(0);
      for (const step of downloads) {
        expect(step.with["merge-multiple"]).toBe(true);
      }
    }
    expect(
      jobs.package.steps.find((step) => step.id === "vite").with[
        "include-hidden-files"
      ]
    ).toBe(true);
    expect(jobs.github.if).toContain("!inputs.validate_only");
    for (const trigger of ["workflow_dispatch", "workflow_call"]) {
      expect(workflow.on[trigger].inputs.validate_only.default).toBe(false);
    }
  });

  it("publishes only after all gates and reuses one verified bundle download", () => {
    expect(jobs.github.needs).toEqual(
      expect.arrayContaining(["preflight", "unit", "smoke", "attest"])
    );
    expect(jobs.github.if).toContain("needs.unit.result == 'success'");
    expect(jobs.github.if).toContain(
      "inputs.source_run_id != '' && needs.unit.result == 'skipped'"
    );
    const steps = jobs.github.steps;
    expect(
      steps.filter(
        // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression.
        (step) => step.with?.name === "${{ env.BUNDLE_ARTIFACT_NAME }}"
      )
    ).toHaveLength(1);
    const verify = steps.findIndex(
      (step) => step.name === "Verify immutable bundle and attestation"
    );
    const stage = steps.findIndex((step) => step.run?.includes("github-stage"));
    const publish = steps.findIndex((step) =>
      step.run?.includes("github-finalize")
    );
    expect(verify).toBeGreaterThan(-1);
    expect(stage).toBeGreaterThan(verify);
    expect(publish).toBeGreaterThan(stage);
    expect(steps[publish].if).toBeUndefined();
    expect(jobs.github.permissions.contents).toBe("write");
  });
  it("isolates validation artifacts and marks the source run as nonrecoverable", () => {
    // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub expression.
    expect(workflow.env.VALIDATE_ONLY).toBe("${{ inputs.validate_only }}");
    for (const name of [
      "BUNDLE_ARTIFACT_NAME",
      "IDENTITY_ARTIFACT_NAME",
      "SMOKE_ARTIFACT_NAME",
    ]) {
      expect(workflow.env[name]).toContain(
        "inputs.validate_only && 'validation-"
      );
    }
    const marker = jobs.preflight.steps.find(
      (step) => step.name === "Mark validation-only run"
    );
    expect(marker.if).toBe("inputs.validate_only");
    expect(workflow.concurrency.group).toContain("release-validation-");
  });
});
