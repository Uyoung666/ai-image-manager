import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import {
  CURRENT_MSI_HISTORY,
  formatUpgradeSummary,
  RELEASE_GATE_VERSION,
  requiredUpgradeScenarios,
  UPGRADE_SCENARIOS,
  validateAcceptance,
  validateInstallerReport,
} from "./release/acceptance.mjs";
import {
  assertIdentity,
  importLegacyBundle,
  prepareBundle,
  readJson,
  recoveredReleaseIdentity,
  sealBundle,
  validateSmoke,
  verifyBundle,
  writeJson,
} from "./release/bundle.mjs";
import { parseSha256Sums, sha256File } from "./release/checksums.mjs";
import { cancelCosRequests, createCosStoreFromEnv } from "./release/cos.mjs";
import {
  finalizeCos,
  stageDownloads,
  stageUpdatePackages,
  transitionStableFeedToGitHub,
  withPublicReleaseReads,
} from "./release/deploy.mjs";
import {
  command,
  exactArtifact,
  finalizeGitHub,
  findRelease,
  listReleases,
  loadReleaseNotes,
  loadReleaseTitle,
  selectBaselineRelease,
  sourceArtifacts,
  stageGitHub,
  verifyGitHubTransitionAssets,
} from "./release/github.mjs";
import { startLocalFeed } from "./release/local-feed.mjs";
import { validateLocaleSmoke } from "./release/locale.mjs";
import {
  assertBuildAllowed,
  assertPublicationRequested,
  assertPublishable,
  validationOnly,
} from "./release/policy.mjs";
import {
  assertPackageLockVersion,
  compareVersions,
  parseStableVersion,
} from "./release/semver.mjs";
import { parseReleases } from "./release/squirrel.mjs";
import { supervise } from "./release/supervise.mjs";

const NEWLINE_PATTERN = /[\r\n]/;
const VERSION_PREFIX_PATTERN = /^v/;
const DEFAULT_UPDATE_BASE =
  "https://github.com/Uyoung666/ai-image-manager/releases";
const root = () => path.resolve(process.env.RELEASE_BUNDLE ?? "release-bundle");
const evidenceRoot = () =>
  path.resolve(process.env.RELEASE_EVIDENCE ?? "release-evidence");
const repo = () =>
  process.env.GITHUB_REPOSITORY ?? "Uyoung666/ai-image-manager";

export async function output(values, destination = process.env.GITHUB_OUTPUT) {
  for (const value of Object.values(values)) {
    if (NEWLINE_PATTERN.test(String(value))) {
      throw new Error("Multiline release output is not permitted");
    }
  }
  if (destination) {
    await fsp.appendFile(
      destination,
      Object.entries(values)
        .map(([key, value]) => `${key}=${value}\n`)
        .join("")
    );
  }
}

async function fetchText(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`Release URL must use HTTPS: ${url}`);
  }
  const response = await fetch(url, {
    signal: AbortSignal.timeout(120_000),
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error(`Release endpoint failed (${response.status}): ${url}`);
  }
  return response.text();
}

