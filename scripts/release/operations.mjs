import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import {
  collectFileRecords,
  formatSha256Sums,
  sha1Bytes,
  sha256Bytes,
  verifySha256Sums,
} from "./checksums.mjs";
import {
  IMMUTABLE_CACHE_CONTROL,
  NO_CACHE_CONTROL,
  normalizeKey,
} from "./cos.mjs";
import { invariant, ReleaseError } from "./errors.mjs";
import {
  assertImmutableObject,
  normalizeSize,
  parseStableVersion,
} from "./semver.mjs";
import {
  filterReleaseManifest,
  formatReleases,
  parseReleases,
} from "./squirrel.mjs";

const NUPKG_PATTERN = /\.nupkg$/i;
const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const TRAILING_SLASH_PATTERN = /\/+$/;
const PREFIX_EDGE_PATTERN = /^\/+|\/+$/g;
const URL_TRAILING_SLASH_PATTERN = /\/+$/;

export const RELEASE_PREFIXES = Object.freeze({
  versioned: (version, releasePrefix = "") =>
    joinPrefix(releasePrefix, `downloads/${version}`),
  candidate: (version, releasePrefix = "") =>
    joinPrefix(releasePrefix, `updates/win32/x64/candidates/${version}`),
  testing: (runId, releasePrefix = "") =>
    joinPrefix(
      releasePrefix,
      `updates/win32/x64/testing/runs/${normalizeRunId(runId)}`
    ),
  stable: (releasePrefix = "") =>
    joinPrefix(releasePrefix, "updates/win32/x64/stable"),
  buildBase: (releasePrefix = "") =>
    joinPrefix(releasePrefix, "updates/win32/x64/build-base"),
});

export function normalizeRunId(value) {
  const runId = String(value ?? "").trim();
  invariant(
    runId && RUN_ID_PATTERN.test(runId),
    `invalid testing run id: ${String(value)}`,
    "INVALID_RUN_ID"
  );
  return runId;
}

export function prefixForKind(
  kind,
  { version, runId, releasePrefix = "" } = {}
) {
  if (kind === "versioned" || kind === "downloads") {
    parseStableVersion(version);
    return RELEASE_PREFIXES.versioned(version, releasePrefix);
  }
  if (kind === "candidate" || kind === "candidates") {
    parseStableVersion(version);
    return RELEASE_PREFIXES.candidate(version, releasePrefix);
  }
  if (kind === "testing" || kind === "test") {
    return RELEASE_PREFIXES.testing(runId, releasePrefix);
  }
  if (kind === "stable") {
    return RELEASE_PREFIXES.stable(releasePrefix);
  }
  if (kind === "build-base" || kind === "buildbase") {
    return RELEASE_PREFIXES.buildBase(releasePrefix);
  }
  throw new ReleaseError(`unknown release prefix kind: ${String(kind)}`, {
    code: "INVALID_RELEASE_KIND",
  });
}

/**
 * Prepare deterministic upload records without mutating the artifact folder.
 * RELEASES is normalized (including delta fallback), SHA256SUMS is generated,
 * and a small unsigned provenance record documents the checksum chain.
 */
