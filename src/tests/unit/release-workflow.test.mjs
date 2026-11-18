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
  it("checks a real sandboxed renderer before packaging a candidate", () => {
    const check = load(fs.readFileSync(".github/workflows/check.yaml", "utf8"));
    const launcher = check.jobs.check.steps.find(
      (step) => step.name === "Check Windows validation launcher"
    );
    expect(launcher.if).toBe("inputs.commit != ''");
    expect(launcher.run).toContain("npm rebuild electron --foreground-scripts");
    expect(launcher.run).toContain(
      "node scripts/release/test-standard-user-launch.mjs"
    );
    const probe = fs.readFileSync(
      "scripts/release/test-standard-user-launch.mjs",
      "utf8"
    );
    expect(probe).toContain("sandbox: true");
    expect(probe).not.toContain("--no-sandbox");
  });

  it("uses the same resolved commit for the three CI gates", () => {
    expect(jobs.unit.needs).toEqual(["preflight", "quick"]);
    expect(jobs.package.needs).toEqual(["preflight", "quick"]);
    expect(jobs.unit.uses).toBe("./.github/workflows/testing.yaml");
    expect(jobs.quick.uses).toBe("./.github/workflows/check.yaml");
    for (const job of [jobs.unit, jobs.quick]) {
      // biome-ignore lint/suspicious/noTemplateCurlyInString: GitHub Actions expression.
      expect(job.with.commit).toBe("${{ needs.preflight.outputs.commit }}");
    }
  });

  it("validates independently and accepts a bundle only after all gates pass", () => {
    expect(jobs.smoke.needs).toEqual(["preflight", "package"]);
    expect(jobs.e2e.needs).toEqual(["preflight", "package"]);
    expect(jobs.accept.needs).toEqual([
      "preflight",
      "package",
      "unit",
      "e2e",
      "smoke",
      "attest",
    ]);
    expect(jobs.accept.steps.map((step) => step.name)).toEqual(
      expect.arrayContaining([
        "Verify all candidate evidence",
        "Attest candidate acceptance",
        "Save candidate acceptance",
      ])
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

  it("stops the WiX setup step before probing executables if installation fails", () => {
    const step = jobs.package.steps.find(
      (entry) => entry.name === "Install and verify WiX Toolset"
    );
    expect(step.run).toContain(
      'node scripts/setup-wix-toolset.mjs\nif ($LASTEXITCODE -ne 0) { throw "WiX setup failed" }'
    );
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
    for (const job of [jobs.e2e, jobs.accept]) {
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
      expect(workflow.on[trigger].inputs.publish_release.default).toBe(false);
    }
  });

  it("publishes only after all gates and reuses one verified bundle download", () => {
    expect(jobs.github.needs).toBe("preflight");
    expect(jobs.github.if).toContain(
      "inputs.publish_release && inputs.source_run_id != ''"
    );
    expect(jobs.github.if).toContain("needs.preflight.result == 'success'");
    expect(jobs.github.if).toContain("!inputs.prepare_candidate");
    const steps = jobs.github.steps;
    expect(
      steps.filter((step) => step.with?.path === "release-bundle")
    ).toHaveLength(0);
    expect(
      steps.some((step) => step.run?.includes("release-pipeline.mjs recover"))
    ).toBe(true);
    const verify = steps.findIndex(
      (step) => step.name === "Verify and recover original release bundle"
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
    expect(workflow.env.BUNDLE_ARTIFACT_NAME).toContain(
      "inputs.validate_only && 'validation-"
    );
    expect(
      jobs.accept.steps.find((step) => step.id === "evidence").with.name
    ).toContain("inputs.validate_only && 'validation-acceptance'");
    const marker = jobs.preflight.steps.find(
      (step) => step.name === "Mark validation-only run"
    );
    expect(marker.if).toBe("inputs.validate_only");
    expect(workflow.concurrency.group).toContain("release-validation-");
  });
});