export async function preflight() {
  const validateOnly = validationOnly();
  const prepareCandidate = process.env.PREPARE_CANDIDATE === "true";
  const publishRelease = process.env.PUBLISH_RELEASE === "true";
  const sourceRunId = process.env.SOURCE_RUN_ID || null;
  assertBuildAllowed({
    validateOnly,
    sourceRunId,
    prepareCandidate,
    publishRelease,
  });
  const version = String(process.env.RELEASE_VERSION ?? "")
    .trim()
    .replace(VERSION_PREFIX_PATTERN, "");
  parseStableVersion(version);
  const tag = `v${version}`;
  const commit = await command("git", ["rev-list", "-n", "1", tag]);
  const sourceDateEpoch = await command("git", [
    "show",
    "-s",
    "--format=%ct",
    commit,
  ]);
  const toolingCommit = await command("git", ["rev-parse", "HEAD"]);
  const packageJson = JSON.parse(
    await command("git", ["show", `${commit}:package.json`])
  );
  const lock = JSON.parse(
    await command("git", ["show", `${commit}:package-lock.json`])
  );
  if (assertPackageLockVersion(packageJson, lock) !== version) {
    throw new Error("Tag, package and lock versions differ");
  }
  const identity = {
    version,
    tag,
    commit,
    toolingCommit,
    sourceDateEpoch,
    generatedAt: new Date(Number(sourceDateEpoch) * 1000).toISOString(),
    sourceRunId,
    validateOnly,
    localeRequired: Boolean(
      (
        await command("git", [
          "ls-tree",
          "--name-only",
          commit,
          "external-plugins/japanese-locale-maintenance.json",
        ])
      ).trim()
    ),
  };
  assertIdentity(identity);
  const source = sourceRunId
    ? await sourceArtifacts(repo(), sourceRunId)
    : null;
  if (source && compareVersions(version, "2.2.11") >= 0 && !source.candidate) {
    throw new Error("Publication requires an accepted candidate run");
  }
  let releaseNotes;
  if (validateOnly) {
    releaseNotes = `仅验证 ${tag} 的构建、测试和安装升级流程，不对外发布。`;
  } else if (!source?.modern) {
    releaseNotes = await loadReleaseNotes(identity);
  }
  const existingRelease = await findRelease(repo(), tag);
  assertBuildAllowed({
    validateOnly,
    sourceRunId,
    existingRelease,
    publishRelease,
  });
  const baseline = await resolveGitHubBaseline(version);
  const updateBaseUrl =
    process.env.GITHUB_UPDATE_BASE_URL ?? DEFAULT_UPDATE_BASE;
  if (identity.localeRequired && releaseNotes !== undefined) {
    releaseNotes += `\n\n日语插件 ${version}（适配软件 ${version}）：[独立下载](https://github.com/${repo()}/releases/download/${tag}/com.aiimagemanager.japanese-locale-${version}.aim-plugin)。下载后在设置 → 插件中导入并选择日本語。`;
  }
  const config = {
    ...identity,
    repository: repo(),
    releaseTitle: loadReleaseTitle(identity),
    releaseNotes,
    baseline,
    updateBaseUrl,
  };
  if (compareVersions(version, "2.2.10") >= 0 && !sourceRunId) {
    const [v226, v228, v229] = await Promise.all([
      resolveGitHubBaseline("2.2.7"),
      resolveGitHubBaseline("2.2.9"),
      baseline.version === "2.2.9" ? baseline : resolveGitHubBaseline("2.2.10"),
    ]);
    if (
      v226.version !== "2.2.6" ||
      v228.version !== "2.2.8" ||
      v229.version !== "2.2.9"
    ) {
      throw new Error("Required historical upgrade fixtures are missing");
    }
    config.upgradeFixtures = { v226, v228, v229 };
  }
  await writeJson("release-context.json", config);
  await output({
    version,
    tag,
    commit,
    baseline: baseline.tag,
    scenarios: JSON.stringify(
      requiredUpgradeScenarios({
        ...config,
        releaseGateVersion: RELEASE_GATE_VERSION,
      })
    ),
    sourceRunId: sourceRunId ?? "",
  });
  console.log(
    `Preflight passed: ${tag} at ${commit}; source=${sourceRunId ?? "new build"}`
  );
  return config;
}

