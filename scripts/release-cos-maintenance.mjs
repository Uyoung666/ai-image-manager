import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readJson } from "./release/bundle.mjs";
import { createCosStoreFromEnv, invokeCos } from "./release/cos.mjs";
import { prefixForKind } from "./release/operations.mjs";
import { parseReleases } from "./release/squirrel.mjs";

const RECOVERY_ARTIFACT_PATTERN =
  /^release-(?:candidate|bundle|recovery)-(\d+\.\d+\.\d+)$/;
const SAFE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_RUN_ID_PATTERN = /^\d+$/;
const TRAILING_ZERO_RUN_PATTERN = /\/0$/;
const LEADING_SLASH_PATTERN = /^\//;
const PROTECTED_RELEASE_PATH_PATTERN = /\/(?:stable|build-base)\//;
const PROTECTED_USER_FILE_PATTERN = /(?:^|\/)temp(?:\/|$)|\.(?:csv|xlsx)$/i;
const RELEASE_TEMP_FILE_PATTERN =
  /^(?:RELEASES|SHA256SUMS\.txt|provenance\.json|[A-Za-z0-9._ -]+\.(?:nupkg|exe|msi|zip))$/;

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
    }).replace(TRAILING_ZERO_RUN_PATTERN, "")}/`,
    candidates:
      `${normalizePrefix(releasePrefix)}/updates/win32/x64/candidates/`.replace(
        LEADING_SLASH_PATTERN,
        ""
      ),
    downloads: `${normalizePrefix(releasePrefix)}/downloads/`.replace(
      LEADING_SLASH_PATTERN,
      ""
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
  if (
    normalizedKey
      .split("/")
      .some((segment) => segment === "." || segment === "..") ||
    !targets.some((prefix) => `${normalizedKey}/`.startsWith(prefix))
  ) {
    throw new Error(
      `Refusing to delete object outside temporary targets: ${key}`
    );
  }
  if (
    PROTECTED_RELEASE_PATH_PATTERN.test(`/${normalizedKey}/`) ||
    normalizedKey.includes("/downloads/") ||
    PROTECTED_USER_FILE_PATTERN.test(normalizedKey) ||
    !RELEASE_TEMP_FILE_PATTERN.test(normalizedKey.split("/").at(-1))
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

export async function listPrefix(store, prefix) {
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
      store.requestOptions()
    );
    let contents = [];
    if (Array.isArray(page?.Contents)) {
      contents = page.Contents;
    } else if (page?.Contents) {
      contents = [page.Contents];
    }
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
      `Stable RELEASES is not publicly readable (${response.status})`
    );
  }
  const entries = parseReleases(await response.text());
  const suffix = `-${version}-full.nupkg`.toLowerCase();
  if (!entries.some((entry) => entry.filename.toLowerCase().endsWith(suffix))) {
    throw new Error(`Stable RELEASES does not contain v${version}`);
  }
}

export async function inventory(store, releasePrefix) {
  const groups = {};
  for (const [name, prefix] of Object.entries(
    buildInventoryPrefixes(releasePrefix)
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

// A cleanup plan is bound to exact keys, sizes and ETags. Applying it always
// refreshes both the inventory and recovery references before deleting.
export function planExpiredObjects(
  groups,
  {
    now = Date.now(),
    days = 7,
    protectedRunIds = [],
    protectedVersions = [],
    activeRelease = false,
  } = {}
) {
  if (activeRelease) {
    return { objects: [], blocked: "A release or recovery is running" };
  }
  if (!Number.isFinite(days) || days < 7) {
    throw new Error("Retention must be at least seven days");
  }
  const objects = [];
  for (const group of [groups.testing, groups.candidates]) {
    const protectedIds =
      group === groups.testing ? protectedRunIds : protectedVersions;
    for (const object of group?.objects ?? []) {
      if (
        isExpiredTemporary(
          object,
          group.prefix,
          protectedIds,
          now - days * 86_400_000
        )
      ) {
        objects.push(object);
      }
    }
  }
  return {
    objects,
    ...summarizeObjects(objects),
    generatedAt: new Date(now).toISOString(),
  };
}

function isExpiredTemporary(object, prefix, protectedIds, cutoff) {
  const parts = object.key.slice(prefix.length).split("/");
  if (
    parts.length !== 2 ||
    protectedIds.includes(parts[0]) ||
    !(Date.parse(object.lastModified) < cutoff)
  ) {
    return false;
  }
  try {
    assertTemporaryCleanupKey(object.key, [`${prefix}${parts[0]}/`]);
    return true;
  } catch {
    return false;
  }
}

export async function getRecoveryProtection(repository) {
  const { command } = await import("./release/github.mjs");
  const pages = async (route) =>
    JSON.parse(
      await command("gh", [
        "api",
        "--paginate",
        "--slurp",
        `repos/${repository}/${route}`,
      ])
    );
  const runs = (await pages("actions/runs?per_page=100")).flatMap(
    (page) => page.workflow_runs
  );
  const releaseRuns = runs.filter((run) =>
    [
      ".github/workflows/publish.yaml",
      ".github/workflows/recover-release-candidate.yaml",
      ".github/workflows/promote-release.yaml",
    ].includes(run.path)
  );
  const artifacts = (await pages("actions/artifacts?per_page=100"))
    .flatMap((page) => page.artifacts)
    .filter((artifact) => !artifact.expired);
  const protectedRunIds = new Set(["36282664740"]);
  const protectedVersions = new Set(["2.2.0"]);
  for (const artifact of artifacts) {
    const match = artifact.name.match(RECOVERY_ARTIFACT_PATTERN);
    if (match) {
      protectedVersions.add(match[1]);
      protectedRunIds.add(String(artifact.workflow_run.id));
      if (artifact.name.startsWith("release-recovery-")) {
        const parent = path.resolve("out", "release-maintenance-pointers");
        await fsp.mkdir(parent, { recursive: true });
        const directory = await fsp.mkdtemp(
          path.join(parent, `${artifact.id}-`)
        );
        await command("gh", [
          "run",
          "download",
          String(artifact.workflow_run.id),
          "--repo",
          repository,
          "--name",
          artifact.name,
          "--dir",
          directory,
        ]);
        const pointer = await readJson(path.join(directory, "recovery.json"));
        if (
          !SAFE_RUN_ID_PATTERN.test(String(pointer.sourceRunId)) ||
          pointer.version !== match[1]
        ) {
          throw new Error("Invalid recovery pointer; refusing cleanup");
        }
        protectedRunIds.add(String(pointer.sourceRunId));
      }
    }
  }
  return {
    activeRelease: releaseRuns.some((run) => run.status !== "completed"),
    protectedRunIds: [...protectedRunIds],
    protectedVersions: [...protectedVersions],
  };
}

export async function applyExpiredPlan(store, groups, protection, plan) {
  const current = planExpiredObjects(groups, protection);
  const eligible = new Map(
    current.objects.map((object) => [object.key, object])
  );
  let deleted = 0;
  for (const object of plan.objects) {
    const fresh = eligible.get(object.key);
    if (
      !fresh ||
      fresh.etag !== object.etag ||
      fresh.size !== object.size ||
      fresh.lastModified !== object.lastModified
    ) {
      throw new Error(`Cleanup plan became stale: ${object.key}`);
    }
  }
  for (const object of plan.objects) {
    const head = await store.head(object.key);
    const etag = head?.ETag ?? head?.headers?.etag;
    if (!(head && etag) || etag !== object.etag) {
      throw new Error(`Cleanup target changed: ${object.key}`);
    }
    await store.delete(object.key);
    deleted += 1;
  }
  return { deleted, bytes: summarizeObjects(plan.objects).bytes };
}

export async function assertUnversionedBucket(store) {
  const configuration = await invokeCos(
    store.client,
    "getBucketVersioning",
    {
      Bucket: store.bucket,
      Region: store.region,
    },
    store.requestOptions()
  );
  if (
    configuration.Status === "Enabled" ||
    configuration.Status === "Suspended"
  ) {
    throw new Error(
      "Versioned bucket cleanup requires explicit version inventory; refusing to create delete markers"
    );
  }
}

export function mergeMultipartLifecycle(rules, releasePrefix) {
  const prefix = normalizePrefix(releasePrefix);
  if (!prefix || prefix.split("/").some((part) => [".", ".."].includes(part))) {
    throw new Error("Lifecycle requires an explicit application prefix");
  }
  const replacements = ["downloads/", "updates/win32/x64/"].map(
    (suffix, index) => ({
      ID: `aim-release-abort-incomplete-${index}`,
      Status: "Enabled",
      Filter: { Prefix: `${prefix}/${suffix}` },
      AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
    })
  );
  return [
    ...rules.filter(
      (rule) => !replacements.some((replacement) => replacement.ID === rule.ID)
    ),
    ...replacements,
  ];
}

async function prune(store, { version, runId, releasePrefix, confirmation }) {
  const expected = `PRUNE ${version} ${runId}`;
  if (confirmation !== expected) {
    throw new Error(`Cleanup confirmation must equal: ${expected}`);
  }
  await verifyStableRelease(store, version, releasePrefix);
  await assertUnversionedBucket(store);
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

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: maintenance CLI dispatch keeps destructive modes and their explicit confirmations together.
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
  } else if (["preview-expired", "prune-expired"].includes(args.command)) {
    const protection = await getRecoveryProtection(
      process.env.GITHUB_REPOSITORY ?? "Uyoung666/ai-image-manager"
    );
    const groups = await inventory(store, releasePrefix);
    const plan = planExpiredObjects(groups, protection);
    if (args.command === "prune-expired") {
      if (args.confirmation !== "PRUNE EXPIRED RELEASE TEMPORARIES") {
        throw new Error("Explicit expired cleanup confirmation is required");
      }
      const requested = JSON.parse(await fsp.readFile(args.plan, "utf8"));
      await assertUnversionedBucket(store);
      report = {
        command: args.command,
        protection,
        result: await applyExpiredPlan(
          store,
          groups,
          protection,
          requested.plan
        ),
      };
    } else {
      report = { command: args.command, protection, plan };
    }
  } else if (args.command === "configure-multipart-lifecycle") {
    if (args.confirmation !== "ABORT RELEASE MULTIPART AFTER 1 DAY") {
      throw new Error("Lifecycle confirmation is required");
    }
    let rules = [];
    try {
      const existing = await invokeCos(
        store.client,
        "getBucketLifecycle",
        { Bucket: store.bucket, Region: store.region },
        store.requestOptions()
      );
      rules = existing.Rules ?? [];
    } catch (error) {
      if (error.statusCode !== 404) {
        throw error;
      }
    }
    const Rules = mergeMultipartLifecycle(rules, releasePrefix);
    await invokeCos(
      store.client,
      "putBucketLifecycle",
      { Bucket: store.bucket, Region: store.region, Rules },
      store.requestOptions()
    );
    report = { command: args.command, Rules };
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
      "Usage: release-cos-maintenance.mjs <inventory|prune> [options]"
    );
  }
  const outputPath = path.resolve(args.output ?? "cos-maintenance-report.json");
  await fsp.writeFile(
    outputPath,
    `${JSON.stringify(report, null, 2)}\n`,
    "utf8"
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