export async function prepareReleaseArtifacts(
  artifactDirectory,
  {
    version = undefined,
    tag = undefined,
    generatedAt = new Date().toISOString(),
    includeProvenance = true,
  } = {}
) {
  const sourceRecords = await collectFileRecords(artifactDirectory, {
    exclude: new Set(["SHA256SUMS.txt", "provenance.json"]),
  });
  const records = sourceRecords.map((record) => ({
    ...record,
    modified: false,
  }));
  const packageBytes = new Map();
  for (const record of records) {
    if (NUPKG_PATTERN.test(record.relativePath)) {
      packageBytes.set(record.relativePath, record);
      packageBytes.set(path.posix.basename(record.relativePath), record);
    }
  }

  const releasesRecord = records.find(
    (record) => record.relativePath === "RELEASES"
  );
  if (releasesRecord) {
    const releasesData =
      releasesRecord.data ?? (await fsp.readFile(releasesRecord.sourcePath));
    const filtered = filterReleaseManifest(
      releasesData.toString("utf8"),
      packageBytes
    );
    const data = Buffer.from(filtered.text, "utf8");
    Object.assign(releasesRecord, {
      data,
      size: data.byteLength,
      sha256: sha256Bytes(data),
      modified: filtered.text !== releasesData.toString("utf8"),
      droppedDeltas: filtered.droppedDeltas,
    });
  }

  if (includeProvenance) {
    const provenance = {
      schemaVersion: 1,
      version: version ?? null,
      tag: tag ?? (version ? `v${version}` : null),
      authenticode: "not-signed",
      generatedAt,
      files: records
        .filter((record) => record.relativePath !== "RELEASES")
        .map((record) => ({
          path: record.relativePath,
          size: record.size,
          sha256: record.sha256,
        }))
        .sort((left, right) => left.path.localeCompare(right.path, "en")),
      checksumManifest: "SHA256SUMS.txt (self-entry omitted)",
    };
    const data = Buffer.from(
      `${JSON.stringify(provenance, null, 2)}\n`,
      "utf8"
    );
    records.push({
      relativePath: "provenance.json",
      data,
      size: data.byteLength,
      sha256: sha256Bytes(data),
      modified: true,
    });
  }

  const checksumData = Buffer.from(formatSha256Sums(records), "utf8");
  records.push({
    relativePath: "SHA256SUMS.txt",
    data: checksumData,
    size: checksumData.byteLength,
    sha256: sha256Bytes(checksumData),
    modified: true,
  });
  records.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en")
  );
  return {
    artifactDirectory: path.resolve(artifactDirectory),
    records,
    releaseRecord:
      records.find((record) => record.relativePath === "RELEASES") ?? null,
    checksumRecord: records.find(
      (record) => record.relativePath === "SHA256SUMS.txt"
    ),
  };
}

export async function uploadRelease(
  store,
  artifactDirectory,
  {
    prefix,
    version = undefined,
    tag = undefined,
    runId = undefined,
    generatedAt = undefined,
    includeProvenance = true,
    requireReleases = false,
    writeGeneratedFiles = true,
  } = {}
) {
  const resolvedPrefix = resolvePrefix(prefix, { version, runId });
  const prepared = await prepareReleaseArtifacts(artifactDirectory, {
    version,
    tag,
    generatedAt: generatedAt ?? new Date().toISOString(),
    includeProvenance,
  });
  if (writeGeneratedFiles) {
    await writeGeneratedArtifacts(prepared);
  }
  if (requireReleases) {
    invariant(
      prepared.releaseRecord,
      "artifact directory must contain Squirrel RELEASES",
      "RELEASES_MISSING"
    );
  }

  const uploadRecords = [
    ...prepared.records.filter((record) => record.relativePath !== "RELEASES"),
    ...(prepared.releaseRecord ? [prepared.releaseRecord] : []),
  ];
  const uploaded = [];
  for (const record of uploadRecords) {
    const key = `${resolvedPrefix}/${record.relativePath}`;
    const cacheControl =
      record.relativePath === "RELEASES"
        ? NO_CACHE_CONTROL
        : IMMUTABLE_CACHE_CONTROL;
    const result = await uploadRecord(store, key, record, { cacheControl });
    uploaded.push({
      ...result,
      relativePath: record.relativePath,
      sha256: record.sha256,
      size: record.size,
    });
  }
  return {
    ...prepared,
    prefix: resolvedPrefix,
    uploaded,
    droppedDeltas: prepared.releaseRecord?.droppedDeltas ?? [],
  };
}

