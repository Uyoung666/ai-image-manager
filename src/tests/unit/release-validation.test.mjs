/** @vitest-environment node */
import { describe, expect, it } from "vitest";
import { recoveredReleaseIdentity } from "../../../scripts/release/bundle.mjs";
import {
  finalizeCos,
  stageDownloads,
  stageUpdatePackages,
  transitionStableFeedToGitHub,
} from "../../../scripts/release/deploy.mjs";
import {
  finalizeGitHub,
  stageGitHub,
  validateSourceRun,
} from "../../../scripts/release/github.mjs";
import {
  assertBuildAllowed,
  assertPublishable,
  validationOnly,
} from "../../../scripts/release/policy.mjs";

describe("validation-only release isolation", () => {
  it("allows rebuilding a published tag only in explicit validation mode", () => {
    expect(validationOnly({})).toBe(false);
    expect(validationOnly({ VALIDATE_ONLY: "true" })).toBe(true);
    expect(() => validationOnly({ VALIDATE_ONLY: "yes" })).toThrow(
      "VALIDATE_ONLY"
    );
    expect(() =>
      assertBuildAllowed({ validateOnly: false, existingRelease: {} })
    ).toThrow("already has release assets");
    expect(() =>
      assertBuildAllowed({ validateOnly: true, existingRelease: {} })
    ).not.toThrow();
    expect(() =>
      assertBuildAllowed({ validateOnly: true, sourceRunId: "123" })
    ).toThrow("not recover");
    expect(() =>
      assertBuildAllowed({
        validateOnly: false,
        sourceRunId: "123",
        existingRelease: {},
      })
    ).not.toThrow();
  });
  it("keeps older production identities compatible while refusing validation markers", () => {
    expect(() => assertPublishable({})).not.toThrow();
    expect(() => assertPublishable({ validateOnly: false })).not.toThrow();
    for (const validateOnly of [true, "true", "false", null]) {
      expect(() => assertPublishable({ validateOnly })).toThrow(
        "cannot be published or recovered"
      );
    }
    expect(() => recoveredReleaseIdentity({}, { validateOnly: true })).toThrow(
      "cannot be published or recovered"
    );
    expect(() => recoveredReleaseIdentity({ validateOnly: true }, {})).toThrow(
      "cannot be published or recovered"
    );
  });
  it.each([
    ["GitHub staging", stageGitHub],
    ["GitHub publishing", finalizeGitHub],
    ["download staging", stageDownloads],
    ["update staging", stageUpdatePackages],
    ["COS publishing", finalizeCos],
    ["COS transition", transitionStableFeedToGitHub],
  ])("blocks %s before any filesystem or network access", async (_name, operation) => {
    await expect(operation(null, null, { validateOnly: true })).rejects.toThrow(
      "cannot be published or recovered"
    );
  });
  it("rejects validation workflow runs even when their checks all succeeded", () => {
    const run = {
      path: ".github/workflows/publish.yaml",
      event: "workflow_dispatch",
      status: "completed",
    };
    const names = [
      "Save immutable release bundle",
      "Attest release bundle",
      "Save installer smoke evidence",
    ];
    const steps = names.map((name) => ({ name, conclusion: "success" }));
    expect(validateSourceRun(run, [{ steps }])).toEqual({ modern: true });
    steps.push({ name: "Mark validation-only run", conclusion: "success" });
    expect(() => validateSourceRun(run, [{ steps }])).toThrow(
      "cannot be recovery sources"
    );
  });
});