async function resolveGitHubBaseline(version) {
  const releases = await listReleases(repo());
  const allowPrerelease = version === "2.2.1";
  const previous = selectBaselineRelease(releases, version, {
    allowPrerelease,
  });
  if (!previous) {
    throw new Error("The previous verified GitHub release is missing");
  }
  const previousVersion = previous.tag_name.slice(1);
  const releaseBase = `https://github.com/${repo()}/releases/download/${previous.tag_name}`;
  const baseline = {
    version: previousVersion,
    tag: previous.tag_name,
    releaseId: previous.id,
    releaseAssetBaseUrl: releaseBase,
  };
  const checksumAsset = previous.assets.find(
    (asset) => asset.name === "SHA256SUMS.txt"
  );
  if (!checksumAsset) {
    throw new Error("Previous release lacks checksums");
  }
  const sums = parseSha256Sums(
    await fetchText(checksumAsset.browser_download_url)
  );
  for (const [kind, suffix] of [
    ["SETUP", "Setup.exe"],
    ["MSI", ".msi"],
    ["SQUIRREL_FULL", `-${previousVersion}-full.nupkg`],
    ...(compareVersions(version, "2.2.10") >= 0 ? [["ZIP", ".zip"]] : []),
  ]) {
    const matches = previous.assets.filter((asset) =>
      asset.name.endsWith(suffix)
    );
    if (matches.length !== 1) {
      throw new Error(`Previous release lacks an unambiguous ${kind} baseline`);
    }
    const asset = matches[0];
    const digest = sums.find(
      (entry) => entry.relativePath.replaceAll(" ", ".") === asset.name
    )?.sha256;
    if (!digest) {
      throw new Error(`Previous ${kind} checksum is missing`);
    }
    baseline[`AIM_OLD_${kind}_URL`] = asset.browser_download_url;
    baseline[`AIM_OLD_${kind}_SHA256`] = digest;
    if (kind !== "SQUIRREL_FULL") {
      baseline[`AIM_OLD_${kind}_VERSION`] = previousVersion;
    }
  }
  const baselineEntries = parseReleases(
    await fetchText(`${releaseBase}/RELEASES`)
  );
  const baselineFull = baselineEntries.find(
    (entry) =>
      entry.filename === `ai-image-manager-${previousVersion}-full.nupkg`
  );
  if (!baselineFull) {
    throw new Error("Previous GitHub release lacks its Squirrel full package");
  }
  baseline.full = {
    filename: baselineFull.filename,
    size: baselineFull.size,
    sha1: baselineFull.hash,
    sha256: baseline.AIM_OLD_SQUIRREL_FULL_SHA256,
    url: `${releaseBase}/${encodeURIComponent(baselineFull.filename)}`,
  };
  if (previousVersion === "2.2.9") {
    const filename = "ai-image-manager-2.2.9-delta.nupkg";
    const delta = previous.assets.find((asset) => asset.name === filename);
    const sha256 = sums.find(
      (entry) => entry.relativePath === filename
    )?.sha256;
    if (!(delta && sha256)) {
      throw new Error(
        "Missing released 2.2.9 delta required for MSI regression"
      );
    }
    baseline.delta = {
      filename,
      size: delta.size,
      url: delta.browser_download_url,
      sha256,
    };
  }
  return baseline;
}

function context() {
  return readJson(process.env.RELEASE_CONTEXT ?? "release-context.json");
}

