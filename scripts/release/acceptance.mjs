import { isDeepStrictEqual } from "node:util";

export const RELEASE_GATE_VERSION = 1;
export const UPGRADE_SCENARIOS = [
  "setup-full",
  "setup-delta",
  "msi-full",
  "msi-delta",
  "msi-history-228",
  "msi-history-229",
  "manual",
];

export function requiredUpgradeScenarios(manifest) {
  return manifest.upgradeFixtures
    ? UPGRADE_SCENARIOS
    : ["setup-full", "msi-full"];
}
const digestPrefix = /^sha256:/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const artifactIdPattern = /^[1-9][0-9]*$/;
const buildIdPattern = /^[1-9][0-9]*-[1-9][0-9]*$/;

export function validateInstallerReport(
  report,
  scenario,
  manifest,
  bundleSha256
) {
  const method = scenario.endsWith("-delta") ? "delta" : "full";
  if (
    report?.scenario !== scenario ||
    report.status !== "passed" ||
    report.buildId !== manifest.buildId ||
    report.bundleSha256 !== bundleSha256
  ) {
    throw new Error(`Missing or mismatched installer report: ${scenario}`);
  }
  if (scenario === "manual") {
    if (report.zip !== "passed" || report.disabledMsi !== "passed") {
      throw new Error("Manual ZIP and MSI upgrades are required");
    }
    return;
  }
  if (
    report.product?.first?.standardUser !== true ||
    report.product?.second?.standardUser !== true ||
    report.product.first.targetVersion !== manifest.version ||
    report.product.second.updateMethod !== method
  ) {
    throw new Error(`Missing or mismatched product upgrade: ${scenario}`);
  }
  if (scenario.includes("-history-")) {
    const history = report.product.history;
    const version = scenario.endsWith("228") ? "2.2.8" : "2.2.9";
    if (
      history?.standardUser !== true ||
      history.targetVersion !== version ||
      history.updateMethod !== "full" ||
      history.targetExecutableSha256 !==
        report.product.first.sourceExecutableSha256
    ) {
      throw new Error(`Missing verified MSI installation history: ${scenario}`);
    }
    if (
      manifest.version === "2.2.10" &&
      scenario === "msi-history-228" &&
      history.negativeControl?.status !== "reproduced"
    ) {
      throw new Error("Original MSI incremental failure was not reproduced");
    }
  }
}

export function validateAcceptance(proof, manifest, bundleSha256, artifact) {
  if (
    proof?.schemaVersion !== RELEASE_GATE_VERSION ||
    manifest.releaseGateVersion !== RELEASE_GATE_VERSION ||
    proof.version !== manifest.version ||
    proof.commit !== manifest.commit ||
    proof.toolingCommit !== manifest.toolingCommit ||
    proof.buildId !== manifest.buildId ||
    !buildIdPattern.test(proof.buildId) ||
    proof.runId !== proof.buildId.split("-")[0] ||
    proof.validateOnly !== Boolean(manifest.validateOnly) ||
    proof.bundleSha256 !== bundleSha256 ||
    !sha256Pattern.test(bundleSha256) ||
    proof.testBuildSha256 !== manifest.testBuildSha256 ||
    !sha256Pattern.test(proof.testBuildSha256) ||
    !artifactIdPattern.test(proof.artifactId) ||
    !sha256Pattern.test(proof.artifactDigest) ||
    (artifact &&
      (proof.artifactId !== String(artifact.id) ||
        proof.artifactDigest !== artifact.digest?.replace(digestPrefix, ""))) ||
    !isDeepStrictEqual(proof.baseline, manifest.baseline) ||
    proof.releaseTitle !== manifest.releaseTitle ||
    proof.releaseNotes !== manifest.releaseNotes ||
    proof.unit !== "passed" ||
    !Number.isSafeInteger(proof.e2eTests) ||
    proof.e2eTests <= 0
  ) {
    throw new Error("Release acceptance does not match the verified candidate");
  }
  const scenarios = requiredUpgradeScenarios(manifest);
  if (
    !Array.isArray(proof.installers) ||
    proof.installers.length !== scenarios.length
  ) {
    throw new Error(
      "Release acceptance requires the complete installer matrix"
    );
  }
  for (const scenario of scenarios) {
    validateInstallerReport(
      proof.installers.find((report) => report.scenario === scenario),
      scenario,
      manifest,
      bundleSha256
    );
  }
}
