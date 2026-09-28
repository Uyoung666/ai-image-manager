import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { downloadRecords, feedRecords } from "./bundle.mjs";
import { sha256Bytes } from "./checksums.mjs";
import { IMMUTABLE_CACHE_CONTROL, NO_CACHE_CONTROL } from "./cos.mjs";
import { prefixForKind } from "./operations.mjs";
import { assertImmutableObject, compareVersions } from "./semver.mjs";
import { formatReleases, parseReleases } from "./squirrel.mjs";

const PACKAGE_VERSION_PATTERN = /-(\d+\.\d+\.\d+)-(?:full|delta)\.nupkg$/i;
const PUBLIC_RELEASE_PATTERN =
  /(?:^|\/)(?:downloads\/\d+\.\d+\.\d+|updates\/win32\/x64\/(?:stable|build-base))\//;

export function publicObjectUrl(store, key) {
  return `https://${store.bucket}.cos.${store.region}.myqcloud.com/${key.split("/").map(encodeURIComponent).join("/")}`;
}

// Production directories are publicly delivered already. Verify those exact
// delivery bytes instead of requiring the write-only CAM identity to read
// private objects. This adapter must never be used for private candidate data.
export function withPublicReleaseReads(store, fetchFn = fetch) {
  const request = (key, method) => {
    if (
      !PUBLIC_RELEASE_PATTERN.test(key) ||
      key.split("/").some((segment) => [".", ".."].includes(segment))
    ) {
      throw new Error(
        "Public release reads are restricted to production directories"
      );
    }
    return fetchFn(publicObjectUrl(store, key), {
      method,
      cache: "no-store",
      signal: AbortSignal.timeout(120_000),
    });
  };
  store.head = async (key) => {
    const response = await request(key, "HEAD");
    if (response.status === 404) {
      return null;
    }
    if (!response.ok) {
      throw new Error(`Public COS HEAD failed (${response.status}): ${key}`);
    }
    return { headers: Object.fromEntries(response.headers) };
  };
  store.getBytes = async (key) => {
    const response = await request(key, "GET");
    if (!response.ok) {
      throw new Error(`Public COS GET failed (${response.status}): ${key}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 1024 * 1024) {
        throw new Error("Release pointer exceeds size limit");
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  store.hashObject = async (key) => {
    const response = await request(key, "GET");
    if (!response.ok) {
      throw new Error(`Public COS GET failed (${response.status}): ${key}`);
    }
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      hash.update(chunk);
    }
    return {
      size,
      sha256: hash.digest("hex"),
      headers: Object.fromEntries(response.headers),
    };
  };
  return store;
}

export async function verifyPublicObject(
  store,
  key,
  record,
  { bytes = false, fetchFn = fetch } = {}
) {
  const response = await fetchFn(publicObjectUrl(store, key), {
    method: bytes ? "GET" : "HEAD",
    cache: "no-store",
    signal: AbortSignal.timeout(bytes ? 10 * 60_000 : 120_000),
  });
  if (!response.ok) {
    throw new Error(
      `Public COS verification failed (${response.status}): ${key}`
    );
  }
  assertImmutableObject(
    { headers: Object.fromEntries(response.headers) },
    record
  );
  if (!bytes) {
    return;
  }
  const hash = createHash("sha256");
  let size = 0;
  let lastLog = Date.now();
  for await (const chunk of response.body) {
    size += chunk.length;
    hash.update(chunk);
    if (Date.now() - lastLog > 5000) {
      console.error(`COS verifying ${key}: ${size}/${record.size} bytes`);
      lastLog = Date.now();
    }
  }
  if (size !== record.size || hash.digest("hex") !== record.sha256) {
    throw new Error(`Public COS byte mismatch: ${key}`);
  }
}

export async function ensureFile(
  store,
  key,
  record,
  verify = verifyPublicObject
) {
  const existing = await store.head(key);
  if (existing) {
    assertImmutableObject(existing, record);
    await verify(store, key, record);
    console.error(`COS already verified, skipped: ${key}`);
    return;
  }
  console.error(`COS uploading ${key} (${record.size} bytes)`);
  await store.putFile(key, record.sourcePath, record);
  await verify(store, key, record, { bytes: true });
}

export async function stageDownloads(
  store,
  root,
  manifest,
  releasePrefix,
  verify
) {
  const prefix = prefixForKind("versioned", {
    version: manifest.version,
    releasePrefix,
  });
  for (const record of await downloadRecords(root, manifest)) {
    await ensureFile(store, `${prefix}/${record.name}`, record, verify);
  }
}

export async function stageUpdatePackages(
  store,
  root,
  manifest,
  releasePrefix,
  verify = verifyPublicObject
) {
  const stable = prefixForKind("stable", { releasePrefix });
  const base = prefixForKind("build-base", { releasePrefix });
  for (const record of await feedRecords(root, manifest)) {
    const version = record.name.match(PACKAGE_VERSION_PATTERN)?.[1];
    const source = `${prefixForKind("versioned", { version, releasePrefix })}/${record.name}`;
    await ensureCopiedFile(
      store,
      source,
      `${stable}/${record.name}`,
      record,
      verify
    );
    if (record.name.endsWith(`-${manifest.version}-full.nupkg`)) {
      await ensureCopiedFile(
        store,
        source,
        `${base}/${record.name}`,
        record,
        verify
      );
    }
  }
}

async function ensureCopiedFile(store, source, destination, record, verify) {
  const existing = await store.head(destination);
  if (existing) {
    assertImmutableObject(existing, record);
    await verify(store, destination, record);
    console.error(`COS already verified, skipped: ${destination}`);
    return;
  }
  await verify(store, source, record);
  console.error(`COS copying verified package: ${source} -> ${destination}`);
  await store.copy(source, destination, {
    ...record,
    cacheControl: IMMUTABLE_CACHE_CONTROL,
  });
  await verify(store, destination, record, { bytes: true });
}

export function assertNoDowngrade(releases, version) {
  for (const entry of parseReleases(releases)) {
    const match = entry.filename.match(PACKAGE_VERSION_PATTERN);
    if (!match || compareVersions(match[1], version) > 0) {
      throw new Error("Refusing to replace a newer stable update feed");
    }
  }
}

export async function finalizeCos(
  store,
  root,
  manifest,
  releasePrefix,
  verify = verifyPublicObject
) {
  const stable = prefixForKind("stable", { releasePrefix });
  const base = prefixForKind("build-base", { releasePrefix });
  const stableKey = `${stable}/RELEASES`;
  if (await store.head(stableKey)) {
    assertNoDowngrade(
      (await store.getBytes(stableKey)).toString("utf8"),
      manifest.version
    );
  }
  const feed = await fsp.readFile(path.join(root, "feed", "RELEASES"));
  for (const record of await feedRecords(root, manifest)) {
    await verify(store, `${stable}/${record.name}`, record);
    if (record.name.endsWith(`-${manifest.version}-full.nupkg`)) {
      await verify(store, `${base}/${record.name}`, record);
    }
  }
  const current = parseReleases(feed.toString("utf8")).filter((entry) =>
    entry.filename.endsWith(`-${manifest.version}-full.nupkg`)
  );
  const writePointer = async (key, bytes) => {
    const record = { sha256: sha256Bytes(bytes), size: bytes.length };
    const existing = await store.head(key);
    if (existing && Buffer.from(await store.getBytes(key)).equals(bytes)) {
      await verify(store, key, record);
      return;
    }
    await store.putMutableBytes(key, bytes, {
      ...record,
      cacheControl: NO_CACHE_CONTROL,
      contentType: "text/plain; charset=utf-8",
    });
    await verify(store, key, record, { bytes: true });
  };
  await writePointer(`${base}/RELEASES`, Buffer.from(formatReleases(current)));
  // No package writes or other fallible preparation after this pointer switch.
  await writePointer(stableKey, feed);
  console.log(`COS stable now serves ${manifest.tag}`);
}
