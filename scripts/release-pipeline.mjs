import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertIdentity,
  importLegacyBundle,
  prepareBundle,
  readJson,
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
  withPublicReleaseReads,
} from "./release/deploy.mjs";
import {
  command,
  exactArtifact,
  finalizeGitHub,
  findRelease,
  sourceArtifacts,
  stageGitHub,
} from "./release/github.mjs";
import { startLocalFeed } from "./release/local-feed.mjs";
import {
  assertPackageLockVersion,
  compareVersions,
  parseStableVersion,
} from "./release/semver.mjs";
import { parseReleases } from "./release/squirrel.mjs";
import { supervise } from "./release/supervise.mjs";

const NEWLINE_PATTERN = /[\r\n]/;
const VERSION_PREFIX_PATTERN = /^v/;
const FULL_VERSION_PATTERN = /-(\d+\.\d+\.\d+)-full\.nupkg$/;
const DEFAULT_FEED =
  "https://ai-image-manager-1392398678.cos.ap-hongkong.myqcloud.com/ai-image-manager/updates/win32/x64/stable";
const DEFAULT_BUILD_BASE = DEFAULT_FEED.replace(/stable$/, "build-base");
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
  const sourceRunId = process.env.SOURCE_RUN_ID || null;
  const identity = {
    version,
    tag,
    commit,
    toolingCommit,
    sourceDateEpoch,
    generatedAt: new Date(Number(sourceDateEpoch) * 1000).toISOString(),
    sourceRunId,
  };
  assertIdentity(identity);
  if (sourceRunId) {
    await sourceArtifacts(repo(), sourceRunId);
  }
  const feed = process.env.COS_APP_FEED ?? DEFAULT_FEED;
  const buildBase = process.env.COS_BUILD_BASE_URL ?? DEFAULT_BUILD_BASE;
  const entries = parseReleases(await fetchText(`${feed}/RELEASES`));
  const versions = entries
    .filter((entry) => entry.isFull)
    .map((entry) => entry.filename.match(FULL_VERSION_PATTERN)?.[1]);
  if (versions.some((value) => !value)) {
    throw new Error("Invalid stable package version");
  }
  versions.sort(compareVersions);
  const previousVersion = versions.at(-1);
  if (
    !previousVersion ||
    compareVersions(version, previousVersion) < 0 ||
    (!sourceRunId && version === previousVersion)
  ) {
    throw new Error("Use a newer version, or resume the original source run");
  }
  const existingRelease = await findRelease(repo(), tag);
  if (!sourceRunId && existingRelease) {
    throw new Error(
      "This version already has release assets; resume its source run instead of rebuilding"
    );
  }
  const baseline = sourceRunId
    ? {}
    : await resolveBaseline(previousVersion, buildBase);
  const config = { ...identity, baseline, feed, buildBase };
  await writeJson("release-context.json", config);
  await output({ version, tag, commit, sourceRunId: sourceRunId ?? "" });
  console.log(
    `Preflight passed: ${tag} at ${commit}; source=${sourceRunId ?? "new build"}`
  );
  return config;
}

async function resolveBaseline(previousVersion, buildBase) {
  const baseline = {};
  const previous = await findRelease(repo(), `v${previousVersion}`);
  if (!previous || previous.draft || previous.prerelease) {
    throw new Error("The previous stable GitHub release is missing");
  }
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
    await fetchText(`${buildBase}/RELEASES`)
  );
  if (
    baselineEntries.length !== 1 ||
    baselineEntries[0].filename !==
      `ai-image-manager-${previousVersion}-full.nupkg`
  ) {
    throw new Error("Build-base does not match the previous stable version");
  }
  return baseline;
}

function context() {
  return readJson(process.env.RELEASE_CONTEXT ?? "release-context.json");
}

async function recover(identity) {
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
  let smoke;
  let artifact;
  if (source.modern) {
    artifact = await download(`release-bundle-${identity.version}`, root());
    const smokeDirectory = path.join(recovery, "smoke");
    await download(`release-smoke-${identity.version}`, smokeDirectory);
    const original = await verifyBundle(root(), identity);
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
    schemaVersion: 2,
    sourceRunId: identity.sourceRunId,
    sourceArtifact: artifact,
  });
  await sealBundle(root(), { ...identity, sourceArtifact: artifact });
}

async function smokeTest(identity) {
  const manifest = await verifyBundle(root(), identity);
  let smoke;
  if (
    manifest.files.some((file) => file.relativePath === "recovered-smoke.json")
  ) {
    smoke = await readJson(path.join(root(), "recovered-smoke.json"));
    validateSmoke(smoke, manifest);
    console.log(
      `Reusing verified installer smoke from run ${smoke.sourceRunId}`
    );
  } else {
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
    const script = path.join(
      import.meta.dirname,
      "windows-installer-smoke.mjs"
    );
    const env = {
      ...process.env,
      ...identity.baseline,
      AIM_INSTALLER_LOCAL_FEED: "1",
      AIM_INSTALLER_SMOKE_LOG_DIR: path.join(evidenceRoot(), "installer-logs"),
    };
    try {
      for (const [mode, option, suffix] of [
        ["setup-upgrade", "--setup", "Setup.exe"],
        ["msi-upgrade", "--msi", ".msi"],
      ]) {
        const file = manifest.files.find((record) =>
          record.relativePath.endsWith(suffix)
        );
        await supervise(
          process.execPath,
          [
            script,
            mode,
            option,
            path.join(root(), file.relativePath),
            "--version",
            manifest.version,
            "--feed",
            server.url,
          ],
          { timeoutMs: 8 * 60_000, idleMs: 8 * 60_000, env }
        );
      }
    } finally {
      await server.close();
    }
    smoke = {
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
    schemaVersion: 3,
    bundleSha256: await sha256File(path.join(root(), "bundle.json")),
    runId: process.env.GITHUB_RUN_ID ?? null,
  });
}

export async function runPipeline(operation) {
  if (operation === "preflight") {
    return preflight();
  }
  const identity = await context();
  if (operation === "configure-build") {
    return output(
      {
        ...identity.baseline,
        AIM_UPDATE_BASE_URL: identity.feed,
        AIM_SQUIRREL_REMOTE_RELEASES: identity.buildBase,
        AIM_HAS_STABLE_BASELINE: "1",
        SOURCE_DATE_EPOCH: identity.sourceDateEpoch,
      },
      process.env.GITHUB_ENV
    );
  }
  if (operation === "prepare") {
    return prepareBundle(
      process.env.RELEASE_MAKE ?? "out/make",
      root(),
      identity
    );
  }
  if (operation === "recover") {
    return recover(identity);
  }
  if (operation === "smoke") {
    return smokeTest(identity);
  }
  const manifest = await verifyBundle(root(), identity);
  if (operation === "verify") {
    return manifest;
  }
  const smoke = await readJson(path.join(evidenceRoot(), "smoke-status.json"));
  validateSmoke(
    smoke,
    manifest,
    await sha256File(path.join(root(), "bundle.json"))
  );
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