async function recover(identity) {
  assertPublishable(identity);
  const source = await sourceArtifacts(repo(), identity.sourceRunId);
  const recovery = path.resolve(
    "out",
    "release-recovery",
    String(identity.sourceRunId)
  );
  const download = async (name, destination) => {
    const artifact = exactArtifact(source.artifacts, name);
    await command(
      "gh",
      [
        "run",
        "download",
        String(identity.sourceRunId),
        "--repo",
        repo(),
        "--name",
        name,
        "--dir",
        destination,
      ],
      { timeoutMs: 20 * 60_000, inherit: true }
    );
    return {
      id: artifact.id,
      digest: artifact.digest ?? null,
      runId: identity.sourceRunId,
    };
  };
  if (source.candidate) {
    return recoverAcceptedCandidate(identity, source, recovery, download);
  }
  let smoke;
  let artifact;
  let sourceIdentity = null;
  let originalManifest;
  let originalBundleSha256;
  if (source.modern) {
    artifact = await download(`release-bundle-${identity.version}`, root());
    const smokeDirectory = path.join(recovery, "smoke");
    await download(`release-smoke-${identity.version}`, smokeDirectory);
    const original = await verifyBundle(root(), identity);
    assertPublishable(original);
    if (original.releaseGateVersion !== undefined) {
      throw new Error(
        "Candidate acceptance cannot be replaced by legacy recovery"
      );
    }
    originalManifest = original;
    originalBundleSha256 = await sha256File(path.join(root(), "bundle.json"));
    const identityArtifactName = `release-artifact-${identity.version}`;
    if (!source.artifacts.some((item) => item.name === identityArtifactName)) {
      throw new Error(
        "Recovery source lacks release artifact identity evidence"
      );
    }
    const identityDirectory = path.join(recovery, "identity");
    await download(identityArtifactName, identityDirectory);
    sourceIdentity = await readJson(
      path.join(identityDirectory, "release-artifact.json")
    );
    if (
      String(sourceIdentity.artifactId) !== String(artifact.id) ||
      (artifact.digest &&
        String(sourceIdentity.digest) !== String(artifact.digest)) ||
      Number(sourceIdentity.runId) !== Number(identity.sourceRunId) ||
      sourceIdentity.commit !== identity.commit ||
      sourceIdentity.toolingCommit !== source.run.head_sha
    ) {
      throw new Error(
        "Recovery source artifact identity does not match its bundle"
      );
    }
    await command(
      "gh",
      [
        "attestation",
        "verify",
        path.join(root(), "bundle.json"),
        "--repo",
        repo(),
        "--signer-workflow",
        `${repo()}/.github/workflows/publish.yaml`,
        "--source-digest",
        source.run.head_sha,
      ],
      { inherit: true }
    );
    smoke = await readJson(path.join(smokeDirectory, "smoke-status.json"));
    validateSmoke(
      smoke,
      original,
      await sha256File(path.join(root(), "bundle.json"))
    );
  } else {
    const candidate = path.join(recovery, "candidate");
    const evidence = path.join(recovery, "evidence");
    artifact = await download(
      `release-candidate-${identity.version}`,
      candidate
    );
    await download(`release-evidence-${identity.version}`, evidence);
    const imported = await importLegacyBundle(
      candidate,
      evidence,
      root(),
      identity
    );
    smoke = imported.smoke;
    for (const record of imported.manifest.files.filter((file) =>
      file.relativePath.startsWith("files/")
    )) {
      await command(
        "gh",
        [
          "attestation",
          "verify",
          path.join(root(), record.relativePath),
          "--repo",
          repo(),
          "--signer-workflow",
          `${repo()}/.github/workflows/publish.yaml`,
          "--source-digest",
          source.run.head_sha,
        ],
        { inherit: true }
      );
    }
  }
  await writeJson(path.join(root(), "recovered-smoke.json"), {
    ...smoke,
    schemaVersion: originalManifest?.productUpdateGateRequired ? 4 : 2,
    sourceRunId: identity.sourceRunId,
    sourceArtifact: artifact,
  });
  const recoveredIdentity =
    source.modern && originalManifest
      ? recoveredReleaseIdentity(identity, originalManifest)
      : identity;
  await sealBundle(root(), {
    ...recoveredIdentity,
    sourceArtifact: artifact,
    ...(originalManifest?.productUpdateGateRequired
      ? {
          productUpdateEvidenceBundleSha256:
            originalManifest.productUpdateEvidenceBundleSha256 ??
            originalBundleSha256,
          recoveredSmokeBundleSha256: originalBundleSha256,
        }
      : {}),
  });
}

async function recoverAcceptedCandidate(identity, source, recovery, download) {
  const proofDirectory = path.join(recovery, "acceptance");
  await download(`release-acceptance-${identity.version}`, proofDirectory);
  const proofFile = path.join(proofDirectory, "candidate-acceptance.json");
  await verifySourceAttestation(proofFile, source.run.head_sha);
  const proof = await readJson(proofFile);
  const name = `release-bundle-${identity.version}-${proof.buildId}`;
  const artifact = await download(name, root());
  const manifestFile = path.join(root(), "bundle.json");
  await verifySourceAttestation(manifestFile, source.run.head_sha);
  const manifest = await verifyBundle(root(), identity);
  assertPublishable(manifest);
  const digest = await sha256File(manifestFile);
  validateAcceptance(
    proof,
    manifest,
    digest,
    artifact,
    await readCandidateUpdateManifest(manifest)
  );
  if (
    proof.runId !== String(identity.sourceRunId) ||
    manifest.toolingCommit !== source.run.head_sha ||
    !isDeepStrictEqual(manifest.baseline, identity.baseline)
  ) {
    throw new Error("Candidate source or previous release has changed");
  }
  const smoke = await readJson(path.join(proofDirectory, "smoke-status.json"));
  validateSmoke(smoke, manifest, digest);
  if (
    proof.smokeSha256 !==
    (await sha256File(path.join(proofDirectory, "smoke-status.json")))
  ) {
    throw new Error("Candidate smoke evidence has changed");
  }
  await writeJson(
    path.join(evidenceRoot(), "candidate-acceptance.json"),
    proof
  );
  await fsp.copyFile(
    path.join(proofDirectory, "smoke-status.json"),
    path.join(evidenceRoot(), "smoke-status.json")
  );
}

