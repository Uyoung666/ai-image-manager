import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { sha256Bytes } from "./checksums.mjs";
import { createCosStoreFromEnv } from "./cos.mjs";
import { listReleases } from "./github.mjs";
import { prefixForKind } from "./operations.mjs";
import { compareVersions, parseStableVersion } from "./semver.mjs";
import { formatGitHubTransitionReleases, parseReleases } from "./squirrel.mjs";

const REPOSITORY = "Uyoung666/ai-image-manager";
const TARGET_VERSION = "2.2.1";
const CONFIRMATION = `SWITCH COS STABLE TO GITHUB V${TARGET_VERSION}`;
const PACKAGE_PATTERN =
  /^ai-image-manager-(\d+\.\d+\.\d+)-(full|delta)\.nupkg$/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const SHA1_PATTERN = /^[a-f0-9]{40}$/i;
const VERSION_TAG_PATTERN = /^v/i;
const DELTA_FILENAME_PATTERN = /-delta\.nupkg$/i;
const FULL_FILENAME_PATTERN = /-full\.nupkg$/i;
const ACCESS_DENIED_PATTERN = /access denied/i;
const MAX_POINTER_BYTES = 1024 * 1024;

/**
 * The one-time migration is deliberately fail-closed.  This guard is also
 * used by the workflow so a copied command cannot accidentally rewrite a
 * different bucket or version.
 */
export function assertTransitionAuthorization(env = process.env) {
  if (env.COS_TRANSITION_APPROVED !== "1") {
    throw new Error("COS transition requires COS_TRANSITION_APPROVED=1");
  }
  const version = String(env.TRANSITION_VERSION ?? TARGET_VERSION)
    .trim()
    .replace(VERSION_TAG_PATTERN, "");
  parseStableVersion(version, "transition version");
  if (version !== TARGET_VERSION) {
    throw new Error(
      `This one-time transition only supports v${TARGET_VERSION}`
    );
  }
  if (env.TRANSITION_CONFIRMATION !== CONFIRMATION) {
    throw new Error(
      `Type the exact confirmation ${JSON.stringify(CONFIRMATION)} to switch COS`
    );
  }
  const repository = env.GITHUB_REPOSITORY ?? REPOSITORY;
  if (repository !== REPOSITORY) {
    throw new Error(`Unexpected GitHub repository: ${repository}`);
  }
  if (!(env.GH_TOKEN || env.GITHUB_TOKEN)) {
    throw new Error("GH_TOKEN or GITHUB_TOKEN is required for GitHub checks");
  }
  return { repository, version };
}

/**
 * Add the target packages to the verified legacy feed and pin every package
 * to its immutable GitHub release URL.  Existing entries keep their order so
 * old Squirrel clients see the same baseline chain during the transition.
 */