export async function promoteRelease(
  store,
  version,
  {
    releasePrefix = process.env.COS_RELEASE_PREFIX ?? "",
    candidatePrefix = undefined,
    stablePrefix = undefined,
    buildBasePrefix = undefined,
  } = {}
) {
  parseStableVersion(version);
  const candidate = normalizeKey(
    candidatePrefix ?? RELEASE_PREFIXES.candidate(version, releasePrefix)
  );
  const stable = normalizeKey(
    stablePrefix ?? RELEASE_PREFIXES.stable(releasePrefix)
  );
  const buildBase = normalizeKey(
    buildBasePrefix ?? RELEASE_PREFIXES.buildBase(releasePrefix)
  );
  const candidateReleasesKey = `${candidate}/RELEASES`;
  const stableReleasesKey = `${stable}/RELEASES`;
  const candidateHead = await store.head(candidateReleasesKey);
  invariant(
    candidateHead,
    `candidate RELEASES is missing: ${candidateReleasesKey}`,
    "CANDIDATE_RELEASES_MISSING"
  );

  invariant(
    typeof store.getBytes === "function",
    "promotion requires COS getObject to validate candidate package bytes",
    "STORE_GET_UNSUPPORTED"
  );
  const releasesData = Buffer.from(await store.getBytes(candidateReleasesKey));
  assertImmutableObject(candidateHead, {
    sha256: sha256Bytes(releasesData),
    size: releasesData.byteLength,
  });
  const releasesText = releasesData.toString("utf8");
  const releaseEntries = parseReleases(releasesText);
  const currentFullEntries = releaseEntries.filter(
    (entry) =>
      entry.isFull &&
      entry.filename
        .toLowerCase()
        .endsWith(`-${version}-full.nupkg`.toLowerCase())
  );
  invariant(
    currentFullEntries.length === 1,
    `candidate RELEASES must contain exactly one current full package *-${version}-full.nupkg (found ${currentFullEntries.length})`,
    "CURRENT_FULL_RELEASE_INVALID"
  );
  const fullEntry = currentFullEntries[0];

  // Copy every package referenced by RELEASES before exposing stable/RELEASES.
  // This keeps Squirrel's relative package URLs valid after promotion.
  const actions = [];
  for (const entry of releaseEntries) {
    actions.push(
      await copyVerifiedPackage(
        store,
        `${candidate}/${entry.filename}`,
        `${stable}/${entry.filename}`,
        entry
      )
    );
  }

  // build-base is a real Squirrel directory, not a JSON pointer. It contains
  // the current full package and a one-line RELEASES written last.
  actions.push(
    await copyVerifiedPackage(
      store,
      `${candidate}/${fullEntry.filename}`,
      `${buildBase}/${fullEntry.filename}`,
      fullEntry
    )
  );
  const buildBaseReleases = Buffer.from(formatReleases([fullEntry]), "utf8");
  let buildBaseReleasesResult;
  if (typeof store.putMutableBytes === "function") {
    buildBaseReleasesResult = await store.putMutableBytes(
      `${buildBase}/RELEASES`,
      buildBaseReleases,
      {
        cacheControl: NO_CACHE_CONTROL,
        contentType: "text/plain; charset=utf-8",
      }
    );
  } else {
    buildBaseReleasesResult = await putMutableBytes(
      store,
      `${buildBase}/RELEASES`,
      buildBaseReleases,
      {
        cacheControl: NO_CACHE_CONTROL,
        contentType: "text/plain; charset=utf-8",
      }
    );
  }
  actions.push(buildBaseReleasesResult);
  await assertMutableHead(
    store,
    `${buildBase}/RELEASES`,
    {
      sha256: sha256Bytes(buildBaseReleases),
      size: buildBaseReleases.byteLength,
    },
    "build-base RELEASES"
  );
  // Stable/RELEASES is the final pointer switch.  Every package and the
  // real build-base RELEASES must be present before clients can observe it.
  actions.push(
    await copyObject(store, candidateReleasesKey, stableReleasesKey, {
      cacheControl: NO_CACHE_CONTROL,
      contentType: "text/plain; charset=utf-8",
      sha256: sha256Bytes(releasesData),
      size: releasesData.byteLength,
      immutable: false,
    })
  );
  await assertMutableHead(
    store,
    stableReleasesKey,
    { sha256: sha256Bytes(releasesData), size: releasesData.byteLength },
    "stable RELEASES"
  );
  return {
    version,
    releasePrefix,
    candidatePrefix: candidate,
    stablePrefix: stable,
    buildBasePrefix: buildBase,
    actions,
    releaseEntries,
    buildBaseEntry: fullEntry,
  };
}

