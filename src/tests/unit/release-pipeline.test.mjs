// biome-ignore-all lint/performance/useTopLevelRegex: assertions keep error patterns beside their cases.
// biome-ignore-all lint/suspicious/useAwait: in-memory transport doubles implement async interfaces.
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  prepareBundle,
  readJson,
  sealBundle,
  validateSmoke,
  verifyBundle,
  writeJson,
} from "../../../scripts/release/bundle.mjs";
import { invokeCos } from "../../../scripts/release/cos.mjs";
import {
  assertNoDowngrade,
  ensureFile,
  finalizeCos,
  withPublicReleaseReads,
} from "../../../scripts/release/deploy.mjs";
import {
  validateSourceRun,
  verifyAsset,
} from "../../../scripts/release/github.mjs";
import { startLocalFeed } from "../../../scripts/release/local-feed.mjs";
import { supervise } from "../../../scripts/release/supervise.mjs";
import {
  applyExpiredPlan,
  assertUnversionedBucket,
  mergeMultipartLifecycle,
  planExpiredObjects,
} from "../../../scripts/release-cos-maintenance.mjs";
import { validateFeed } from "../../../scripts/windows-installer-smoke.mjs";

let fixtures;
const identity = {
  version: "2.2.0",
  tag: "v2.2.0",
  commit: "a".repeat(40),
  toolingCommit: "b".repeat(40),
  generatedAt: "2026-09-27T00:00:00.000Z",
};
const digest = (bytes, algorithm = "sha256") =>
  createHash(algorithm).update(bytes).digest("hex");

beforeAll(async () => {
  const parent = path.resolve(".cache", "release-tests");
  await fsp.mkdir(parent, { recursive: true });
  fixtures = await fsp.mkdtemp(path.join(parent, "pipeline-"));
});
afterAll(async () => {
  await fsp.rm(fixtures, { recursive: true, force: true });
});

async function fixture(name) {
  const make = path.join(fixtures, name, "make");
  const squirrel = path.join(make, "squirrel.windows", "x64");
  await fsp.mkdir(squirrel, { recursive: true });
  const entries = [
    ["ai-image-manager-2.1.0-full.nupkg", Buffer.alloc(90, 1)],
    ["ai-image-manager-2.2.0-full.nupkg", Buffer.alloc(100, 2)],
    ["ai-image-manager-2.2.0-delta.nupkg", Buffer.alloc(10, 3)],
  ];
  for (const [file, bytes] of entries) {
    await fsp.writeFile(path.join(squirrel, file), bytes);
  }
  await fsp.writeFile(
    path.join(squirrel, "RELEASES"),
    `${entries.map(([file, bytes]) => `${digest(bytes, "sha1")} ${file} ${bytes.length}`).join("\n")}\n`
  );
  for (const file of [
    "AI Image Manager-2.2.0 Setup.exe",
    "ai-image-manager.msi",
    "AI Image Manager-win32-x64-2.2.0.zip",
  ]) {
    await fsp.writeFile(path.join(make, file), `fixture ${file}`);
  }
  const root = path.join(fixtures, name, "bundle");
  const manifest = await prepareBundle(make, root, identity);
  return { root, manifest };
}