async function verifySourceAttestation(file, commit) {
  await command(
    "gh",
    [
      "attestation",
      "verify",
      file,
      "--repo",
      repo(),
      "--signer-workflow",
      `${repo()}/.github/workflows/publish.yaml`,
      "--source-digest",
      commit,
    ],
    { inherit: true }
  );
}

function installerFixture(identity, scenario) {
  if (scenario?.endsWith("-delta")) {
    return {
      baseline: identity.upgradeFixtures.v228,
      successorMethod: "delta",
    };
  }
  if (scenario === CURRENT_MSI_HISTORY) {
    return {
      baseline: identity.upgradeFixtures.v229,
      successorMethod: "delta",
      historicalBaseline: JSON.stringify({
        ...identity.baseline.full,
        version: identity.baseline.version,
      }),
    };
  }
  if (scenario?.includes("-history-")) {
    const { v226, v228, v229 } = identity.upgradeFixtures;
    const { full, version } = scenario.endsWith("228") ? v228 : v229;
    const historicalBaseline = { ...full, version };
    return {
      baseline: v226,
      successorMethod: "full",
      historicalBaseline: JSON.stringify(historicalBaseline),
      ...(version === "2.2.8" && identity.version === "2.2.10"
        ? {
            negativeControl: JSON.stringify({
              ...v229.full,
              version: v229.version,
              delta: v229.delta,
            }),
          }
        : {}),
    };
  }
  return { baseline: identity.baseline, successorMethod: "full" };
}

async function runInstallerValidation(
  identity,
  manifest,
  server,
  kind,
  scenario
) {
  const script = path.join(import.meta.dirname, "windows-installer-smoke.mjs");
  const { baseline, successorMethod, historicalBaseline, negativeControl } =
    installerFixture(identity, scenario);
  const env = {
    ...process.env,
    ...baseline,
    AIM_INSTALLER_LOCAL_FEED: "1",
    RELEASE_COMMIT: identity.commit,
    AIM_PRODUCT_UPDATE_EVIDENCE: path.join(evidenceRoot(), "product-update"),
    AIM_INSTALLER_SMOKE_LOG_DIR: path.join(evidenceRoot(), "installer-logs"),
    AIM_PRODUCT_SUCCESSOR_METHOD: successorMethod,
    AIM_HISTORICAL_BASELINE: historicalBaseline ?? "",
    AIM_MSI_NEGATIVE_CONTROL: negativeControl ?? "",
  };
  const installerKinds = [
    ["setup", "--setup", "Setup.exe"],
    ["msi", "--msi", ".msi"],
  ].filter(([value]) => !kind || kind === value);
  const productModes =
    !scenario || scenario.endsWith("-full") ? [false, true] : [true];
  try {
    for (const product of productModes) {
      const timeout = (product ? 45 : 8) * 60_000;
      for (const [value, option, suffix] of installerKinds) {
        const file = manifest.files.find((record) =>
          record.relativePath.endsWith(suffix)
        );
        await supervise(
          process.execPath,
          [
            script,
            `${value}-upgrade`,
            option,
            path.join(root(), file.relativePath),
            "--version",
            manifest.version,
            "--feed",
            server.url,
          ],
          {
            timeoutMs: timeout,
            idleMs: timeout,
            env: { ...env, AIM_PRODUCT_UPDATE_GATE: product ? "1" : "0" },
          }
        );
      }
    }
  } finally {
    await server.close();
  }
}

