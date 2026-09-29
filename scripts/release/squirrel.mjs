import { sha1Bytes } from "./checksums.mjs";
import { invariant, ReleaseError } from "./errors.mjs";

const HASH_PATTERN = /^[a-f0-9]{40}$/i;
const LINE_SPLIT_PATTERN = /\r?\n/;
const FIELD_SPLIT_PATTERN = /\s+/;
const FILENAME_PATTERN = /^[^\\/\0]+\.nupkg$/i;
const SIZE_PATTERN = /^\d+$/;
const DELTA_PATTERN = /-delta\.nupkg$/i;
const FULL_PATTERN = /-full\.nupkg$/i;
const DELTA_SUFFIX_PATTERN = /-delta\.nupkg$/i;
const PACKAGE_VERSION_PATTERN = /-(\d+\.\d+\.\d+)-(?:full|delta)\.nupkg$/i;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/** Parse the three-column Squirrel.Windows RELEASES format. */
export function parseReleases(text) {
  const entries = [];
  const seen = new Set();
  const lines = String(text ?? "").split(LINE_SPLIT_PATTERN);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trim();
    if (!raw || raw.startsWith("#")) {
      continue;
    }
    const parts = raw.split(FIELD_SPLIT_PATTERN);
    if (parts.length !== 3) {
      throw new ReleaseError(
        `invalid Squirrel RELEASES line ${index + 1}: expected hash, filename and size`,
        {
          code: "INVALID_RELEASES",
        }
      );
    }
    const [hash, packageReference, sizeText] = parts;
    const { filename, url } = parsePackageReference(
      packageReference,
      index + 1
    );
    invariant(
      HASH_PATTERN.test(hash),
      `invalid Squirrel hash on line ${index + 1}`,
      "INVALID_RELEASES"
    );
    invariant(
      FILENAME_PATTERN.test(filename),
      `invalid Squirrel package filename on line ${index + 1}: ${packageReference}`,
      "INVALID_RELEASES"
    );
    invariant(
      isDeltaFilename(filename) || isFullFilename(filename),
      `Squirrel package must be a -full.nupkg or -delta.nupkg: ${filename}`,
      "INVALID_RELEASES"
    );
    invariant(
      SIZE_PATTERN.test(sizeText),
      `invalid Squirrel package size on line ${index + 1}`,
      "INVALID_RELEASES"
    );
    const size = Number(sizeText);
    invariant(
      Number.isSafeInteger(size),
      `Squirrel package size is too large on line ${index + 1}`,
      "INVALID_RELEASES"
    );
    invariant(
      !seen.has(filename),
      `duplicate Squirrel package in RELEASES: ${filename}`,
      "DUPLICATE_RELEASE_ENTRY"
    );
    seen.add(filename);
    entries.push({
      hash: hash.toLowerCase(),
      filename,
      size,
      isDelta: isDeltaFilename(filename),
      isFull: isFullFilename(filename),
      ...(url ? { url } : {}),
    });
  }
  invariant(entries.length > 0, "Squirrel RELEASES is empty", "EMPTY_RELEASES");
  return entries;
}

export function formatReleases(entries) {
  return `${entries
    .map(
      (entry) => `${entry.hash} ${entry.url ?? entry.filename} ${entry.size}`
    )
    .join("\n")}\n`;
}

/**
 * Build the compatibility manifest consumed through update.electronjs.org.
 *
 * That service rewrites only the first .nupkg token to an absolute GitHub
 * asset URL. A feed containing the historical baseline first therefore points
 * old clients at a non-existent package. The compatibility feed intentionally
 * exposes only the current full package; new clients use update-manifest.json
 * for the verified delta chain.
 */
export function formatGitHubReleases(entries, version) {
  const suffix = `-${String(version ?? "").trim()}-full.nupkg`.toLowerCase();
  const currentFull = entries.filter(
    (entry) => entry.isFull && entry.filename.toLowerCase().endsWith(suffix)
  );
  invariant(
    currentFull.length === 1,
    `GitHub compatibility RELEASES must contain exactly one current full package for v${version} (found ${currentFull.length})`,
    "GITHUB_RELEASE_INVALID"
  );
  return formatReleases(currentFull.map(({ url: _url, ...entry }) => entry));
}

/**
 * Rewrite an existing Squirrel feed for the old-client transition period.
 * Every package keeps its verified hash and size while its immutable download
 * address points at the matching formal GitHub Release asset.
 */
export function formatGitHubTransitionReleases(
  entries,
  repository = "Uyoung666/ai-image-manager"
) {
  invariant(
    REPOSITORY_PATTERN.test(repository),
    `invalid GitHub repository: ${repository}`,
    "INVALID_GITHUB_REPOSITORY"
  );
  return formatReleases(
    entries.map((entry) => {
      const version = entry.filename.match(PACKAGE_VERSION_PATTERN)?.[1];
      invariant(
        version,
        `Squirrel package has no stable version: ${entry.filename}`,
        "INVALID_RELEASES"
      );
      return {
        ...entry,
        url: `https://github.com/${repository}/releases/download/v${version}/${encodeURIComponent(entry.filename)}`,
      };
    })
  );
}