export async function verifyRelease(
  store,
  artifactDirectory,
  {
    prefix,
    version = undefined,
    runId = undefined,
    githubBaseUrl = undefined,
    fetchImpl = globalThis.fetch,
    compareBytes = Boolean(githubBaseUrl),
  } = {}
) {
  const resolvedPrefix = resolvePrefix(prefix, { version, runId });
  const records = await collectFileRecords(artifactDirectory);
  const checksumRecord = records.find(
    (record) => record.relativePath === "SHA256SUMS.txt"
  );
  invariant(
    checksumRecord,
    "artifact directory is missing SHA256SUMS.txt",
    "CHECKSUMS_MISSING"
  );
  const checksumData = await fsp.readFile(checksumRecord.sourcePath);
  await verifySha256Sums(checksumData.toString("utf8"), artifactDirectory, {
    strict: true,
  });

  const checked = [];
  for (const record of records) {
    const key = `${resolvedPrefix}/${record.relativePath}`;
    const head = await store.head(key);
    invariant(head, `COS object is missing: ${key}`, "COS_OBJECT_MISSING");
    assertImmutableObject(head, { sha256: record.sha256, size: record.size });
    if (compareBytes) {
      if (typeof store.hashObject === "function") {
        const remote = await store.hashObject(key);
        assertDigest(remote, record, `COS object ${key}`);
      } else if (typeof store.getBytes === "function") {
        const remote = await store.getBytes(key);
        const local = await fsp.readFile(record.sourcePath);
        assertSameBytes(local, remote, `COS object ${key}`);
      } else {
        throw new ReleaseError(
          "byte comparison requires hashObject or getBytes",
          { code: "STORE_GET_UNSUPPORTED" }
        );
      }
    }
    if (githubBaseUrl) {
      invariant(
        typeof fetchImpl === "function",
        "fetch is required for --github-base-url verification",
        "FETCH_UNAVAILABLE"
      );
      const url = `${githubBaseUrl.replace(URL_TRAILING_SLASH_PATTERN, "")}/${record.relativePath.split("/").map(encodeURIComponent).join("/")}`;
      const response = await fetchImpl(url);
      invariant(
        response.ok,
        `GitHub asset request failed (${response.status}): ${url}`,
        "GITHUB_ASSET_MISSING"
      );
      const githubDigest = await digestResponse(response);
      assertDigest(githubDigest, record, `GitHub asset ${record.relativePath}`);
      if (typeof store.hashObject === "function") {
        const remote = await store.hashObject(key);
        invariant(
          remote.size === githubDigest.size &&
            remote.sha256 === githubDigest.sha256,
          `GitHub/COS asset ${record.relativePath} differs`,
          "BYTE_MISMATCH"
        );
      } else if (typeof store.getBytes === "function") {
        const remote = await store.getBytes(key);
        assertDigest(
          { size: remote.byteLength, sha256: sha256Bytes(remote) },
          githubDigest,
          `GitHub/COS asset ${record.relativePath}`
        );
      }
    }
    checked.push({
      key,
      relativePath: record.relativePath,
      sha256: record.sha256,
      size: record.size,
    });
  }
  return { prefix: resolvedPrefix, checked };
}

export function assertSameBytes(left, right, label = "bytes") {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  invariant(
    a.byteLength === b.byteLength,
    `${label} length mismatch: ${a.byteLength} vs ${b.byteLength}`,
    "BYTE_MISMATCH"
  );
  const leftHash = sha256Bytes(a);
  const rightHash = sha256Bytes(b);
  invariant(
    leftHash === rightHash,
    `${label} SHA-256 mismatch: ${leftHash} vs ${rightHash}`,
    "BYTE_MISMATCH"
  );
  return true;
}