export function buildTransitionFeed(
  currentText,
  targetEntries,
  { targetVersion = TARGET_VERSION, repository = REPOSITORY } = {}
) {
  parseStableVersion(targetVersion, "target version");
  const entries = parseReleases(currentText).map((entry) => ({ ...entry }));
  const byFilename = new Map(entries.map((entry) => [entry.filename, entry]));
  for (const entry of entries) {
    const version = packageVersion(entry.filename);
    if (compareVersions(version, targetVersion) > 0) {
      throw new Error(
        `COS stable feed contains a newer package than v${targetVersion}: ${entry.filename}`
      );
    }
  }

  const seenTargets = new Set();
  for (const target of targetEntries) {
    const version = packageVersion(target.filename);
    if (version !== targetVersion) {
      throw new Error(
        `Transition package must target v${targetVersion}: ${target.filename}`
      );
    }
    if (seenTargets.has(target.filename)) {
      throw new Error(`Duplicate transition package: ${target.filename}`);
    }
    seenTargets.add(target.filename);
    const existing = byFilename.get(target.filename);
    if (existing) {
      if (existing.hash !== target.hash || existing.size !== target.size) {
        throw new Error(
          `Existing COS entry differs from GitHub package: ${target.filename}`
        );
      }
      continue;
    }
    const normalized = {
      hash: target.hash.toLowerCase(),
      filename: target.filename,
      size: target.size,
      isDelta: target.isDelta,
      isFull: target.isFull,
    };
    byFilename.set(normalized.filename, normalized);
    entries.push(normalized);
  }

  const currentFull = entries.find(
    (entry) =>
      entry.isFull &&
      entry.filename.toLowerCase() ===
        `ai-image-manager-${targetVersion}-full.nupkg`
  );
  const currentDelta = entries.find(
    (entry) =>
      entry.isDelta &&
      entry.filename.toLowerCase() ===
        `ai-image-manager-${targetVersion}-delta.nupkg`
  );
  if (!(currentFull && currentDelta)) {
    throw new Error(
      `Transition feed must contain both v${targetVersion} full and delta packages`
    );
  }
  if (currentDelta.size >= currentFull.size) {
    throw new Error("Transition delta must be smaller than its full package");
  }
  const text = formatGitHubTransitionReleases(entries, repository);
  return { entries: parseReleases(text), text };
}

async function fetchBytes(url, { limit = undefined } = {}) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new Error(`GitHub asset URL must use HTTPS: ${url}`);
  }
  const response = await fetch(url, {
    redirect: "follow",
    cache: "no-store",
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!(response.ok && response.url.startsWith("https://"))) {
    throw new Error(
      `GitHub asset download failed (${response.status}): ${url}`
    );
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body ?? []) {
    const data = Buffer.from(chunk);
    size += data.byteLength;
    if (limit !== undefined && size > limit) {
      throw new Error(`GitHub metadata exceeds ${limit} bytes: ${url}`);
    }
    chunks.push(data);
  }
  return Buffer.concat(chunks);
}

