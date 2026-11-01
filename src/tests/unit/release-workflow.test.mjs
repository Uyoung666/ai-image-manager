/** @vitest-environment node */
import fs from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const { load } = createRequire(import.meta.url)("js-yaml");
const workflow = load(
  fs.readFileSync(".github/workflows/publish.yaml", "utf8")
);
const { jobs } = workflow;

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
