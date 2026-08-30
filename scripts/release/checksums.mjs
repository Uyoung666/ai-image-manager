import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { invariant, ReleaseError } from "./errors.mjs";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:/;
const LINE_SPLIT_PATTERN = /\r?\n/;
const SHA256_LINE_PATTERN = /^([a-fA-F0-9]{64})\s+(\*?)(.+)$/;

export function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function sha1Bytes(value) {
  return createHash("sha1").update(value).digest("hex");
}

export function sha256File(filePath) {
  return hashFile(filePath, "sha256");
}

export function sha1File(filePath) {
  return hashFile(filePath, "sha1");
}

function hashFile(filePath, algorithm) {
  return new Promise((resolve, reject) => {
    const hash = createHash(algorithm);
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

export async function readFileRecord(
  filePath,
  relativePath = path.basename(filePath),
  { includeData = false } = {}
) {
  const stat = await fsp.stat(filePath);
  const [sha256, sha1] = await Promise.all([
    sha256File(filePath),
    sha1File(filePath),
  ]);
  const data = includeData ? await fsp.readFile(filePath) : undefined;
  return {
    relativePath: normalizeRelativePath(relativePath),
    sourcePath: filePath,
    data,
    size: stat.size,
    sha256,
    sha1,
  };
}

export async function collectFileRecords(
  rootDirectory,
  { exclude = new Set() } = {}
) {
  const root = path.resolve(rootDirectory);
  const records = [];

  async function visit(directory) {
    const entries = await fsp.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const fullPath = path.join(directory, entry.name);
      const relativePath = normalizeRelativePath(path.relative(root, fullPath));
      if (entry.isDirectory()) {
        await visit(fullPath);
      } else if (entry.isFile() && !exclude.has(relativePath)) {
        records.push(await readFileRecord(fullPath, relativePath));
      }
    }
  }

  await visit(root);
  records.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en")
  );
  return records;
}

export function normalizeRelativePath(value) {
  const normalized = String(value ?? "").replaceAll("\\", "/");
  invariant(
    normalized &&
      !normalized.startsWith("/") &&
      !WINDOWS_DRIVE_PATTERN.test(normalized),
    `invalid relative release path: ${String(value)}`,
    "INVALID_RELEASE_PATH"
  );
  const segments = normalized.split("/");
  invariant(
    segments.every((segment) => segment && segment !== "." && segment !== ".."),
    `release path must not contain empty, . or .. segments: ${normalized}`,
    "INVALID_RELEASE_PATH"
  );
  return normalized;
}

export function formatSha256Sums(records) {
  const sorted = [...records]
    .filter((record) => record.relativePath !== "SHA256SUMS.txt")
    .sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath, "en")
    );
  return `${sorted.map((record) => `${record.sha256}  ${record.relativePath}`).join("\n")}\n`;
}

export function parseSha256Sums(text) {
  const entries = [];
  const seen = new Set();
  const lines = String(text ?? "").split(LINE_SPLIT_PATTERN);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index].trimEnd();
    if (!raw.trim()) {
      continue;
    }
    const match = raw.match(SHA256_LINE_PATTERN);
    if (!match) {
      throw new ReleaseError(`invalid SHA256SUMS.txt line ${index + 1}`, {
        code: "INVALID_CHECKSUMS",
      });
    }
    const relativePath = normalizeRelativePath(match[3].trim());
    invariant(
      !seen.has(relativePath),
      `duplicate SHA256SUMS entry: ${relativePath}`,
      "DUPLICATE_CHECKSUM"
    );
    seen.add(relativePath);
    entries.push({
      sha256: match[1].toLowerCase(),
      relativePath,
      binary: match[2] === "*",
    });
  }
  return entries;
}

/**
 * Verify a checksum manifest against either a directory or a Map/object of
 * in-memory byte values.  Returning records makes this useful to the release
 * verifier as well as to unit tests.
 */
export async function verifySha256Sums(
  manifest,
  source,
  { strict = true } = {}
) {
  const entries = parseSha256Sums(manifest);
  const actualPaths = new Set();
  const result = [];

  for (const entry of entries) {
    if (typeof source === "string") {
      const fullPath = path.join(source, ...entry.relativePath.split("/"));
      const stat = await fsp.stat(fullPath).catch((error) => {
        throw new ReleaseError(
          `missing file for SHA256SUMS entry: ${entry.relativePath}`,
          {
            code: "CHECKSUM_FILE_MISSING",
            cause: error,
          }
        );
      });
      const actual = await sha256File(fullPath).catch((error) => {
        throw new ReleaseError(
          `failed to hash SHA256SUMS entry: ${entry.relativePath}`,
          {
            code: "CHECKSUM_FILE_READ_FAILED",
            cause: error,
          }
        );
      });
      invariant(
        actual === entry.sha256,
        `SHA-256 mismatch for ${entry.relativePath}: expected ${entry.sha256}, got ${actual}`,
        "CHECKSUM_MISMATCH"
      );
      actualPaths.add(entry.relativePath);
      result.push({ ...entry, size: stat.size, actualSha256: actual });
      continue;
    }
    const data = getByteValue(source, entry.relativePath);
    if (data === undefined) {
      throw new ReleaseError(
        `missing bytes for SHA256SUMS entry: ${entry.relativePath}`,
        {
          code: "CHECKSUM_FILE_MISSING",
        }
      );
    }
    const actual = sha256Bytes(data);
    invariant(
      actual === entry.sha256,
      `SHA-256 mismatch for ${entry.relativePath}: expected ${entry.sha256}, got ${actual}`,
      "CHECKSUM_MISMATCH"
    );
    actualPaths.add(entry.relativePath);
    result.push({ ...entry, size: data.byteLength, actualSha256: actual });
  }

  if (strict) {
    const records =
      typeof source === "string"
        ? await collectFileRecords(source)
        : collectByteRecords(source);
    for (const record of records) {
      if (
        record.relativePath !== "SHA256SUMS.txt" &&
        !actualPaths.has(record.relativePath)
      ) {
        throw new ReleaseError(
          `file is absent from SHA256SUMS.txt: ${record.relativePath}`,
          {
            code: "CHECKSUM_ENTRY_MISSING",
          }
        );
      }
    }
  }
  return result;
}

export function collectByteRecords(source) {
  const records = [];
  for (const [relativePath, value] of byteEntries(source)) {
    const data = toBuffer(value);
    records.push({
      relativePath: normalizeRelativePath(relativePath),
      data,
      size: data.byteLength,
      sha256: sha256Bytes(data),
      sha1: sha1Bytes(data),
    });
  }
  return records.sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath, "en")
  );
}

function byteEntries(source) {
  if (source instanceof Map) {
    return source.entries();
  }
  if (source && typeof source === "object") {
    return Object.entries(source);
  }
  return [];
}

function getByteValue(source, relativePath) {
  if (source instanceof Map) {
    return source.get(relativePath);
  }
  return source?.[relativePath];
}

function toBuffer(value) {
  if (Buffer.isBuffer(value)) {
    return value;
  }
  if (value instanceof Uint8Array) {
    return Buffer.from(value);
  }
  if (typeof value === "string") {
    return Buffer.from(value);
  }
  throw new TypeError(
    "release byte values must be Buffer, Uint8Array, or string"
  );
}

export { SHA256_PATTERN };
