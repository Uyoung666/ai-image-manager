import { invariant, ReleaseError } from "./errors.mjs";

// Stable release versions deliberately exclude prerelease and build metadata.
// Keeping this stricter than the full SemVer grammar prevents a tag such as
// v2.1.0-rc.1 from becoming the production update channel by accident.
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG_PREFIX_PATTERN = /^refs\/tags\//;
const HASH_PATTERN = /^[a-f0-9]{64}$/;
const DECIMAL_PATTERN = /^\d+$/;

export function parseStableVersion(value, label = "version") {
  invariant(
    typeof value === "string" && STABLE_VERSION_PATTERN.test(value),
    `${label} must be a stable SemVer in MAJOR.MINOR.PATCH form (received ${String(value)})`,
    "INVALID_VERSION"
  );

  const [major, minor, patch] = value.split(".").map((part) => BigInt(part));
  return { value, major, minor, patch };
}

export function isStableVersion(value) {
  return typeof value === "string" && STABLE_VERSION_PATTERN.test(value);
}

export function compareVersions(left, right) {
  const a = parseStableVersion(left, "left version");
  const b = parseStableVersion(right, "right version");
  if (a.major !== b.major) {
    return a.major > b.major ? 1 : -1;
  }
  if (a.minor !== b.minor) {
    return a.minor > b.minor ? 1 : -1;
  }
  if (a.patch !== b.patch) {
    return a.patch > b.patch ? 1 : -1;
  }
  return 0;
}

export function assertTagMatchesVersion(tag, version) {
  parseStableVersion(version);
  const normalizedTag = String(tag ?? "").replace(TAG_PREFIX_PATTERN, "");
  invariant(
    normalizedTag === `v${version}`,
    `tag must be v${version} (received ${String(tag)})`,
    "TAG_VERSION_MISMATCH"
  );
  return normalizedTag;
}

export function readVersionFromPackage(packageJson, label = "package.json") {
  invariant(
    packageJson && typeof packageJson.version === "string",
    `${label} is missing a version field`,
    "PACKAGE_VERSION_MISSING"
  );
  return parseStableVersion(packageJson.version, `${label} version`).value;
}

export function assertPackageLockVersion(packageJson, packageLock) {
  const packageVersion = readVersionFromPackage(packageJson);
  const lockVersion = packageLock?.version;
  const rootVersion = packageLock?.packages?.[""]?.version;

  invariant(
    typeof lockVersion === "string" || typeof rootVersion === "string",
    "package-lock.json is missing both top-level version and packages[''].version",
    "LOCK_VERSION_MISSING"
  );
  if (typeof lockVersion === "string") {
    invariant(
      lockVersion === packageVersion,
      `package-lock.json version ${lockVersion} does not match package.json version ${packageVersion}`,
      "LOCK_VERSION_MISMATCH"
    );
  }
  if (typeof rootVersion === "string") {
    invariant(
      rootVersion === packageVersion,
      `package-lock.json packages[''].version ${rootVersion} does not match package.json version ${packageVersion}`,
      "LOCK_ROOT_VERSION_MISMATCH"
    );
  }
  return packageVersion;
}

export function validateReleaseGuard({
  packageJson,
  packageLock,
  tag,
  latestStableVersion,
  requireLatestStable = false,
  existingObject,
  expectedHash,
  expectedSize,
}) {
  const version = assertPackageLockVersion(packageJson, packageLock);
  assertTagMatchesVersion(tag, version);

  let latest = null;
  if (
    latestStableVersion !== undefined &&
    latestStableVersion !== null &&
    latestStableVersion !== ""
  ) {
    latest = parseStableVersion(
      latestStableVersion,
      "latest stable version"
    ).value;
    invariant(
      compareVersions(version, latest) > 0,
      `version ${version} must be newer than latest stable version ${latest}`,
      "VERSION_NOT_NEWER"
    );
  } else if (requireLatestStable) {
    throw new ReleaseError(
      "latest stable version is required; pass --latest-stable or use --allow-initial for the first release",
      { code: "LATEST_VERSION_MISSING" }
    );
  }

  if (
    existingObject &&
    (expectedHash !== undefined || expectedSize !== undefined)
  ) {
    assertImmutableObject(existingObject, {
      sha256: expectedHash,
      size: expectedSize,
    });
  }

  return {
    version,
    tag: `v${version}`,
    latestStableVersion: latest,
  };
}

/**
 * Check an existing object before an upload.  The only permitted retry is an
 * exact byte-for-byte equivalent object (same SHA-256 and length).
 */
export function assertImmutableObject(existing, expected) {
  if (!existing) {
    return { status: "new" };
  }

  const existingHash = normalizeHash(
    existing.sha256 ??
      existing["x-cos-meta-sha256"] ??
      existing.headers?.["x-cos-meta-sha256"] ??
      headerValue(existing.headers, "x-cos-meta-sha256")
  );
  const expectedHash = normalizeHash(expected?.sha256);
  const existingSize = normalizeSize(
    existing.size ??
      existing.contentLength ??
      existing.ContentLength ??
      existing.headers?.["content-length"] ??
      headerValue(existing.headers, "content-length")
  );
  const expectedSize = normalizeSize(expected?.size);

  invariant(
    expectedHash,
    "an expected SHA-256 is required for immutable object checks",
    "HASH_MISSING"
  );
  invariant(
    existingHash,
    "existing object is missing x-cos-meta-sha256; refusing to overwrite it",
    "OBJECT_HASH_MISSING"
  );
  invariant(
    existingSize !== null,
    "existing object is missing Content-Length; refusing to overwrite it",
    "OBJECT_SIZE_MISSING"
  );
  invariant(
    expectedSize !== null,
    "an expected object size is required for immutable object checks",
    "SIZE_MISSING"
  );

  if (existingHash === expectedHash && existingSize === expectedSize) {
    return { status: "idempotent", sha256: expectedHash, size: expectedSize };
  }

  throw new ReleaseError(
    `immutable object conflict: existing sha256=${existingHash} size=${existingSize}, expected sha256=${expectedHash} size=${expectedSize}`,
    { code: "IMMUTABLE_OBJECT_CONFLICT" }
  );
}

function headerValue(headers, expectedName) {
  if (!headers || typeof headers !== "object") {
    return undefined;
  }
  const lowerName = expectedName.toLowerCase();
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === lowerName
  );
  return entry?.[1];
}

export function normalizeHash(value) {
  if (typeof value !== "string") {
    return null;
  }
  const hash = value.trim().toLowerCase();
  return HASH_PATTERN.test(hash) ? hash : null;
}

export function normalizeSize(value) {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  if (typeof value === "string" && DECIMAL_PATTERN.test(value.trim())) {
    return BigInt(value.trim());
  }
  return null;
}

export { STABLE_VERSION_PATTERN };
