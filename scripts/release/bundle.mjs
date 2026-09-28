import fsp from "node:fs/promises";
import path from "node:path";
import {
  collectFileRecords,
  formatSha256Sums,
  normalizeRelativePath,
  parseSha256Sums,
  readFileRecord,
  sha256Bytes,
  verifySha256Sums,
} from "./checksums.mjs";
import { parseStableVersion } from "./semver.mjs";
import {
  formatGitHubReleases,
  formatReleases,
  parseReleases,
  validateReleases,
} from "./squirrel.mjs";

const BOM_PATTERN = /^\uFEFF/;
const LINES_PATTERN = /\r?\n/;
const BINARY_PATTERN = /\.(?:exe|msi|zip|nupkg)$/i;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export function assertIdentity(metadata, expected = {}) {
  parseStableVersion(metadata.version);
  if (
    metadata.tag !== `v${metadata.version}` ||
    !COMMIT_PATTERN.test(metadata.commit) ||
    !COMMIT_PATTERN.test(metadata.toolingCommit)
  ) {
    throw new Error("Invalid release bundle identity");
  }
  for (const key of ["version", "commit"]) {
    if (expected[key] && expected[key] !== metadata[key]) {
      throw new Error(`Bundle ${key} does not match requested release`);
    }
  }
}

