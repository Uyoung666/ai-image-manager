import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createCosStoreFromEnv } from "./release/cos.mjs";
import { command, findRelease } from "./release/github.mjs";
import { assertImmutableObject } from "./release/semver.mjs";
import { parseReleases } from "./release/squirrel.mjs";
import {
  assertUnversionedBucket,
  inventory,
  summarizeObjects,
} from "./release-cos-maintenance.mjs";

const PREFIX = "ai-image-manager";
const REPORT = "cos-old-package-cleanup.json";
const BASE = `${PREFIX}/updates/win32/x64/`;
const ACTIVE_RELEASE_PATTERN =
  /(?:publish|promote-release|recover-release-candidate)\.yaml$/;
const PROTECTED_PATTERN = /(?:^|\/)temp(?:\/|$)|\.(?:csv|xlsx)$/i;
const PLAN = new URL(
  "./release/old-release-cleanup-plan.json",
  import.meta.url
);

export function validateOldPlan(plan) {
  assert.equal(plan.objects.length, 9);
  assert.equal(new Set(plan.objects.map((o) => o.key)).size, 9);
  for (const object of plan.objects) {
    assert(!PROTECTED_PATTERN.test(object.key));
    assert(!object.key.split("/").some((s) => s === "." || s === ".."));
    assert(
      object.key.startsWith(`${PREFIX}/downloads/2.1.0/`) ||
        object.key === `${BASE}stable/ai-image-manager-2.0.0-full.nupkg` ||
        object.key === `${BASE}build-base/ai-image-manager-2.1.0-full.nupkg`
    );
    assert(Number.isSafeInteger(object.size) && object.size > 0 && object.etag);
  }
  assert.equal(summarizeObjects(plan.objects).bytes, 3_293_815_066);
}

export function selectOldObjects(plan, groups, references) {
  validateOldPlan(plan);
  const current = new Map(
    Object.values(groups).flatMap((g) => g.objects.map((o) => [o.key, o]))
  );
  const objects = [];
  for (const expected of plan.objects) {
    assert(
      !references.has(expected.key),
      `Update feed still references ${expected.key}`
    );
    const actual = current.get(expected.key);
    if (actual) {
      assert.deepEqual(
        actual,
        expected,
        `Reviewed object changed: ${expected.key}`
      );
      objects.push(actual);
    }
  }
  return objects;
}

async function feeds(store) {
  const pointers = {};
  const references = new Set();
  for (const name of ["stable", "build-base"]) {
    const key = `${BASE}${name}/RELEASES`;
    const body = (await store.getBytes(key)).toString("utf8");
    const entries = parseReleases(body);
    assert(
      entries.some((e) => e.filename === "ai-image-manager-2.2.0-full.nupkg")
    );
    for (const entry of entries) {
      const referenced = `${BASE}${name}/${entry.filename}`;
      references.add(referenced);
      const head = await store.head(referenced);
      assert(
        head && Number(head.headers["content-length"]) === entry.size,
        `Feed package missing: ${referenced}`
      );
    }
    pointers[key] = body;
  }
  return { pointers, references };
}

async function assertIdle(repository) {
  const pages = JSON.parse(
    await command("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/actions/runs?per_page=100`,
    ])
  );
  assert(
    !pages
      .flatMap((p) => p.workflow_runs)
      .some(
        (r) => ACTIVE_RELEASE_PATTERN.test(r.path) && r.status !== "completed"
      ),
    "Release or recovery is running"
  );
}

async function main() {
  const mode = process.argv[2];
  assert(["preview", "apply"].includes(mode));
  const repository = process.env.GITHUB_REPOSITORY;
  assert.equal(repository, "Uyoung666/ai-image-manager");
  const store = createCosStoreFromEnv();
  assert.equal(store.bucket, "ai-image-manager-1392398678");
  assert.equal(store.region, "ap-hongkong");
  await assertIdle(repository);
  await assertUnversionedBucket(store);
  const plan = JSON.parse(await fsp.readFile(PLAN, "utf8"));
  const feed = await feeds(store);
  const before = await inventory(store, PREFIX);
  const objects = selectOldObjects(plan, before, feed.references);
  const archives = {};
  for (const version of ["2.0.0", "2.1.0"]) {
    const release = await findRelease(repository, `v${version}`);
    assert(release && !release.draft && release.published_at);
    archives[version] = release;
  }
  for (const object of objects) {
    const version = object.key.includes("2.0.0") ? "2.0.0" : "2.1.0";
    const name = object.key.split("/").at(-1).replaceAll(" ", ".");
    const asset = archives[version].assets.find((a) => a.name === name);
    assert(
      asset &&
        asset.size === object.size &&
        asset.digest?.startsWith("sha256:"),
      `Archive missing: ${name}`
    );
    const head = await store.head(object.key);
    assert(head && (head.ETag ?? head.headers.etag) === object.etag);
    assertImmutableObject(head, {
      sha256: asset.digest.slice(7),
      size: asset.size,
    });
  }
  const report = {
    before,
    pointers: feed.pointers,
    objects,
    planned: summarizeObjects(objects),
    deleted: [],
    archiveUrls: Object.values(archives).map((r) => r.html_url),
  };
  const save = () =>
    fsp.writeFile(REPORT, `${JSON.stringify(report, null, 2)}\n`);
  if (mode === "preview") {
    await save();
    console.log(
      `Verified old-package plan: ${objects.length} objects, ${report.planned.bytes} bytes`
    );
    return;
  }
  const preview = JSON.parse(await fsp.readFile(REPORT, "utf8"));
  assert.deepEqual(objects, preview.objects);
  assert.deepEqual(feed.pointers, preview.pointers);
  await assertIdle(repository);
  try {
    for (const object of objects) {
      const head = await store.head(object.key);
      assert(head && (head.ETag ?? head.headers.etag) === object.etag);
      assert(Number(head.headers["content-length"]) === object.size);
      await store.delete(object.key);
      report.deleted.push(object);
      await save();
      assert.equal(await store.head(object.key), null);
    }
    report.after = await inventory(store, PREFIX);
    const removed = new Set(objects.map((o) => o.key));
    for (const [name, group] of Object.entries(before)) {
      assert.deepEqual(
        report.after[name].objects,
        group.objects.filter((o) => !removed.has(o.key)),
        `Unexpected change in ${name}`
      );
    }
    assert.deepEqual((await feeds(store)).pointers, feed.pointers);
    report.verified = true;
  } finally {
    await save();
  }
  console.log(
    `Deleted and verified ${report.deleted.length} old objects, ${summarizeObjects(report.deleted).bytes} bytes`
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