function resolvePrefix(prefix, { version, runId } = {}) {
  if (prefix) {
    return normalizeKey(prefix).replace(TRAILING_SLASH_PATTERN, "");
  }
  if (version) {
    return RELEASE_PREFIXES.versioned(version);
  }
  if (runId) {
    return RELEASE_PREFIXES.testing(runId);
  }
  throw new ReleaseError(
    "release prefix is required (use --prefix or --version/--run-id)",
    { code: "RELEASE_PREFIX_MISSING" }
  );
}

async function uploadRecord(store, key, record, { cacheControl }) {
  let result;
  if (
    record.sourcePath &&
    !record.modified &&
    typeof store.putFile === "function"
  ) {
    result = await store.putFile(key, record.sourcePath, {
      sha256: record.sha256,
      size: record.size,
      cacheControl,
      contentType: contentTypeFor(record.relativePath),
    });
  } else if (typeof store.putBytes === "function") {
    const data =
      record.data ??
      (record.sourcePath ? await fsp.readFile(record.sourcePath) : undefined);
    invariant(
      data !== undefined,
      `release record has no bytes: ${record.relativePath}`,
      "RELEASE_BYTES_MISSING"
    );
    result = await store.putBytes(key, data, {
      sha256: record.sha256,
      cacheControl,
      contentType: contentTypeFor(record.relativePath),
    });
  } else {
    throw new ReleaseError("release store must implement putFile or putBytes", {
      code: "STORE_PUT_UNSUPPORTED",
    });
  }
  if (typeof store.head === "function") {
    const head = await store.head(key);
    invariant(
      head,
      `COS object disappeared after upload: ${key}`,
      "COS_OBJECT_MISSING"
    );
    assertImmutableObject(head, { sha256: record.sha256, size: record.size });
  }
  return result ?? { status: "uploaded", key };
}

