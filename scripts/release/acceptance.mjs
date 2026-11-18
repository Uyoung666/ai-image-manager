import { isDeepStrictEqual } from "node:util";
import { compareVersions } from "./semver.mjs";

export const RELEASE_GATE_VERSION = 2;
export const CURRENT_MSI_HISTORY = "msi-history-current";
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
  if (
    manifest.releaseGateVersion === RELEASE_GATE_VERSION &&
    manifest.upgradeFixtures &&
    compareVersions(manifest.baseline.version, "2.2.10") >= 0
  ) {
    return [...UPGRADE_SCENARIOS, CURRENT_MSI_HISTORY];
  }
  return manifest.upgradeFixtures
    ? UPGRADE_SCENARIOS
    : ["setup-full", "msi-full"];
}

export function expectedIncomingMethod(candidate, sourceVersion, hasBaseline) {
  return hasBaseline && candidate.packages.delta?.fromVersion === sourceVersion
    ? "delta"
    : "full";
}

function sourceVersionForScenario(scenario, manifest) {
  switch (scenario) {
    case "setup-delta":
    case "msi-delta":
    case "msi-history-228":
      return "2.2.8";
    case "msi-history-229":
      return "2.2.9";
    default:
      return manifest.baseline.version;
  }
}
const digestPrefix = /^sha256:/;
const sha256Pattern = /^[0-9a-f]{64}$/;
const artifactIdPattern = /^[1-9][0-9]*$/;
const buildIdPattern = /^[1-9][0-9]*-[1-9][0-9]*$/;

export function validateInstallerReport(
  report,
  scenario,
  manifest,
  bundleSha256,
  updateManifest
) {
  const method =
    scenario.endsWith("-delta") || scenario === CURRENT_MSI_HISTORY
      ? "delta"
      : "full";
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
    validateMsiHistory(report.product, scenario, manifest);
  }
  if (manifest.releaseGateVersion === RELEASE_GATE_VERSION) {
    const { first, second } = report.product;
    const source = sourceVersionForScenario(scenario, manifest);
    const expected = expectedIncomingMethod(
      updateManifest,
      source,
      scenario.startsWith("setup-") || Boolean(report.product.history)
    );
    if (
      first.sourceVersion !== source ||
      first.updateMethod !== expected ||
      first.downloadedPackageSha256 !==
        updateManifest.packages[expected].sha256 ||
      second.sourceVersion !== manifest.version ||
      (requiresMetadataFallback(manifest.version) &&
        second.metadataSource !== "asset-fallback")
    ) {
      throw new Error(`Unexpected update route or package: ${scenario}`);
    }
  }
}

function validateMsiHistory({ first, history }, scenario, manifest) {
  const version = sourceVersionForScenario(scenario, manifest);
  if (
    history?.standardUser !== true ||
    history.targetVersion !== version ||
    history.updateMethod !== "full" ||
    history.targetExecutableSha256 !== first.sourceExecutableSha256
  ) {
    throw new Error(`Missing verified MSI installation history: ${scenario}`);
  }
  if (
    manifest.version === "2.2.10" &&
    scenario === "msi-history-228" &&
    (history.negativeControl?.status !== "reproduced" ||
      history.negativeControl.profileIsolated !== true ||
      history.negativeControl.sourceExecutableSha256 !==
        history.targetExecutableSha256)
  ) {
    throw new Error("Original MSI incremental failure was not reproduced");
  }
}

export function requiresMetadataFallback(version) {
  return compareVersions(version, "2.2.11") >= 0;
}

export function formatUpgradeSummary(proof) {
  const rows = [];
  for (const report of proof.installers) {
    if (report.scenario === "manual") {
      rows.push(
        `| ZIP / 停用更新器的 MSI | ${proof.baseline.version} → ${proof.version} | 手动升级 | 启动通过 | 通过 |`
      );
      continue;
    }
    for (const direction of [
      report.product.history,
      report.product.first,
      report.product.second,
    ]) {
      if (!direction) {
        continue;
      }
      const versions = `${direction.sourceVersion} → ${direction.targetVersion}`;
      const method = direction.updateMethod === "delta" ? "增量" : "全量";
      const startup = direction.confirmed ? "通过" : "待确认";
      const restart = direction.secondLaunch === "passed" ? "通过" : "待确认";
      const retained = direction.dataRetained === "passed" ? "通过" : "待确认";
      rows.push(
        `| ${report.scenario} | ${versions} | ${method} | ${startup} / ${restart} | ${retained} |`
      );
    }
  }
  return [
    `## v${proof.version} 候选验收`,
    "",
    `提交 \`${proof.commit}\` · 候选运行 \`${proof.runId}\``,
    "",
    "| 安装场景 | 升级路径 | 实际方式 | 自动启动 / 二次启动 | 数据保留 |",
    "| --- | --- | --- | --- | --- |",
    ...rows,
    "",
    "隔离测试后继版只用于验证后续升级能力。",
    "",
  ].join("\n");
}

export function validateAcceptance(
  proof,
  manifest,
  bundleSha256,
  artifact,
  updateManifest
) {
  if (
    ![1, RELEASE_GATE_VERSION].includes(manifest.releaseGateVersion) ||
    (requiresMetadataFallback(manifest.version) &&
      manifest.releaseGateVersion !== RELEASE_GATE_VERSION) ||
    proof?.schemaVersion !== manifest.releaseGateVersion ||
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
      bundleSha256,
      updateManifest
    );
  }
}