describe("immutable release bundle", () => {
  it("rejects duplicate manifest entries that hide an omitted file", async () => {
    const { root, manifest } = await fixture("duplicate-manifest");
    manifest.files[1] = manifest.files[0];
    await writeJson(path.join(root, "bundle.json"), manifest);
    await expect(verifyBundle(root, identity)).rejects.toThrow(
      /Unexpected or missing/
    );
  });

  it("rejects download provenance that omits an installer even when resealed", async () => {
    const { root } = await fixture("incomplete-downloads");
    const provenance = await readJson(
      path.join(root, "download", "provenance.json")
    );
    provenance.files = provenance.files.filter(
      (file) => !file.path.endsWith(".msi")
    );
    await writeJson(path.join(root, "download", "provenance.json"), provenance);
    await expect(sealBundle(root, identity)).rejects.toThrow(
      /every current release binary/
    );
  });
  it("detects a changed binary and a wrong application commit", async () => {
    const { root } = await fixture("integrity");
    await expect(verifyBundle(root, identity)).resolves.toMatchObject(identity);
    await expect(
      verifyBundle(root, { commit: "c".repeat(40) })
    ).rejects.toThrow(/commit/);
    await fsp.appendFile(
      path.join(root, "files", "ai-image-manager.msi"),
      "corrupt"
    );
    await expect(verifyBundle(root, identity)).rejects.toThrow(/hash mismatch/);
  });

  it("binds smoke evidence to the exact bundle, not just the version", () => {
    const smoke = {
      schemaVersion: 3,
      ...identity,
      setupSmoke: "passed",
      squirrelDeltaSmoke: "passed",
      msiSmoke: "passed",
      msiSmokeMode: "upgrade",
      bundleSha256: "old",
    };
    expect(() => validateSmoke(smoke, identity, "new")).toThrow(
      /different bundle/
    );
    expect(() =>
      validateSmoke({ ...smoke, msiSmoke: "failed" }, identity, "old")
    ).toThrow(/incomplete/);
  });

  it("does not accept omitted download checksums", async () => {
    const { root } = await fixture("manifest");
    const manifest = await readJson(path.join(root, "bundle.json"));
    manifest.files.pop();
    await writeJson(path.join(root, "bundle.json"), manifest);
    await expect(verifyBundle(root, identity)).rejects.toThrow(
      /Unexpected or missing/
    );
  });
});