async function smokeTest(identity) {
  const manifest = await verifyBundle(root(), identity);
  const scenario = process.env.RELEASE_INSTALLER_SCENARIO;
  if (
    scenario &&
    ![...UPGRADE_SCENARIOS, CURRENT_MSI_HISTORY].includes(scenario)
  ) {
    throw new Error("Invalid installer scenario");
  }
  if (scenario === "manual") {
    const { runManualUpgradeSmoke } = await import(
      "./windows-installer-smoke.mjs"
    );
    await runManualUpgradeSmoke(
      root(),
      manifest,
      identity.baseline,
      path.join(evidenceRoot(), "installer-logs")
    );
    return writeJson(path.join(evidenceRoot(), "installer-report.json"), {
      scenario,
      status: "passed",
      buildId: manifest.buildId,
      bundleSha256: await sha256File(path.join(root(), "bundle.json")),
      zip: "passed",
      disabledMsi: "passed",
    });
  }
  const kind = scenario?.split("-")[0];
  let smoke;
  if (
    manifest.files.some((file) => file.relativePath === "recovered-smoke.json")
  ) {
    smoke = await readJson(path.join(root(), "recovered-smoke.json"));
    validateSmoke(
      smoke,
      manifest,
      smoke.schemaVersion >= 3 ? smoke.bundleSha256 : undefined
    );
    if (
      manifest.productUpdateGateRequired &&
      smoke.bundleSha256 !== manifest.recoveredSmokeBundleSha256
    ) {
      throw new Error(
        "Recovered product evidence changed its source bundle identity"
      );
    }
    console.log(
      `Reusing verified installer smoke from run ${smoke.sourceRunId}`
    );
  } else {
    let localeEvidence = {};
    if (manifest.localeRequired) {
      localeEvidence = await readJson(
        path.join(root(), "evidence/locale-smoke.json")
      );
      validateLocaleSmoke(localeEvidence, manifest);
    }
    const feedDirectory = path.join(evidenceRoot(), "local-feed");
    await fsp.mkdir(feedDirectory, { recursive: true });
    await fsp.copyFile(
      path.join(root(), "feed", "RELEASES"),
      path.join(feedDirectory, "RELEASES")
    );
    for (const record of manifest.files.filter((file) =>
      file.relativePath.endsWith(".nupkg")
    )) {
      await fsp.copyFile(
        path.join(root(), record.relativePath),
        path.join(feedDirectory, path.basename(record.relativePath))
      );
    }
    const server = await startLocalFeed(feedDirectory);
    await runInstallerValidation(identity, manifest, server, kind, scenario);
    if (kind) {
      return writeJson(path.join(evidenceRoot(), "installer-report.json"), {
        kind,
        scenario,
        status: "passed",
        buildId: manifest.buildId,
        bundleSha256: await sha256File(path.join(root(), "bundle.json")),
        product: await readJson(
          path.join(evidenceRoot(), "product-update", `${kind}.json`)
        ),
      });
    }
    const productUpdateEvidence = await Promise.all(
      ["setup", "msi"].map(async (kind) =>
        readJson(path.join(evidenceRoot(), "product-update", `${kind}.json`))
      )
    );
    smoke = {
      ...localeEvidence,
      productUpdate: "passed",
      productUpdateEvidence,
      version: manifest.version,
      tag: manifest.tag,
      commit: manifest.commit,
      setupSmoke: "passed",
      msiSmoke: "passed",
      msiSmokeMode: "upgrade",
      squirrelDeltaSmoke: "passed",
    };
  }
  await writeJson(path.join(evidenceRoot(), "smoke-status.json"), {
    ...smoke,
    schemaVersion: 4,
    bundleSha256: await sha256File(path.join(root(), "bundle.json")),
    runId: process.env.GITHUB_RUN_ID ?? null,
  });
}

async function readCandidateUpdateManifest(manifest) {
  if (manifest.releaseGateVersion !== RELEASE_GATE_VERSION) {
    return undefined;
  }
  const relativePath = "download/update-manifest.json";
  const file = path.join(root(), relativePath);
  const record = manifest.files.find(
    (entry) => entry.relativePath === relativePath
  );
  if (!record || (await sha256File(file)) !== record.sha256) {
    throw new Error("Update manifest does not match the sealed candidate");
  }
  return readJson(file);
}

