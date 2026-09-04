import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosStoreFromEnv, invokeCos } from "./release/cos.mjs";
import { prefixForKind } from "./release/operations.mjs";
import { parseReleases } from "./release/squirrel.mjs";

const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_RUN_ID_PATTERN = /^\d+$/;

function normalizePrefix(value) {
  return String(value ?? "")
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

export function buildInventoryPrefixes(releasePrefix = "") {
  return {
    testing: `${prefixForKind("testing", {
      runId: "0",
      releasePrefix,
    }).replace(/\/0$/, "")}/`,
    candidates:
      `${normalizePrefix(releasePrefix)}/updates/win32/x64/candidates/`.replace(
        /^\//,
        "",
      ),
    downloads: `${normalizePrefix(releasePrefix)}/downloads/`.replace(
      /^\//,
      "",
    ),
    stable: `${prefixForKind("stable", { releasePrefix })}/`,
    buildBase: `${prefixForKind("build-base", { releasePrefix })}/`,
  };
}

export function buildTemporaryCleanupTargets({
  version,
  runId,
  releasePrefix = "",
}) {
  if (!SAFE_VERSION_PATTERN.test(String(version ?? ""))) {
    throw new Error(`Invalid release version: ${String(version)}`);
  }
  if (!SAFE_RUN_ID_PATTERN.test(String(runId ?? ""))) {
    throw new Error(`Invalid GitHub run id: ${String(runId)}`);
  }
  return [
    `${prefixForKind("testing", { runId, releasePrefix })}/`,
    `${prefixForKind("candidate", { version, releasePrefix })}/`,
  ];
}

export function assertTemporaryCleanupKey(key, targetPrefixes) {
  const normalizedKey = normalizePrefix(key);
  const targets = targetPrefixes.map((value) => `${normalizePrefix(value)}/`);
  if (!targets.some((prefix) => `${normalizedKey}/`.startsWith(prefix))) {
    throw new Error(
      `Refusing to delete object outside temporary targets: ${key}`,
    );
  }
  if (
    /\/(?:stable|build-base)\//.test(`/${normalizedKey}/`) ||
    normalizedKey.includes("/downloads/")
  ) {
    throw new Error(`Refusing to delete protected release object: ${key}`);
  }
  return normalizedKey;
}

export function summarizeObjects(objects) {
  return {
    count: objects.length,
    bytes: objects.reduce((total, object) => total + Number(object.size), 0),
  };
}

async function listPrefix(store, prefix) {
  const objects = [];
  let marker;
  do {
    const page = await invokeCos(
      store.client,
      "getBucket",
      {
        Bucket: store.bucket,
        Region: store.region,
        Prefix: prefix,
        Marker: marker,
        MaxKeys: 1000,
      },
      store.requestOptions(),
    );
    const contents = Array.isArray(page?.Contents)
      ? page.Contents
      : page?.Contents
        ? [page.Contents]
        : [];
    for (const object of contents) {
      objects.push({
        key: object.Key,
        size: Number(object.Size),
        lastModified: object.LastModified,
        etag: object.ETag,
      });
    }
    const truncated = String(page?.IsTruncated).toLowerCase() === "true";
    marker = truncated ? page?.NextMarker || contents.at(-1)?.Key : undefined;
    if (truncated && !marker) {
      throw new Error(`COS listing was truncated without a marker: ${prefix}`);
    }
  } while (marker);
  return objects;
}

async function verifyStableRelease(store, version, releasePrefix) {
  const key = `${prefixForKind("stable", { releasePrefix })}/RELEASES`;
  const url = `https://${store.bucket}.cos.${store.region}.myqcloud.com/${key
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(
      `Stable RELEASES is not publicly readable (${response.status})`,
    );
  }
  const entries = parseReleases(await response.text());
  const suffix = `-${version}-full.nupkg`.toLowerCase();
  if (!entries.some((entry) => entry.filename.toLowerCase().endsWith(suffix))) {
    throw new Error(`Stable RELEASES does not contain v${version}`);
  }
}

async function inventory(store, releasePrefix) {
  const groups = {};
  for (const [name, prefix] of Object.entries(
    buildInventoryPrefixes(releasePrefix),
  )) {
    const objects = await listPrefix(store, prefix);
    groups[name] = {
      prefix,
      ...summarizeObjects(objects),
      objects,
    };
  }
  return groups;
}

async function prune(store, { version, runId, releasePrefix, confirmation }) {
  const expected = `PRUNE ${version} ${runId}`;
  if (confirmation !== expected) {
    throw new Error(`Cleanup confirmation must equal: ${expected}`);
  }
  await verifyStableRelease(store, version, releasePrefix);
  const targets = buildTemporaryCleanupTargets({
    version,
    runId,
    releasePrefix,
  });
  const objects = (
    await Promise.all(targets.map((prefix) => listPrefix(store, prefix)))
  ).flat();
  for (const object of objects) {
    await store.delete(assertTemporaryCleanupKey(object.key, targets));
  }
  for (const prefix of targets) {
    const remaining = await listPrefix(store, prefix);
    if (remaining.length > 0) {
      throw new Error(`Temporary COS prefix was not emptied: ${prefix}`);
    }
  }
  return {
    targets,
    deleted: summarizeObjects(objects),
    objects,
  };
}

function parseArguments(argv) {
  const args = { command: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument near: ${String(name)}`);
    }
    args[name.slice(2)] = value;
  }
  return args;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const store = createCosStoreFromEnv(process.env);
  const releasePrefix = process.env.COS_RELEASE_PREFIX ?? "";
  let report;
  if (args.command === "inventory") {
    report = {
      command: "inventory",
      bucket: store.bucket,
      region: store.region,
      groups: await inventory(store, releasePrefix),
    };
  } else if (args.command === "prune") {
    report = {
      command: "prune",
      bucket: store.bucket,
      region: store.region,
      result: await prune(store, {
        version: args.version,
        runId: args["run-id"],
        confirmation: args.confirmation,
        releasePrefix,
      }),
    };
  } else {
    throw new Error(
      "Usage: release-cos-maintenance.mjs <inventory|prune> [options]",
    );
  }
  const outputPath = path.resolve(args.output ?? "cos-maintenance-report.json");
  await fsp.writeFile(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8",
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isMain =
  process.argv[1] &&
  path.resolve(fileURLToPath(import.meta.url)) ===
    path.resolve(process.argv[1]);
if (isMain) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