async function writeGeneratedArtifacts(prepared) {
  for (const record of prepared.records) {
    if (
      !record.modified &&
      record.relativePath !== "SHA256SUMS.txt" &&
      record.relativePath !== "provenance.json"
    ) {
      continue;
    }
    const destination = path.join(
      prepared.artifactDirectory,
      ...record.relativePath.split("/")
    );
    await fsp.mkdir(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`;
    try {
      await fsp.writeFile(temporary, record.data);
      await fsp.rename(temporary, destination);
    } catch (error) {
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
      throw new ReleaseError(
        `failed to materialize generated release file: ${record.relativePath}`,
        {
          code: "RELEASE_MATERIALIZE_FAILED",
          cause: error,
        }
      );
    }
  }
}

async function copyObject(store, source, destination, options) {
  if (typeof store.copy === "function") {
    return store.copy(source, destination, options);
  }
  if (
    typeof store.getBytes === "function" &&
    typeof store.putMutableBytes === "function"
  ) {
    return store.putMutableBytes(
      destination,
      await store.getBytes(source),
      options
    );
  }
  throw new ReleaseError("release store must implement copy for promotion", {
    code: "STORE_COPY_UNSUPPORTED",
  });
}

async function copyVerifiedPackage(store, source, destination, entry) {
  const sourceHead = await store.head(source);
  invariant(
    sourceHead,
    `candidate package is missing: ${source}`,
    "CANDIDATE_PACKAGE_MISSING"
  );
  const sourceSize = objectSize(sourceHead);
  invariant(
    sourceSize !== null,
    `candidate package is missing Content-Length: ${entry.filename}`,
    "PACKAGE_SIZE_MISSING"
  );
  invariant(
    sourceSize === BigInt(entry.size),
    `candidate package size mismatch for ${entry.filename}`,
    "PACKAGE_SIZE_MISMATCH"
  );
  const inspected = await inspectObject(store, source);
  invariant(
    inspected.size === entry.size,
    `candidate package length mismatch for ${entry.filename}`,
    "PACKAGE_SIZE_MISMATCH"
  );
  const actualSha1 = inspected.sha1;
  invariant(
    actualSha1 === entry.hash,
    `candidate package SHA-1 mismatch for ${entry.filename}`,
    "PACKAGE_HASH_MISMATCH"
  );
  const sha256 = inspected.sha256;
  const existing = await store.head(destination);
  if (existing) {
    const idempotent = assertImmutableObject(existing, {
      sha256,
      size: entry.size,
    });
    if (idempotent.status === "idempotent") {
      const destinationDigest = await inspectObject(store, destination);
      invariant(
        destinationDigest.size === entry.size &&
          destinationDigest.sha256 === sha256,
        `existing promoted package bytes differ for ${entry.filename}`,
        "BYTE_MISMATCH"
      );
      return { ...idempotent, key: destination };
    }
  }
  const result = await copyObject(store, source, destination, {
    cacheControl: IMMUTABLE_CACHE_CONTROL,
    contentType: contentTypeFor(entry.filename),
    sha256,
    size: entry.size,
  });
  if (typeof store.head === "function") {
    const destinationHead = await store.head(destination);
    invariant(
      destinationHead,
      `promoted package disappeared: ${destination}`,
      "COS_OBJECT_MISSING"
    );
    assertImmutableObject(destinationHead, { sha256, size: entry.size });
  }
  return result;
}

async function inspectObject(store, key) {
  if (typeof store.hashObject === "function") {
    return store.hashObject(key);
  }
  invariant(
    typeof store.getBytes === "function",
    "promotion requires a stream or getObject implementation to validate candidate packages",
    "STORE_GET_UNSUPPORTED"
  );
  const bytes = Buffer.from(await store.getBytes(key));
  return {
    bytes,
    size: bytes.byteLength,
    sha1: sha1Bytes(bytes),
    sha256: sha256Bytes(bytes),
  };
}

function objectSize(head) {
  const candidates = [
    head?.size,
    head?.ContentLength,
    head?.contentLength,
    head?.headers?.["content-length"],
    head?.headers?.["Content-Length"],
  ];
  for (const value of candidates) {
    const size = normalizeSize(value);
    if (size !== null) {
      return size;
    }
  }
  return null;
}

async function assertMutableHead(store, key, expected, label) {
  if (typeof store.head !== "function") {
    return;
  }
  const head = await store.head(key);
  invariant(
    head,
    `${label} is missing after promotion: ${key}`,
    "COS_OBJECT_MISSING"
  );
  assertImmutableObject(head, expected);
}

function assertDigest(actual, record, label) {
  invariant(
    actual && actual.size === record.size && actual.sha256 === record.sha256,
    `${label} differs: expected ${record.sha256}/${record.size}, got ${actual?.sha256 ?? "missing"}/${actual?.size ?? "missing"}`,
    "BYTE_MISMATCH"
  );
}

async function digestResponse(response) {
  const body = response?.body;
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of body) {
      const data = Buffer.from(chunk);
      size += data.byteLength;
      hash.update(data);
    }
    return { size, sha256: hash.digest("hex") };
  }
  invariant(
    typeof response?.arrayBuffer === "function",
    "fetch response has no readable body",
    "FETCH_BODY_MISSING"
  );
  const bytes = Buffer.from(await response.arrayBuffer());
  return { size: bytes.byteLength, sha256: sha256Bytes(bytes) };
}

function putMutableBytes(store, key, bytes, options) {
  if (typeof store.putBytes === "function") {
    return store.putBytes(key, bytes, { ...options, immutable: false });
  }
  throw new ReleaseError(
    "release store must implement putBytes for pointer promotion",
    { code: "STORE_PUT_UNSUPPORTED" }
  );
}

function contentTypeFor(relativePath) {
  if (relativePath === "RELEASES" || relativePath.endsWith(".txt")) {
    return "text/plain; charset=utf-8";
  }
  if (relativePath.endsWith(".json")) {
    return "application/json; charset=utf-8";
  }
  if (relativePath.endsWith(".nupkg")) {
    return "application/octet-stream";
  }
  return "application/octet-stream";
}

function joinPrefix(prefix, suffix) {
  const left = String(prefix ?? "")
    .trim()
    .replace(PREFIX_EDGE_PATTERN, "");
  return left ? `${left}/${suffix}` : suffix;
}

export { contentTypeFor };