function parsePackageReference(value, lineNumber) {
  if (FILENAME_PATTERN.test(value)) {
    return { filename: value, url: undefined };
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new ReleaseError(
      `invalid Squirrel package filename on line ${lineNumber}: ${value}`,
      { code: "INVALID_RELEASES" }
    );
  }
  invariant(
    parsed.protocol === "https:",
    `Squirrel package URL must use HTTPS on line ${lineNumber}`,
    "INVALID_RELEASES"
  );
  invariant(
    !(
      parsed.username ||
      parsed.password ||
      parsed.port ||
      parsed.search ||
      parsed.hash
    ),
    `Squirrel package URL must be an immutable HTTPS address on line ${lineNumber}`,
    "INVALID_RELEASES"
  );
  const pathname = decodeURIComponent(parsed.pathname);
  const filename = pathname.slice(pathname.lastIndexOf("/") + 1);
  invariant(
    FILENAME_PATTERN.test(filename),
    `invalid Squirrel package URL on line ${lineNumber}`,
    "INVALID_RELEASES"
  );
  return { filename, url: parsed.toString() };
}

export function isDeltaFilename(filename) {
  return DELTA_PATTERN.test(filename);
}

export function isFullFilename(filename) {
  return FULL_PATTERN.test(filename);
}

export function matchingFullFilename(deltaFilename) {
  return deltaFilename.replace(DELTA_SUFFIX_PATTERN, "-full.nupkg");
}

/**
 * Keep every full package. A delta is promoted only when it is present, its
 * Squirrel hash and length are valid, and it is smaller than its matching full
 * package. Invalid deltas are intentionally removed from RELEASES; callers can
 * leave the immutable delta object in the candidate prefix for forensics.
 */
export function selectProductionReleases(entries, files = undefined) {
  const fullEntries = entries.filter((entry) => entry.isFull);
  invariant(
    fullEntries.length > 0,
    "Squirrel RELEASES must contain at least one full package",
    "NO_FULL_RELEASE"
  );

  const selected = [];
  const droppedDeltas = [];
  for (const entry of entries) {
    if (entry.isFull) {
      selected.push(entry);
      continue;
    }

    const fullEntry = findMatchingFullEntry(entry, fullEntries);
    const validation = validatePackageEntry(entry, files);
    const fullValidation = validatePackageEntry(fullEntry, files);
    if (
      fullEntry &&
      validation.valid &&
      fullValidation.valid &&
      entry.size < fullEntry.size
    ) {
      selected.push(entry);
    } else {
      droppedDeltas.push({
        ...entry,
        reason: deltaDropReason(fullEntry, validation, fullValidation),
      });
    }
  }
  return { entries: selected, droppedDeltas, text: formatReleases(selected) };
}

export function validateReleases(text, files, { requireFull = true } = {}) {
  const entries = parseReleases(text);
  if (requireFull) {
    invariant(
      entries.some((entry) => entry.isFull),
      "Squirrel RELEASES must contain a full package",
      "NO_FULL_RELEASE"
    );
  }
  const invalid = entries
    .map((entry) => ({ entry, result: validatePackageEntry(entry, files) }))
    .filter(({ result }) => !result.valid)
    .map(({ entry, result }) => ({ ...entry, reason: result.reason }));
  return { entries, invalid, valid: invalid.length === 0 };
}

export function filterReleaseManifest(text, files) {
  const entries = parseReleases(text);
  const selected = selectProductionReleases(entries, files);
  const invalidFull = selected.entries
    .filter((entry) => entry.isFull)
    .map((entry) => ({ entry, result: validatePackageEntry(entry, files) }))
    .filter(({ result }) => !result.valid);
  invariant(
    invalidFull.length === 0,
    `full package is invalid: ${invalidFull.map(({ entry, result }) => `${entry.filename} (${result.reason})`).join(", ")}`,
    "INVALID_FULL_RELEASE"
  );
  return selected;
}

function findMatchingFullEntry(delta, fullEntries) {
  const expectedFilename = matchingFullFilename(delta.filename);
  return fullEntries.find(
    (entry) => entry.filename.toLowerCase() === expectedFilename.toLowerCase()
  );
}

function deltaDropReason(fullEntry, validation, fullValidation) {
  if (!fullEntry) {
    return "matching full package is missing";
  }
  if (!validation.valid) {
    return validation.reason;
  }
  if (!fullValidation.valid) {
    return `full package ${fullEntry.filename} is invalid`;
  }
  return "delta is not smaller than full package";
}

function validatePackageEntry(entry, files) {
  if (!entry) {
    return { valid: false, reason: "matching full package is missing" };
  }
  const info = getPackageInfo(files, entry.filename);
  if (info === undefined) {
    return {
      valid: false,
      reason: `package bytes are missing for ${entry.filename}`,
    };
  }
  const actualSize = info.size;
  if (actualSize !== entry.size) {
    return {
      valid: false,
      reason: `size expected ${entry.size}, got ${actualSize}`,
    };
  }
  const actualHash = info.sha1 ?? sha1Bytes(info.data);
  if (actualHash !== entry.hash.toLowerCase()) {
    return {
      valid: false,
      reason: `SHA-1 expected ${entry.hash}, got ${actualHash}`,
    };
  }
  return { valid: true };
}

function getPackageInfo(files, filename) {
  if (!files) {
    return undefined;
  }
  let value;
  if (files instanceof Map) {
    value = files.get(filename);
  } else if (typeof files === "object") {
    value = files[filename];
  }
  if (value === undefined) {
    return undefined;
  }
  if (Buffer.isBuffer(value)) {
    return { data: value, size: value.byteLength };
  }
  if (value instanceof Uint8Array) {
    const data = Buffer.from(value);
    return { data, size: data.byteLength };
  }
  if (
    value &&
    typeof value === "object" &&
    (value.data !== undefined || value.sha1 !== undefined)
  ) {
    const data = value.data === undefined ? undefined : Buffer.from(value.data);
    return { data, size: value.size ?? data?.byteLength, sha1: value.sha1 };
  }
  const data = Buffer.from(value);
  return { data, size: data.byteLength };
}

export { HASH_PATTERN };