export async function writeJson(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

export async function readJson(file) {
  return JSON.parse(
    (await fsp.readFile(file, "utf8")).replace(BOM_PATTERN, "")
  );
}

async function copy(source, destination) {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  await fsp.copyFile(source, destination);
}

export async function prepareBundle(makeRoot, root, identity) {
  assertIdentity(identity);
  const all = await collectFileRecords(makeRoot);
  const binaries = all.filter((record) =>
    BINARY_PATTERN.test(record.relativePath)
  );
  const seen = new Set();
  for (const record of binaries) {
    const name = path.basename(record.relativePath);
    if (seen.has(name.toLowerCase())) {
      throw new Error(`Ambiguous release filename: ${name}`);
    }
    seen.add(name.toLowerCase());
    await copy(record.sourcePath, path.join(root, "files", name));
  }
  const sourceReleases = path.join(
    makeRoot,
    "squirrel.windows",
    "x64",
    "RELEASES"
  );
  await copy(sourceReleases, path.join(root, "feed", "RELEASES"));
  const files = await collectFileRecords(path.join(root, "files"));
  const downloads = files.filter(
    (record) =>
      !record.relativePath.endsWith(".nupkg") ||
      record.relativePath.includes(`-${identity.version}-`)
  );
  const provenance = {
    schemaVersion: 1,
    version: identity.version,
    tag: identity.tag,
    authenticode: "not-signed",
    generatedAt: identity.generatedAt,
    files: downloads.map(({ relativePath: filePath, size, sha256 }) => ({
      path: filePath,
      size,
      sha256,
    })),
    checksumManifest: "SHA256SUMS.txt (self-entry omitted)",
  };
  await writeJson(path.join(root, "download", "provenance.json"), provenance);
  const provenanceRecord = await readFileRecord(
    path.join(root, "download", "provenance.json")
  );
  await fsp.writeFile(
    path.join(root, "download", "SHA256SUMS.txt"),
    formatSha256Sums([...downloads, provenanceRecord])
  );
  const feed = await fsp.readFile(path.join(root, "feed", "RELEASES"), "utf8");
  await fsp.mkdir(path.join(root, "github"), { recursive: true });
  await fsp.writeFile(
    path.join(root, "github", "RELEASES"),
    formatGitHubReleases(parseReleases(feed), identity.version)
  );
  return sealBundle(root, identity);
}

export async function sealBundle(root, identity) {
  assertIdentity(identity);
  const records = await collectFileRecords(root, {
    exclude: new Set(["bundle.json"]),
  });
  const manifest = {
    schemaVersion: 1,
    ...identity,
    files: records.map(({ relativePath, size, sha256, sha1 }) => ({
      relativePath,
      size,
      sha256,
      sha1,
    })),
  };
  await writeJson(path.join(root, "bundle.json"), manifest);
  await verifyBundle(root, identity);
  return manifest;
}

export async function verifyBundle(root, expected = {}) {
  const manifest = await readJson(path.join(root, "bundle.json"));
  if (manifest.schemaVersion !== 1) {
    throw new Error("Unsupported release bundle schema");
  }
  assertIdentity(manifest, expected);
  const actual = await collectFileRecords(root, {
    exclude: new Set(["bundle.json"]),
  });
  const actualMap = new Map(
    actual.map((record) => [record.relativePath, record])
  );
  if (
    actualMap.size !== manifest.files.length ||
    new Set(manifest.files.map((file) => file.relativePath)).size !==
      manifest.files.length
  ) {
    throw new Error("Unexpected or missing bundle files");
  }
  for (const record of manifest.files) {
    const file = actualMap.get(normalizeRelativePath(record.relativePath));
    if (
      !file ||
      file.sha256 !== record.sha256 ||
      file.sha1 !== record.sha1 ||
      file.size !== record.size
    ) {
      throw new Error(`Bundle hash mismatch: ${record.relativePath}`);
    }
  }
  const feed = await fsp.readFile(path.join(root, "feed", "RELEASES"), "utf8");
  const binaryMap = new Map(
    actual
      .filter((record) => record.relativePath.startsWith("files/"))
      .map((record) => [path.basename(record.relativePath), record])
  );
  const validation = validateReleases(feed, binaryMap);
  if (!validation.valid) {
    throw new Error("Bundle RELEASES references invalid package bytes");
  }
  const full = validation.entries.filter((entry) =>
    entry.filename.endsWith(`-${manifest.version}-full.nupkg`)
  );
  const delta = validation.entries.filter((entry) =>
    entry.filename.endsWith(`-${manifest.version}-delta.nupkg`)
  );
  if (
    full.length !== 1 ||
    delta.length !== 1 ||
    delta[0].size >= full[0].size
  ) {
    throw new Error(
      "Bundle requires a current full package and a smaller delta"
    );
  }
  for (const suffix of ["Setup.exe", ".msi", `-${manifest.version}.zip`]) {
    if (
      [...binaryMap.keys()].filter((name) => name.endsWith(suffix)).length !== 1
    ) {
      throw new Error(`Bundle requires exactly one ${suffix}`);
    }
  }
  const publicFiles = await downloadRecords(root, manifest);
  const expectedNames = [...binaryMap.keys()].filter(
    (name) => !name.endsWith(".nupkg") || name.includes(`-${manifest.version}-`)
  );
  const publicNames = publicFiles.map((file) => file.name);
  if (
    new Set(publicNames).size !== publicNames.length ||
    expectedNames.length + 2 !== publicNames.length ||
    expectedNames.some((name) => !publicNames.includes(name))
  ) {
    throw new Error(
      "Download provenance must include every current release binary exactly once"
    );
  }
  const checksumEntries = parseSha256Sums(
    await fsp.readFile(path.join(root, "download", "SHA256SUMS.txt"), "utf8")
  );
  const listed = publicFiles.filter(
    (record) => record.name !== "SHA256SUMS.txt"
  );
  if (checksumEntries.length !== listed.length) {
    throw new Error("Download checksum manifest is incomplete");
  }
  for (const entry of checksumEntries) {
    const record = listed.find((r) => r.name === entry.relativePath);
    if (record?.sha256 !== entry.sha256) {
      throw new Error(`Download checksum mismatch: ${entry.relativePath}`);
    }
  }
  const githubFeed = await fsp.readFile(
    path.join(root, "github", "RELEASES"),
    "utf8"
  );
  if (githubFeed !== formatReleases(full)) {
    throw new Error("GitHub compatibility feed mismatch");
  }
  return manifest;
}

export async function downloadRecords(root, manifest) {
  const provenance = await readJson(
    path.join(root, "download", "provenance.json")
  );
  if (
    provenance.version !== manifest.version ||
    provenance.tag !== manifest.tag
  ) {
    throw new Error("Download provenance identity mismatch");
  }
  const records = provenance.files.map((file) => {
    const name = normalizeRelativePath(file.path);
    if (name.includes("/")) {
      throw new Error("Download filenames must be flat");
    }
    const record = manifest.files.find(
      (entry) => entry.relativePath === `files/${name}`
    );
    if (!record || record.sha256 !== file.sha256 || record.size !== file.size) {
      throw new Error(`Download provenance mismatch: ${name}`);
    }
    return {
      ...record,
      name,
      sourcePath: path.join(root, record.relativePath),
    };
  });
  for (const name of ["SHA256SUMS.txt", "provenance.json"]) {
    const record = manifest.files.find(
      (entry) => entry.relativePath === `download/${name}`
    );
    if (!record) {
      throw new Error(`Missing ${name}`);
    }
    records.push({
      ...record,
      name,
      sourcePath: path.join(root, record.relativePath),
    });
  }
  return records;
}

export function validateSmoke(smoke, identity, bundleSha256) {
  if (
    ![2, 3].includes(smoke.schemaVersion) ||
    smoke.version !== identity.version ||
    smoke.tag !== identity.tag ||
    smoke.commit !== identity.commit ||
    smoke.setupSmoke !== "passed" ||
    smoke.squirrelDeltaSmoke !== "passed" ||
    smoke.msiSmoke !== "passed" ||
    smoke.msiSmokeMode !== "upgrade"
  ) {
    throw new Error(
      "Release installer smoke evidence is incomplete or mismatched"
    );
  }
  if (smoke.schemaVersion === 3 && smoke.bundleSha256 !== bundleSha256) {
    throw new Error("Smoke evidence refers to different bundle bytes");
  }
}

export async function importLegacyBundle(candidate, evidence, root, identity) {
  const metadata = await fsp.readFile(
    path.join(evidence, "candidate-metadata.txt"),
    "utf8"
  );
  for (const key of ["version", "commit"]) {
    if (
      !metadata
        .split(LINES_PATTERN)
        .some((line) => line.trim() === `${key}=${identity[key]}`)
    ) {
      throw new Error(`Legacy candidate ${key} mismatch`);
    }
  }
  const smoke = await readJson(path.join(evidence, "smoke-status.json"));
  validateSmoke(smoke, identity);
  await verifySha256Sums(
    await fsp.readFile(path.join(evidence, "SHA256SUMS.txt"), "utf8"),
    candidate
  );
  const all = await collectFileRecords(candidate);
  for (const record of all.filter((r) => BINARY_PATTERN.test(r.relativePath))) {
    await copy(
      record.sourcePath,
      path.join(root, "files", path.basename(record.relativePath))
    );
  }
  for (const name of ["SHA256SUMS.txt", "provenance.json"]) {
    await copy(
      path.join(evidence, `download-${name}`),
      path.join(root, "download", name)
    );
  }
  await copy(
    path.join(evidence, "candidate-RELEASES"),
    path.join(root, "feed", "RELEASES")
  );
  await copy(
    path.join(evidence, "github-RELEASES"),
    path.join(root, "github", "RELEASES")
  );
  const result = await sealBundle(root, identity);
  return {
    manifest: result,
    smoke: {
      ...smoke,
      schemaVersion: 3,
      sourceRunId: identity.sourceRunId,
      bundleSha256: sha256Bytes(
        await fsp.readFile(path.join(root, "bundle.json"))
      ),
    },
  };
}

export async function feedRecords(root, manifest) {
  const entries = parseReleases(
    await fsp.readFile(path.join(root, "feed", "RELEASES"), "utf8")
  );
  return entries.map((entry) => {
    const record = manifest.files.find(
      (r) => r.relativePath === `files/${entry.filename}`
    );
    if (!record) {
      throw new Error(`Missing feed package: ${entry.filename}`);
    }
    return {
      ...record,
      name: entry.filename,
      sourcePath: path.join(root, record.relativePath),
    };
  });
}
