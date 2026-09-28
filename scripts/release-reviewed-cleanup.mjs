import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosStoreFromEnv, invokeCos } from "./release/cos.mjs";
import { api, command, exactArtifact, findRelease } from "./release/github.mjs";
import { assertImmutableObject } from "./release/semver.mjs";
import { parseReleases } from "./release/squirrel.mjs";
import {
  assertTemporaryCleanupKey,
  assertUnversionedBucket,
  buildTemporaryCleanupTargets,
  inventory,
  summarizeObjects,
} from "./release-cos-maintenance.mjs";

const RUN_ID = /^[1-9]\d*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const RELEASE_WORKFLOWS = new Set([
  ".github/workflows/publish.yaml",
  ".github/workflows/promote-release.yaml",
  ".github/workflows/recover-release-candidate.yaml",
]);
const REPORT = "cos-reviewed-cleanup.json";

export function selectReviewedObjects(snapshot, current, targets) {
  const previous = new Map(
    Object.values(snapshot).flatMap((group) =>
      group.objects.map((object) => [object.key, object])
    )
  );
  const selected = [];
  for (const group of Object.values(current)) {
    for (const object of group.objects) {
      if (!targets.some((prefix) => object.key.startsWith(prefix))) {
        continue;
      }
      assertTemporaryCleanupKey(object.key, targets);
      const old = previous.get(object.key);
      assert.deepEqual(
        object,
        old,
        `Object changed since review: ${object.key}`
      );
      assert(object.etag && Number.isSafeInteger(object.size));
      selected.push(object);
    }
  }
  return selected;
}

export function assertCompletedRuns(runs, ids) {
  assert(ids.length > 0, "Explicit reviewed run IDs are required");
  assert(
    !runs.some(
      (run) => RELEASE_WORKFLOWS.has(run.path) && run.status !== "completed"
    ),
    "A release or recovery is still active"
  );
  for (const id of ids) {
    const run = runs.find((item) => String(item.id) === id);
    assert(
      run?.path === ".github/workflows/publish.yaml" &&
        run.status === "completed",
      `Reviewed release run is missing or active: ${id}`
    );
  }
}

async function cos(store, method, params = {}) {
  return await invokeCos(
    store.client,
    method,
    { Bucket: store.bucket, Region: store.region, ...params },
    store.requestOptions()
  );
}

export async function listMultipart(store, prefix) {
  const uploads = [];
  let marker = {};
  while (true) {
    const page = await cos(store, "multipartList", {
      Prefix: prefix,
      MaxUploads: 1000,
      ...marker,
    });
    for (const item of page.Upload ?? []) {
      const parts = [];
      let partMarker;
      while (true) {
        const result = await cos(store, "multipartListPart", {
          Key: item.Key,
          UploadId: item.UploadId,
          MaxParts: 1000,
          PartNumberMarker: partMarker,
        });
        parts.push(...(result.Part ?? []));
        if (String(result.IsTruncated) !== "true") {
          break;
        }
        assert(result.NextPartNumberMarker !== partMarker);
        assert(result.NextPartNumberMarker);
        partMarker = result.NextPartNumberMarker;
      }
      uploads.push({
        key: item.Key,
        uploadId: item.UploadId,
        initiated: item.Initiated,
        size: parts.reduce((sum, part) => sum + Number(part.Size), 0),
        parts,
      });
    }
    if (String(page.IsTruncated) !== "true") {
      return uploads;
    }
    const next = {
      KeyMarker: page.NextKeyMarker,
      UploadIdMarker: page.NextUploadIdMarker,
    };
    assert(next.KeyMarker && next.UploadIdMarker);
    assert.notDeepEqual(next, marker);
    marker = next;
  }
}

export function selectAbandonedUploads(uploads, targets, now = Date.now()) {
  return uploads.filter((upload) => {
    if (
      !(
        targets.some((prefix) => upload.key.startsWith(prefix)) &&
        Date.parse(upload.initiated) < now - 86_400_000
      )
    ) {
      return false;
    }
    try {
      assertTemporaryCleanupKey(upload.key, targets);
      return true;
    } catch {
      return false;
    }
  });
}