describe("bounded COS transport", () => {
  it("rejects an SDK call that never invokes its callback and aborts its body", async () => {
    const body = Readable.from([Buffer.from("payload")]);
    await expect(
      invokeCos(
        {
          putObject(_params, _callback) {
            /* Simulate an SDK that never returns. */
          },
        },
        "putObject",
        { Key: "test", Body: body },
        { requestTimeoutMs: 20, retryCount: 0 }
      )
    ).rejects.toThrow(/timed out/);
    expect(body.destroyed).toBe(true);
  });

  it("never retries a permission error", async () => {
    let calls = 0;
    const client = {
      headObject(_params, callback) {
        calls++;
        callback(Object.assign(new Error("denied"), { statusCode: 403 }));
      },
    };
    await expect(
      invokeCos(client, "headObject", {}, { retryCount: 2 })
    ).rejects.toThrow("denied");
    expect(calls).toBe(1);
  });

  it("retries a transient disconnect within the retry budget", async () => {
    let calls = 0;
    const client = {
      headObject(_params, callback) {
        calls++;
        if (calls === 1) {
          callback(Object.assign(new Error("reset"), { code: "ECONNRESET" }));
        } else {
          callback(null, { ok: true });
        }
      },
    };
    await expect(
      invokeCos(client, "headObject", {}, { retryCount: 1, retryDelayMs: 0 })
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it("kills a worker that has no progress instead of leaving sockets alive", async () => {
    await expect(
      supervise(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
        timeoutMs: 2000,
        idleMs: 200,
      })
    ).rejects.toThrow(/no progress/);
  }, 10_000);

  it("aborts a hung multipart session on supervisor cancellation before killing the worker", async () => {
    const file = path.join(fixtures, "cancel-payload.bin");
    const marker = path.join(fixtures, "cancel-aborted.txt");
    const script = path.join(fixtures, "cancel-worker.mjs");
    await fsp.writeFile(file, Buffer.alloc(100));
    const moduleUrl = pathToFileURL(
      path.resolve("scripts/release/cos.mjs")
    ).href;
    await fsp.writeFile(
      script,
      `
      import fs from 'node:fs';
      import { CosStore, cancelCosRequests } from ${JSON.stringify(moduleUrl)};
      process.on('message', message => cancelCosRequests(message.reason));
      const client = {
        headObject(p, cb) { cb({statusCode:404}); },
        multipartInit(p, cb) { cb(null, {UploadId:'test-upload'}); },
        multipartUpload(p, cb) {},
        multipartComplete(p, cb) {},
        multipartAbort(p, cb) { fs.writeFileSync(${JSON.stringify(marker)}, 'aborted'); cb(null, {}); }
      };
      const store = new CosStore({client, bucket:'test', region:'test', sliceSize:10, retryCount:0});
      try { await store.putFile('release/package', ${JSON.stringify(file)}); } catch { process.exit(1); }
    `
    );
    await expect(
      supervise(process.execPath, [script], { idleMs: 500, timeoutMs: 5000 })
    ).rejects.toThrow(/no progress/);
    expect(await fsp.readFile(marker, "utf8")).toBe("aborted");
  }, 10_000);

  it("three retries upload one immutable object and reject different content", async () => {
    const objects = new Map();
    let uploads = 0;
    const store = {
      async head(key) {
        return objects.get(key);
      },
      async putFile(key, _file, record) {
        uploads++;
        objects.set(key, record);
      },
    };
    const record = { size: 3, sha256: digest("abc"), sourcePath: "unused" };
    const verify = async () => {
      /* Public delivery is modeled as verified. */
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      await ensureFile(store, "release/file", record, verify);
    }
    expect(objects.size).toBe(1);
    expect(uploads).toBe(1);
    await expect(
      ensureFile(
        store,
        "release/file",
        { ...record, sha256: digest("def") },
        verify
      )
    ).rejects.toThrow(/conflict/);
  });
});

describe("local installer feed", () => {
  it("serves packages but denies unrelated files and traversal", async () => {
    const { root } = await fixture("server");
    const server = await startLocalFeed(path.join(root, "files"));
    try {
      expect(
        (await fetch(`${server.url}/ai-image-manager-2.2.0-full.nupkg`)).status
      ).toBe(200);
      expect((await fetch(`${server.url}/ai-image-manager.msi`)).status).toBe(
        404
      );
      expect((await fetch(`${server.url}/..%2fbundle.json`)).status).toBe(404);
      expect(
        (
          await fetch(`${server.url}/ai-image-manager-2.2.0-full.nupkg`, {
            method: "POST",
          })
        ).status
      ).toBe(405);
    } finally {
      await server.close();
    }
  });
  it("allows HTTP only with explicit local mode and a literal loopback host", () => {
    expect(validateFeed("http://127.0.0.1:1234", true)).toContain("127.0.0.1");
    for (const url of [
      "http://localhost:1234",
      "http://example.com",
      "http://127.0.0.1.example.com",
      "http://user@127.0.0.1",
    ]) {
      expect(() => validateFeed(url, true)).toThrow(/HTTPS/);
    }
    expect(() => validateFeed("http://127.0.0.1:1234", false)).toThrow(/HTTPS/);
  });
});

describe("publication and recovery", () => {
  it("reads only public production objects and propagates permission failures", async () => {
    const store = withPublicReleaseReads(
      { bucket: "test", region: "test" },
      async () => new Response(null, { status: 403 })
    );
    await expect(
      store.head("app/updates/win32/x64/testing/runs/1/RELEASES")
    ).rejects.toThrow(/restricted/);
    await expect(
      store.head("app/updates/win32/x64/stable/RELEASES")
    ).rejects.toThrow(/403/);
  });
  it("refuses to recover a run with failed installer tests", () => {
    const run = {
      path: ".github/workflows/publish.yaml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "failure",
    };
    const names = [
      "Save immutable release bundle",
      "Attest release bundle",
      "Save installer smoke evidence",
    ];
    const jobs = [
      { steps: names.map((name) => ({ name, conclusion: "success" })) },
    ];
    expect(validateSourceRun(run, jobs)).toEqual({ modern: true });
    jobs[0].steps[2].conclusion = "skipped";
    expect(() => validateSourceRun(run, jobs)).toThrow(/smoke evidence/);
  });

  it("rejects a same-name GitHub asset with a different digest", async () => {
    await expect(
      verifyAsset(
        { size: 3, state: "uploaded", digest: `sha256:${digest("def")}` },
        { name: "package", size: 3, sha256: digest("abc") }
      )
    ).rejects.toThrow(/digest mismatch/);
  });

  it("does not switch stable if any referenced package cannot be verified", async () => {
    const { root, manifest } = await fixture("pointer");
    const writes = [];
    const store = {
      async head() {
        return null;
      },
      async putMutableBytes(key) {
        writes.push(key);
      },
    };
    await expect(
      finalizeCos(store, root, manifest, "app", async () => {
        throw new Error("unreadable package");
      })
    ).rejects.toThrow(/unreadable/);
    expect(writes).toEqual([]);
  });

  it("switches stable last and rejects downgrade", async () => {
    const { root, manifest } = await fixture("ordering");
    const writes = [];
    const store = {
      async head() {
        return null;
      },
      async putMutableBytes(key) {
        writes.push(key);
      },
    };
    await finalizeCos(store, root, manifest, "app", async () => {
      /* All referenced files are readable. */
    });
    expect(writes).toEqual([
      "app/updates/win32/x64/build-base/RELEASES",
      "app/updates/win32/x64/stable/RELEASES",
    ]);
    expect(() =>
      assertNoDowngrade(
        `${"a".repeat(40)} ai-image-manager-2.3.0-full.nupkg 100\n`,
        "2.2.0"
      )
    ).toThrow(/newer/);
  });
});

describe("temporary storage retention", () => {
  it("refuses enabled and suspended versioning before cleanup", async () => {
    for (const Status of ["Enabled", "Suspended"]) {
      const store = {
        client: {
          getBucketVersioning(_params, callback) {
            callback(null, { Status });
          },
        },
        requestOptions: () => ({ retryCount: 0 }),
      };
      await expect(assertUnversionedBucket(store)).rejects.toThrow(
        /Versioned bucket/
      );
    }
  });
  const prefix = "app/updates/win32/x64/testing/runs/";
  const old = {
    key: `${prefix}10/file.nupkg`,
    size: 100,
    lastModified: "2026-01-01",
    etag: '"old"',
  };
  const groups = {
    testing: {
      prefix,
      objects: [
        old,
        { ...old, key: `${prefix}10/data.csv` },
        { ...old, key: `${prefix}10/Temp/file.nupkg` },
      ],
    },
  };
  it("protects active runs, recovery references and user files", () => {
    expect(planExpiredObjects(groups, { activeRelease: true }).objects).toEqual(
      []
    );
    expect(
      planExpiredObjects(groups, { protectedRunIds: ["10"] }).objects
    ).toEqual([]);
    expect(planExpiredObjects(groups).objects).toEqual([old]);
    expect(
      planExpiredObjects({
        testing: {
          prefix,
          objects: [{ ...old, lastModified: new Date().toISOString() }],
        },
      }).objects
    ).toEqual([]);
  });
  it("refuses stale plans before deleting any object", async () => {
    const deleted = [];
    const store = {
      async delete(key) {
        deleted.push(key);
      },
    };
    await expect(
      applyExpiredPlan(
        store,
        groups,
        {},
        { objects: [{ ...old, etag: '"changed"' }] }
      )
    ).rejects.toThrow(/stale/);
    expect(deleted).toEqual([]);
  });
  it("preserves unrelated lifecycle rules and only expires incomplete uploads", () => {
    const original = {
      ID: "user-rule",
      Status: "Enabled",
      Filter: { Prefix: "user/" },
    };
    const rules = mergeMultipartLifecycle([original], "app");
    expect(rules[0]).toEqual(original);
    expect(
      rules
        .slice(1)
        .every(
          (rule) =>
            rule.AbortIncompleteMultipartUpload.DaysAfterInitiation === 1 &&
            !rule.Expiration
        )
    ).toBe(true);
    expect(mergeMultipartLifecycle(rules, "app")).toEqual(rules);
  });
});
