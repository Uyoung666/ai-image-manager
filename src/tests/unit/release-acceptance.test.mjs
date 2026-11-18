import { describe, expect, it } from "vitest";
import {
  CURRENT_MSI_HISTORY,
  requiredUpgradeScenarios,
  UPGRADE_SCENARIOS,
  validateAcceptance,
  validateInstallerReport,
} from "../../../scripts/release/acceptance.mjs";
import { validateSourceRun } from "../../../scripts/release/github.mjs";

const sha = "a".repeat(64);
const bundle = {
  releaseGateVersion: 1,
  version: "2.2.10",
  commit: "a".repeat(40),
  toolingCommit: "b".repeat(40),
  buildId: "123-1",
  testBuildSha256: sha,
  baseline: { version: "2.2.9", releaseId: 123 },
  upgradeFixtures: {},
  releaseTitle: "新版本",
  releaseNotes: "修复 MSI 更新",
};

function acceptance() {
  return {
    ...bundle,
    schemaVersion: 1,
    validateOnly: false,
    runId: "123",
    artifactId: "456",
    artifactDigest: sha,
    bundleSha256: sha,
    unit: "passed",
    e2eTests: 10,
    installers: UPGRADE_SCENARIOS.map((scenario) => ({
      scenario,
      status: "passed",
      buildId: bundle.buildId,
      bundleSha256: sha,
      zip: "passed",
      disabledMsi: "passed",
      product: {
        first: {
          standardUser: true,
          targetVersion: bundle.version,
          sourceExecutableSha256: sha,
        },
        second: {
          standardUser: true,
          updateMethod: scenario.endsWith("-delta") ? "delta" : "full",
        },
        history: {
          standardUser: true,
          targetVersion: scenario.endsWith("228") ? "2.2.8" : "2.2.9",
          updateMethod: "full",
          targetExecutableSha256: sha,
          negativeControl: {
            status: "reproduced",
            profileIsolated: true,
            sourceExecutableSha256: sha,
          },
        },
      },
    })),
  };
}

describe("candidate acceptance", () => {
  it.each([
    ["setup-full", "delta"],
    ["msi-full", "full"],
    [CURRENT_MSI_HISTORY, "delta"],
  ])("requires the package selected for the actual installation type in %s", (scenario, method) => {
    const candidate = {
      ...bundle,
      releaseGateVersion: 2,
      version: "2.2.11",
      baseline: { version: "2.2.10" },
    };
    expect(requiredUpgradeScenarios(candidate)).toContain(CURRENT_MSI_HISTORY);
    const updateManifest = {
      packages: {
        full: { sha256: sha },
        delta: { fromVersion: "2.2.10", sha256: "d".repeat(64) },
      },
    };
    const report = {
      scenario,
      status: "passed",
      buildId: candidate.buildId,
      bundleSha256: sha,
      product: {
        first: {
          standardUser: true,
          sourceVersion: "2.2.10",
          sourceExecutableSha256: sha,
          targetVersion: "2.2.11",
          updateMethod: method,
          downloadedPackageSha256: updateManifest.packages[method].sha256,
        },
        second: {
          standardUser: true,
          sourceVersion: "2.2.11",
          updateMethod: scenario === CURRENT_MSI_HISTORY ? "delta" : "full",
          metadataSource: "asset-fallback",
        },
        ...(scenario === CURRENT_MSI_HISTORY
          ? {
              history: {
                standardUser: true,
                targetVersion: "2.2.10",
                updateMethod: "full",
                targetExecutableSha256: sha,
              },
            }
          : {}),
      },
    };
    const validate = () =>
      validateInstallerReport(report, scenario, candidate, sha, updateManifest);
    expect(validate).not.toThrow();
    const alternative = method === "delta" ? "full" : "delta";
    report.product.first.updateMethod = alternative;
    report.product.first.downloadedPackageSha256 =
      updateManifest.packages[alternative].sha256;
    expect(validate).toThrow("Unexpected update route or package");
    report.product.first.updateMethod = method;
    expect(validate).toThrow("Unexpected update route or package");
    report.product.first.downloadedPackageSha256 =
      updateManifest.packages[method].sha256;
    report.product.second.metadataSource = "api";
    expect(validate).toThrow("Unexpected update route or package");
  });
  it("rejects an MSI negative control that contaminated the candidate profile or executable", () => {
    const proof = acceptance();
    const control = proof.installers.find(
      (item) => item.scenario === "msi-history-228"
    ).product.history.negativeControl;
    control.profileIsolated = false;
    expect(() => validateAcceptance(proof, bundle, sha)).toThrow(
      "incremental failure"
    );
    control.profileIsolated = true;
    control.sourceExecutableSha256 = "c".repeat(64);
    expect(() => validateAcceptance(proof, bundle, sha)).toThrow(
      "incremental failure"
    );
  });

  it("rejects evidence issued for different bytes or a different build", () => {
    const proof = acceptance();
    expect(() =>
      validateAcceptance(proof, bundle, sha, {
        id: 456,
        digest: `sha256:${sha}`,
      })
    ).not.toThrow();
    expect(() =>
      validateAcceptance(proof, bundle, sha, {
        id: 457,
        digest: `sha256:${sha}`,
      })
    ).toThrow("verified candidate");
    proof.installers[0].buildId = "123-2";
    expect(() => validateAcceptance(proof, bundle, sha)).toThrow(
      "installer report"
    );
  });

  it("rejects missing proofs and an incremental test that used full", () => {
    const proof = acceptance();
    const delta = proof.installers.find(
      (item) => item.scenario === "msi-delta"
    );
    delta.product.second.updateMethod = "full";
    expect(() => validateAcceptance(proof, bundle, sha)).toThrow("msi-delta");
    proof.installers.pop();
    expect(() => validateAcceptance(proof, bundle, sha)).toThrow(
      "complete installer matrix"
    );
  });

  it("requires completed acceptance for a recovery source with a sealed candidate", () => {
    const run = {
      path: ".github/workflows/publish.yaml",
      event: "workflow_dispatch",
      status: "completed",
    };
    const names = [
      "Save unverified release bundle",
      "Attest release bundle",
      "Attest candidate acceptance",
      "Save candidate acceptance",
    ];
    const steps = names.map((name) => ({ name, conclusion: "success" }));
    expect(validateSourceRun(run, [{ steps }])).toEqual({
      modern: true,
      candidate: true,
    });
    expect(() =>
      validateSourceRun(run, [{ steps: steps.slice(0, 2) }])
    ).toThrow("Attest candidate acceptance");
    expect(() =>
      validateSourceRun(run, [
        {
          steps: [
            ...steps,
            { name: "Mark validation-only run", conclusion: "success" },
          ],
        },
      ])
    ).toThrow("Validation-only");
  });
});