async function acceptCandidate(identity) {
  const manifestFile = path.join(root(), "bundle.json");
  const manifest = await readJson(manifestFile);
  assertIdentity(manifest, identity);
  const bundleSha256 = await sha256File(manifestFile);
  const updateManifest = await readCandidateUpdateManifest(manifest);
  const input = path.resolve("inputs");
  const summary = await readJson(path.join(input, "e2e-summary.json"));
  if (
    summary.buildId !== manifest.buildId ||
    summary.commit !== manifest.commit ||
    summary.version !== manifest.version ||
    manifest.testBuildSha256 !==
      (await sha256File(path.join(input, ".vite", "release-input.json")))
  ) {
    throw new Error("E2E summary belongs to another candidate");
  }
  const installers = [];
  for (const scenario of requiredUpgradeScenarios(manifest)) {
    const report = await readJson(
      path.join(
        input,
        "installers",
        `release-installer-${scenario}-${manifest.buildId}`,
        "installer-report.json"
      )
    );
    validateInstallerReport(
      report,
      scenario,
      manifest,
      bundleSha256,
      updateManifest
    );
    installers.push(report);
  }
  const localeEvidence = manifest.localeRequired
    ? await readJson(path.join(root(), "evidence", "locale-smoke.json"))
    : {};
  const smoke = {
    ...localeEvidence,
    schemaVersion: 4,
    version: manifest.version,
    tag: manifest.tag,
    commit: manifest.commit,
    runId: process.env.GITHUB_RUN_ID,
    bundleSha256,
    productUpdate: "passed",
    productUpdateEvidence: installers
      .filter(({ scenario }) => scenario.endsWith("-full"))
      .map(({ product }) => product),
    setupSmoke: "passed",
    msiSmoke: "passed",
    msiSmokeMode: "upgrade",
    squirrelDeltaSmoke: "passed",
  };
  validateSmoke(smoke, manifest, bundleSha256);
  for (const report of installers) {
    if (!report.product || report.scenario.endsWith("-full")) {
      continue;
    }
    validateSmoke(
      {
        ...smoke,
        productUpdateEvidence: smoke.productUpdateEvidence.map((entry) =>
          entry.kind === report.kind ? report.product : entry
        ),
      },
      manifest,
      bundleSha256
    );
  }
  const smokeFile = path.join(evidenceRoot(), "smoke-status.json");
  await writeJson(smokeFile, smoke);
  const proof = {
    schemaVersion: RELEASE_GATE_VERSION,
    version: manifest.version,
    commit: manifest.commit,
    toolingCommit: manifest.toolingCommit,
    validateOnly: Boolean(manifest.validateOnly),
    buildId: manifest.buildId,
    runId: process.env.GITHUB_RUN_ID,
    artifactId: process.env.CANDIDATE_ARTIFACT_ID,
    artifactDigest: process.env.CANDIDATE_ARTIFACT_DIGEST,
    bundleSha256,
    testBuildSha256: manifest.testBuildSha256,
    smokeSha256: await sha256File(smokeFile),
    baseline: manifest.baseline,
    releaseTitle: manifest.releaseTitle,
    releaseNotes: manifest.releaseNotes,
    unit: "passed",
    e2eTests: summary.tests,
    installers,
  };
  validateAcceptance(proof, manifest, bundleSha256, undefined, updateManifest);
  await writeJson(
    path.join(evidenceRoot(), "candidate-acceptance.json"),
    proof
  );
  const stepSummary = process.env.GITHUB_STEP_SUMMARY;
  if (stepSummary) {
    await fsp.appendFile(
      stepSummary,
      `${formatUpgradeSummary(proof)}\n[下载候选产物](https://github.com/${repo()}/actions/runs/${proof.runId}/artifacts/${proof.artifactId})\n`
    );
  }
}

async function verifyPublicationEvidence(identity) {
  assertPublishable(identity);
  assertPublicationRequested({
    publishRelease: process.env.PUBLISH_RELEASE === "true",
    sourceRunId: identity.sourceRunId,
  });
  const manifest = await verifyBundle(root(), identity);
  assertPublishable(manifest);
  if (
    compareVersions(manifest.version, "2.2.11") >= 0 &&
    manifest.releaseGateVersion !== RELEASE_GATE_VERSION
  ) {
    throw new Error("Publication requires the current candidate acceptance");
  }
  const smokeFile = path.join(evidenceRoot(), "smoke-status.json");
  const smoke = await readJson(smokeFile);
  const bundleSha256 = await sha256File(path.join(root(), "bundle.json"));
  validateSmoke(smoke, manifest, bundleSha256);
  if (manifest.releaseGateVersion !== undefined) {
    const proof = await readJson(
      path.join(evidenceRoot(), "candidate-acceptance.json")
    );
    validateAcceptance(
      proof,
      manifest,
      bundleSha256,
      undefined,
      await readCandidateUpdateManifest(manifest)
    );
    if (proof.runId !== identity.sourceRunId) {
      throw new Error("Acceptance belongs to a different candidate run");
    }
    if (proof.smokeSha256 !== (await sha256File(smokeFile))) {
      throw new Error("Candidate smoke evidence has changed");
    }
  }
  return manifest;
}