async function hashAsset(asset) {
  const bytes = await fetchBytes(asset.browser_download_url);
  return {
    size: bytes.byteLength,
    sha1: createHash("sha1").update(bytes).digest("hex"),
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function assetSha256(asset) {
  const value = String(asset.digest ?? "");
  if (!(value.startsWith("sha256:") && SHA256_PATTERN.test(value.slice(7)))) {
    return null;
  }
  return value.slice(7).toLowerCase();
}

async function readReleaseFeed(release, cache) {
  if (cache.has(release.tag_name)) {
    return cache.get(release.tag_name);
  }
  const asset = release.assets.find((item) => item.name === "RELEASES");
  if (!asset) {
    throw new Error(`GitHub release ${release.tag_name} lacks RELEASES`);
  }
  const bytes = await fetchBytes(asset.browser_download_url, {
    limit: MAX_POINTER_BYTES,
  });
  const entries = parseReleases(bytes.toString("utf8"));
  cache.set(release.tag_name, entries);
  return entries;
}

async function inspectPackage(release, filename, releaseFeedCache) {
  const asset = release.assets.find((item) => item.name === filename);
  if (!asset || asset.state !== "uploaded") {
    throw new Error(
      `GitHub release ${release.tag_name} lacks uploaded asset ${filename}`
    );
  }
  const feedEntry = (await readReleaseFeed(release, releaseFeedCache)).find(
    (entry) => entry.filename === filename
  );
  let digest = assetSha256(asset);
  let hash = feedEntry?.hash;
  let size = feedEntry?.size;
  if (feedEntry && asset.size !== feedEntry.size) {
    throw new Error(`GitHub RELEASES size mismatch: ${filename}`);
  }
  if (!(digest && hash) || size === undefined) {
    const downloaded = await hashAsset(asset);
    digest ??= downloaded.sha256;
    hash ??= downloaded.sha1;
    size ??= downloaded.size;
    if (downloaded.sha256 !== digest || downloaded.size !== asset.size) {
      throw new Error(
        `GitHub asset digest mismatch after download: ${filename}`
      );
    }
  }
  if (!(SHA1_PATTERN.test(hash) && SHA256_PATTERN.test(digest))) {
    throw new Error(`Invalid package digest evidence: ${filename}`);
  }
  if (size !== asset.size) {
    throw new Error(`GitHub asset size mismatch: ${filename}`);
  }
  if (asset.digest && assetSha256(asset) !== digest) {
    throw new Error(`GitHub API digest mismatch: ${filename}`);
  }
  return {
    filename,
    hash: hash.toLowerCase(),
    size,
    sha256: digest,
    release: release.tag_name,
    assetDigest: asset.digest ?? null,
    evidence: feedEntry ? "release-RELEASES" : "downloaded-package",
    isDelta: DELTA_FILENAME_PATTERN.test(filename),
    isFull: FULL_FILENAME_PATTERN.test(filename),
  };
}

async function verifyCurrentEntries(entries, releasesByTag, feedCache) {
  const evidence = [];
  for (const entry of entries) {
    const version = packageVersion(entry.filename);
    const release = releasesByTag.get(`v${version}`);
    if (!release || release.draft) {
      throw new Error(`Published GitHub release is missing: v${version}`);
    }
    const inspected = await inspectPackage(release, entry.filename, feedCache);
    if (inspected.hash !== entry.hash || inspected.size !== entry.size) {
      throw new Error(
        `COS/GitHub package evidence mismatch: ${entry.filename}`
      );
    }
    evidence.push(inspected);
  }
  return evidence;
}

function packageVersion(filename) {
  const match = filename.match(PACKAGE_PATTERN);
  if (!match) {
    throw new Error(`Unsupported Squirrel package name: ${filename}`);
  }
  return match[1];
}

async function writeEvidence(file, evidence) {
  await fsp.mkdir(path.dirname(path.resolve(file)), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function isCosAccessDenied(error) {
  const status =
    error?.statusCode ?? error?.cause?.statusCode ?? error?.cause?.status;
  return (
    status === 403 || ACCESS_DENIED_PATTERN.test(String(error?.message ?? ""))
  );
}

/**
 * Some COS policies allow creating immutable objects and CopyObject but deny
 * a direct PUT over an existing public pointer.  Use the direct path first;
 * on that specific policy response, stage the exact bytes and replace the
 * pointer with a single CopyObject request.  The temporary object is always
 * cleaned up after the copy attempt.
 */
export async function writeTransitionPointer(cos, key, bytes, record) {
  try {
    await cos.putMutableBytes(key, bytes, {
      ...record,
      cacheControl: "no-cache, no-store, must-revalidate",
      contentType: "text/plain; charset=utf-8",
    });
    return { method: "put" };
  } catch (error) {
    if (!isCosAccessDenied(error)) {
      throw error;
    }
    if (
      typeof cos.putFile === "function" &&
      cos.sliceSize <= bytes.byteLength
    ) {
      const temporaryDirectory = await fsp.mkdtemp(
        path.join(process.cwd(), ".cos-transition-")
      );
      const temporaryFile = path.join(temporaryDirectory, "RELEASES");
      try {
        await fsp.writeFile(temporaryFile, bytes);
        await cos.putFile(key, temporaryFile, {
          ...record,
          cacheControl: "no-cache, no-store, must-revalidate",
          contentType: "text/plain; charset=utf-8",
          immutable: false,
        });
        return { method: "multipart" };
      } finally {
        await fsp.rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
    const stagingKey = `${key}.transition-${record.sha256}.tmp`;
    try {
      await cos.putBytes(stagingKey, bytes, {
        ...record,
        cacheControl: "no-cache, no-store, must-revalidate",
        contentType: "text/plain; charset=utf-8",
        immutable: true,
      });
      await cos.copy(stagingKey, key, {
        cacheControl: "no-cache, no-store, must-revalidate",
        contentType: "text/plain; charset=utf-8",
        immutable: false,
      });
      return { method: "copy", stagingKey };
    } finally {
      await cos.delete(stagingKey).catch((cleanupError) => {
        console.error(`COS transition staging cleanup failed: ${cleanupError}`);
      });
    }
  }
}

export async function transition({
  env = process.env,
  store = undefined,
  releases = undefined,
  now = new Date(),
} = {}) {
  const { repository, version } = assertTransitionAuthorization(env);
  const releasePrefix = env.COS_RELEASE_PREFIX ?? "ai-image-manager";
  const stableKey = `${prefixForKind("stable", { releasePrefix })}/RELEASES`;
  const cos =
    store ?? createCosStoreFromEnv(env, { strictReads: true, sliceSize: 1 });
  const currentBytes = Buffer.from(await cos.getBytes(stableKey));
  const currentText = currentBytes.toString("utf8");
  const currentEntries = parseReleases(currentText);
  const currentFeedSha256 = sha256Bytes(currentBytes);

  const allReleases = releases ?? (await listReleases(repository));
  const releasesByTag = new Map(
    allReleases
      .filter((release) => release?.tag_name)
      .map((release) => [release.tag_name, release])
  );
  const target = releasesByTag.get(`v${version}`);
  if (!target || target.draft || target.prerelease) {
    throw new Error(`v${version} must be a published formal GitHub release`);
  }
  const feedCache = new Map();
  const packageEvidence = await verifyCurrentEntries(
    currentEntries,
    releasesByTag,
    feedCache
  );

  const targetNames = [
    `ai-image-manager-${version}-delta.nupkg`,
    `ai-image-manager-${version}-full.nupkg`,
  ];
  const targetEvidence = [];
  for (const filename of targetNames) {
    targetEvidence.push(await inspectPackage(target, filename, feedCache));
  }
  const { text: transitionedText, entries: transitionedEntries } =
    buildTransitionFeed(currentText, targetEvidence, {
      targetVersion: version,
      repository,
    });
  const transitionedBytes = Buffer.from(transitionedText, "utf8");
  const transitionedFeedSha256 = sha256Bytes(transitionedBytes);

  // Detect a concurrent pointer change.  Never overwrite a feed that was
  // changed after the evidence was collected.
  const latestBytes = Buffer.from(await cos.getBytes(stableKey));
  if (sha256Bytes(latestBytes) !== currentFeedSha256) {
    throw new Error("COS stable RELEASES changed while transition was running");
  }

  let status = "idempotent";
  let writeMethod = "none";
  if (!latestBytes.equals(transitionedBytes)) {
    const result = await writeTransitionPointer(
      cos,
      stableKey,
      transitionedBytes,
      { sha256: transitionedFeedSha256, size: transitionedBytes.byteLength }
    );
    writeMethod = result.method;
    status = "switched";
  }
  const readback = Buffer.from(await cos.getBytes(stableKey));
  if (!readback.equals(transitionedBytes)) {
    throw new Error(
      "COS stable RELEASES readback does not match the transition"
    );
  }
  return {
    status,
    repository,
    version,
    key: stableKey,
    currentFeedSha256,
    transitionedFeedSha256,
    writeMethod,
    entries: transitionedEntries,
    packages: [...packageEvidence, ...targetEvidence],
    generatedAt: now.toISOString(),
  };
}

async function main() {
  const evidencePath =
    process.env.TRANSITION_EVIDENCE ?? "cos-transition-evidence.json";
  try {
    const result = await transition();
    await writeEvidence(evidencePath, result);
    console.log(JSON.stringify(result, null, 2));
    console.log(`COS transition ${result.status}: ${result.key}`);
  } catch (error) {
    const failure = {
      status: "failed",
      generatedAt: new Date().toISOString(),
      error: String(error?.stack ?? error),
    };
    await writeEvidence(evidencePath, failure).catch(() => undefined);
    console.error(failure.error);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