async function verifyPublished(
  store,
  repository,
  version,
  releaseRunId,
  prefix
) {
  const run = await api(`repos/${repository}/actions/runs/${releaseRunId}`);
  assert(run.path === ".github/workflows/publish.yaml");
  assert(run.status === "completed" && run.conclusion === "success");
  const { artifacts } = await api(
    `repos/${repository}/actions/runs/${releaseRunId}/artifacts?per_page=100`
  );
  const bundle = exactArtifact(artifacts, `release-bundle-${version}`);
  const smoke = exactArtifact(artifacts, `release-smoke-${version}`);
  const release = await findRelease(repository, `v${version}`);
  assert(release && !release.draft && release.published_at);
  const stable = `${prefix}/updates/win32/x64/stable/`;
  const entries = parseReleases(
    (await store.getBytes(`${stable}RELEASES`)).toString("utf8")
  );
  assert(
    entries.some((entry) => entry.filename.endsWith(`-${version}-full.nupkg`))
  );
  for (const entry of entries.filter((item) =>
    item.filename.includes(`-${version}-`)
  )) {
    const asset = release.assets.find((item) => item.name === entry.filename);
    assert(asset?.digest?.startsWith("sha256:") && asset.size === entry.size);
    assertImmutableObject(await store.head(`${stable}${entry.filename}`), {
      sha256: asset.digest.slice(7),
      size: asset.size,
    });
  }
  return { releaseRunId, releaseUrl: release.html_url, bundle, smoke };
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  const version = process.env.REVIEW_VERSION;
  const sourceId = process.env.REVIEW_INVENTORY_RUN;
  const releaseId = process.env.REVIEW_RELEASE_RUN;
  const ids = (process.env.REVIEW_RUN_IDS ?? "").split(",");
  assert(VERSION.test(version));
  assert(RUN_ID.test(sourceId) && RUN_ID.test(releaseId));
  assert(ids.every((id) => RUN_ID.test(id)));
  assert(new Set(ids).size === ids.length);
  const prefix = process.env.COS_RELEASE_PREFIX;
  assert(prefix === "ai-image-manager", "Explicit application scope required");
  const store = createCosStoreFromEnv();
  const source = await api(`repos/${repository}/actions/runs/${sourceId}`);
  assert(source.path === ".github/workflows/maintain-release-storage.yaml");
  assert(source.status === "completed" && source.conclusion === "success");
  const destination = path.resolve("out", `reviewed-inventory-${sourceId}`);
  try {
    await fsp.access(destination);
  } catch {
    await command("gh", [
      "run",
      "download",
      sourceId,
      "--repo",
      repository,
      "--name",
      `cos-maintenance-${sourceId}`,
      "--dir",
      destination,
    ]);
  }
  const snapshot = JSON.parse(
    await fsp.readFile(
      path.join(destination, "cos-maintenance-report.json"),
      "utf8"
    )
  );
  assert(snapshot.bucket === store.bucket && snapshot.region === store.region);
  assert(snapshot.command === "inventory");
  const pages = JSON.parse(
    await command("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs?per_page=100`,
    ])
  );
  assertCompletedRuns(
    pages.flatMap((page) => page.workflow_runs),
    ids
  );
  await assertUnversionedBucket(store);
  const publication = await verifyPublished(
    store,
    repository,
    version,
    releaseId,
    prefix
  );
  const targets = [
    ...new Set(
      ids.flatMap((runId) =>
        buildTemporaryCleanupTargets({ version, runId, releasePrefix: prefix })
      )
    ),
  ];
  const before = await inventory(store, prefix);
  const objects = selectReviewedObjects(snapshot.groups, before, targets);
  const uploads = await listMultipart(store, `${prefix}/`);
  const abandoned = selectAbandonedUploads(uploads, targets);
  const report = {
    sourceId,
    version,
    ids,
    targets,
    publication,
    planned: summarizeObjects(objects),
    objects,
    uploads,
    abandoned,
    deleted: [],
    aborted: [],
    before,
  };
  const save = () =>
    fsp.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (process.argv[2] !== "apply") {
    await save();
    console.log(
      `Reviewed cleanup preview: ${objects.length} objects, ${report.planned.bytes} bytes; ${abandoned.length} abandoned uploads`
    );
    return;
  }
  const preview = JSON.parse(await fsp.readFile(REPORT, "utf8"));
  assert.deepEqual(objects, preview.objects, "Objects changed after preview");
  assert.deepEqual(
    abandoned,
    preview.abandoned,
    "Multipart uploads changed after preview"
  );
  for (const object of objects) {
    const head = await store.head(object.key);
    assert((head?.ETag ?? head?.headers?.etag) === object.etag);
    assert(Number(head.headers["content-length"]) === object.size);
  }
  try {
    for (const object of objects) {
      await store.delete(object.key);
      report.deleted.push(object);
      await save();
      assert.equal(await store.head(object.key), null);
    }
    for (const upload of abandoned) {
      await cos(store, "multipartAbort", {
        Key: upload.key,
        UploadId: upload.uploadId,
      });
      report.aborted.push(upload);
      await save();
    }
    report.after = await inventory(store, prefix);
    for (const name of ["stable", "buildBase", "downloads"]) {
      assert.deepEqual(
        report.after[name],
        before[name],
        `Protected ${name} changed`
      );
    }
    assert.equal(
      selectReviewedObjects(snapshot.groups, report.after, targets).length,
      0
    );
    report.remainingUploads = await listMultipart(store, `${prefix}/`);
    assert(
      !report.remainingUploads.some((upload) =>
        report.aborted.some(
          (item) => item.uploadId === upload.uploadId && item.key === upload.key
        )
      )
    );
    report.verified = true;
  } finally {
    await save();
  }
  console.log(
    `Verified cleanup: ${report.deleted.length} objects, ${summarizeObjects(report.deleted).bytes} bytes; ${report.aborted.length} multipart uploads aborted`
  );
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