async function runVerification(operation, identity) {
  if (operation === "verify") {
    return verifyBundle(root(), identity);
  }
  if (operation === "smoke") {
    return smokeTest(identity);
  }
  if (operation === "accept") {
    return acceptCandidate(identity);
  }
  await recover(identity);
  if (
    await fsp.stat(path.join(root(), "recovered-smoke.json")).catch(() => null)
  ) {
    await smokeTest(identity);
  }
}

export async function runPipeline(operation) {
  if (operation === "preflight") {
    return preflight();
  }
  const identity = await context();
  if (operation === "configure-build") {
    const baselineEnvironment = Object.fromEntries(
      Object.entries(identity.baseline ?? {}).filter(
        ([, value]) => typeof value !== "object"
      )
    );
    return output(
      {
        ...baselineEnvironment,
        AIM_UPDATE_BASE_URL: identity.updateBaseUrl,
        AIM_SQUIRREL_REMOTE_RELEASES: identity.baseline.releaseAssetBaseUrl,
        AIM_HAS_STABLE_BASELINE: identity.baseline?.full ? "1" : "0",
        SOURCE_DATE_EPOCH: identity.sourceDateEpoch,
      },
      process.env.GITHUB_ENV
    );
  }
  if (operation === "prepare") {
    const buildId = process.env.RELEASE_BUILD_ID;
    return prepareBundle(
      process.env.RELEASE_MAKE ?? "out/make",
      root(),
      buildId
        ? {
            ...identity,
            buildId,
            releaseGateVersion: RELEASE_GATE_VERSION,
            testBuildSha256: await sha256File(
              path.resolve("app/.vite/release-input.json")
            ),
          }
        : identity,
      process.env.RELEASE_LOCALE ?? "dist/plugins"
    );
  }
  if (["recover", "smoke", "accept", "verify"].includes(operation)) {
    return runVerification(operation, identity);
  }
  const manifest = await verifyPublicationEvidence(identity);
  if (operation === "github-stage") {
    return stageGitHub(repo(), root(), manifest);
  }
  if (operation === "github-finalize") {
    return finalizeGitHub(repo(), root(), manifest);
  }
  const store = withPublicReleaseReads(
    createCosStoreFromEnv(process.env, { strictReads: true })
  );
  const prefix = process.env.COS_RELEASE_PREFIX ?? "ai-image-manager";
  if (operation === "cos-downloads") {
    return stageDownloads(store, root(), manifest, prefix);
  }
  if (operation === "cos-updates") {
    return stageUpdatePackages(store, root(), manifest, prefix);
  }
  if (operation === "cos-finalize") {
    return finalizeCos(store, root(), manifest, prefix);
  }
  if (operation === "cos-transition") {
    if (process.env.COS_TRANSITION_APPROVED !== "1") {
      throw new Error(
        "COS transition requires COS_TRANSITION_APPROVED=1 after old-client validation"
      );
    }
    return transitionStableFeedToGitHub(
      store,
      root(),
      manifest,
      prefix,
      repo(),
      () => verifyGitHubTransitionAssets(repo(), root(), manifest)
    );
  }
  throw new Error(`Unknown release pipeline operation: ${operation}`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  process.on("message", (message) => {
    if (message?.type === "release-abort") {
      cancelCosRequests(message.reason);
    }
  });
  // Listening for cancellation must not keep a completed release worker alive.
  process.channel?.unref();
  runPipeline(process.argv[2]).catch((error) => {
    console.error(`Release failed: ${error.stack ?? error}`);
    // Exit after operation-level cleanup, closing any SDK sockets that did not
    // settle. The parent supervisor remains the final process-tree deadline.
    process.exit(1);
  });
}
