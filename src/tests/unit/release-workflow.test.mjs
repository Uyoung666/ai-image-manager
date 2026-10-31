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
    expect(jobs.build.needs).toEqual(["preflight"]);
    for (const job of [jobs.unit, jobs.build]) {
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
    const steps = jobs.build.steps;
    const gate = steps.findIndex(
      (step) =>
        step.name ===
        "Require successful unit gate before sealing recoverable artifacts"
    );
    const seal = steps.findIndex((step) => step.name === "Seal release bundle");
    expect(gate).toBeGreaterThan(-1);
    expect(seal).toBeGreaterThan(gate);
    expect(steps[gate].run).toContain(".conclusion -ne 'success'");
    expect(steps[gate].run).toContain("$LASTEXITCODE -ne 0");
    expect(steps[gate].if).toBe("inputs.source_run_id == ''");
  });

  it("checks packaged locale before complete E2E, keeping both blocking gates", () => {
    const names = jobs.build.steps.map((step) => step.name);
    const locale = names.indexOf(
      "Gate - packaged Japanese locale installation"
    );
    const e2e = names.indexOf(
      "Gate - complete Electron E2E against the built application"
    );
    expect(locale).toBeGreaterThan(-1);
    expect(e2e).toBeGreaterThan(locale);
    for (const index of [locale, e2e]) {
      expect(jobs.build.steps[index]["continue-on-error"]).not.toBe(true);
      expect(jobs.build.steps[index].run).toContain("$LASTEXITCODE -ne 0");
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
      steps.filter((step) => step.with?.name?.startsWith("release-bundle-"))
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
});
