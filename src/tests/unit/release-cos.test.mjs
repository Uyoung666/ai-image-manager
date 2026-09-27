// biome-ignore-all lint/performance/useTopLevelRegex: test assertions intentionally keep patterns next to expectations.
// biome-ignore-all lint/suspicious/useAwait: fake store methods model async COS methods while remaining synchronous in memory.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  collectByteRecords,
  collectFileRecords,
  formatSha256Sums,
  verifySha256Sums,
} from "../../../scripts/release/checksums.mjs";
import {
  CosStore,
  createCosStoreFromEnv,
  formatCopySource,
} from "../../../scripts/release/cos.mjs";
import {
  prefixForKind,
  prepareReleaseArtifacts,
  promoteRelease,
  uploadRelease,
  verifyRelease,
} from "../../../scripts/release/operations.mjs";
import {
  assertImmutableObject,
  validateReleaseGuard,
} from "../../../scripts/release/semver.mjs";
import {
  filterReleaseManifest,
  formatGitHubReleases,
  formatReleases,
  parseReleases,
  selectProductionReleases,
} from "../../../scripts/release/squirrel.mjs";
import {
  commandRequiresReleases,
  HELP_TEXT,
  parseCliArgs,
  runCli,
} from "../../../scripts/release-cos.mjs";

let fixtureRoot;

function sha1(value) {
  return createHash("sha1").update(value).digest("hex");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

class MemoryStore {
  constructor() {
    this.objects = new Map();
    this.calls = [];
  }

  async head(key) {
    this.calls.push({ method: "head", key });
    return this.objects.get(key)?.head ?? null;
  }

  async putBytes(key, value, options = {}) {
    const data = Buffer.from(value);
    this.calls.push({ method: "put", key, data, options });
    this.objects.set(key, {
      data,
      head: {
        sha256: options.sha256 ?? sha256(data),
        size: data.byteLength,
        headers: {
          "x-cos-meta-sha256": options.sha256 ?? sha256(data),
          "content-length": String(data.byteLength),
        },
      },
    });
    return { status: "uploaded", key };
  }

  async putMutableBytes(key, value, options = {}) {
    return this.putBytes(key, value, { ...options, immutable: false });
  }

  async getBytes(key) {
    this.calls.push({ method: "get", key });
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`missing ${key}`);
    }
    return object.data;
  }

  async copy(source, destination, options = {}) {
    this.calls.push({ method: "copy", source, key: destination, options });
    const object = this.objects.get(source);
    if (!object) {
      throw new Error(`missing ${source}`);
    }
    this.objects.set(destination, {
      data: object.data,
      head: {
        ...object.head,
        sha256: options.sha256 ?? object.head.sha256,
        headers: {
          ...object.head.headers,
          "x-cos-meta-sha256": options.sha256 ?? object.head.sha256,
          "content-length": String(object.data.byteLength),
        },
      },
    });
    return { status: "copied", key: destination };
  }
}

class StreamingMemoryStore extends MemoryStore {
  async hashObject(key) {
    const object = this.objects.get(key);
    if (!object) {
      throw new Error(`missing ${key}`);
    }
    return {
      size: object.data.byteLength,
      sha1: sha1(object.data),
      sha256: sha256(object.data),
    };
  }

  async getBytes(key) {
    if (key.endsWith(".nupkg")) {
      throw new Error("promotion must not buffer package bytes");
    }
    return super.getBytes(key);
  }
}

class FakeCosSdk {
  constructor() {
    this.objects = new Map();
    this.multipartUploads = new Map();
    this.calls = [];
    this.failPutCount = 0;
    this.denyHead = false;
  }

  headObject(params, callback) {
    this.calls.push({ method: "headObject", params });
    if (this.denyHead) {
      callback(Object.assign(new Error("forbidden"), { statusCode: 403 }));
      return;
    }
    const object = this.objects.get(params.Key);
    if (!object) {
      callback(Object.assign(new Error("missing"), { statusCode: 404 }));
      return;
    }
    callback(null, {
      headers: {
        "content-length": String(object.data.byteLength),
        "x-cos-meta-sha256": object.sha256,
      },
    });
  }

  uploadFile(params, callback) {
    this.calls.push({ method: "uploadFile", params });
    fsp
      .readFile(params.FilePath)
      .then((data) => {
        this.objects.set(params.Key, {
          data,
          sha256: params.Headers["x-cos-meta-sha256"],
        });
        callback(null, { statusCode: 200 });
      })
      .catch(callback);
  }

  putObject(params, callback) {
    this.calls.push({ method: "putObject", params });
    if (this.failPutCount > 0) {
      this.failPutCount -= 1;
      callback(Object.assign(new Error("temporary"), { statusCode: 503 }));
      return;
    }
    if (
      this.objects.has(params.Key) &&
      params.Headers["x-cos-forbid-overwrite"] === "true"
    ) {
      callback(
        Object.assign(new Error("conflict"), {
          statusCode: 409,
          error: { Code: "FileAlreadyExists" },
        })
      );
      return;
    }
    const chunks = [];
    const body = params.Body;
    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      chunks.push(Buffer.from(body));
      this.savePut(params, Buffer.concat(chunks));
      callback(null, { statusCode: 200 });
      return;
    }
    body.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    body.on("error", callback);
    body.on("end", () => {
      this.savePut(params, Buffer.concat(chunks));
      callback(null, { statusCode: 200 });
    });
  }

  multipartInit(params, callback) {
    this.calls.push({ method: "multipartInit", params });
    const uploadId = `upload-${this.multipartUploads.size + 1}`;
    this.multipartUploads.set(uploadId, {
      key: params.Key,
      headers: params.Headers,
      parts: new Map(),
    });
    callback(null, { UploadId: uploadId, statusCode: 200 });
  }

  multipartUpload(params, callback) {
    this.calls.push({ method: "multipartUpload", params });
    const upload = this.multipartUploads.get(params.UploadId);
    const chunks = [];
    params.Body.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    params.Body.on("error", callback);
    params.Body.on("end", () => {
      upload.parts.set(params.PartNumber, Buffer.concat(chunks));
      callback(null, { ETag: `part-${params.PartNumber}`, statusCode: 200 });
    });
  }

  multipartComplete(params, callback) {
    this.calls.push({ method: "multipartComplete", params });
    const upload = this.multipartUploads.get(params.UploadId);
    const data = Buffer.concat(
      params.Parts.map(({ PartNumber }) => upload.parts.get(PartNumber))
    );
    this.objects.set(upload.key, {
      data,
      sha256: params.Headers["x-cos-meta-sha256"],
    });
    this.multipartUploads.delete(params.UploadId);
    callback(null, { statusCode: 200 });
  }

  multipartAbort(params, callback) {
    this.calls.push({ method: "multipartAbort", params });
    this.multipartUploads.delete(params.UploadId);
    callback(null, { statusCode: 204 });
  }

  putObjectCopy(params, callback) {
    this.calls.push({ method: "putObjectCopy", params });
    const sourceKey = decodeCopySourceKey(params.CopySource);
    const object = this.objects.get(sourceKey);
    if (!object) {
      callback(Object.assign(new Error("missing source"), { statusCode: 404 }));
      return;
    }
    this.objects.set(params.Key, { ...object });
    callback(null, { statusCode: 200 });
  }

  getObject(params, callback) {
    const object = this.objects.get(params.Key);
    if (!object) {
      callback(Object.assign(new Error("missing"), { statusCode: 404 }));
      return;
    }
    callback(null, {
      Body: object.data,
      headers: {
        "content-length": String(object.data.byteLength),
        "x-cos-meta-sha256": object.sha256,
      },
    });
  }

  getObjectStream(params, callback) {
    const object = this.objects.get(params.Key);
    const stream = object ? Readable.from([object.data]) : Readable.from([]);
    queueMicrotask(() => {
      if (!object) {
        callback(Object.assign(new Error("missing"), { statusCode: 404 }));
        return;
      }
      callback(null, {
        headers: {
          "content-length": String(object.data.byteLength),
          "x-cos-meta-sha256": object.sha256,
        },
      });
    });
    return stream;
  }

  savePut(params, data) {
    this.objects.set(params.Key, {
      data,
      sha256: params.Headers["x-cos-meta-sha256"],
    });
  }
}

function decodeCopySourceKey(copySource) {
  return decodeURIComponent(copySource.slice(copySource.indexOf("/") + 1));
}

async function readWorkflowStep(file, name) {
  const source = (
    await fsp.readFile(path.resolve(".github/workflows", file), "utf8")
  ).replaceAll("\r\n", "\n");
  const step = source
    .split(`      - name: ${name}`)[1]
    ?.split("      - name:")[0];
  expect(step).toBeDefined();
  return step
    .split("        run: |\n")[1]
    .split("\n")
    .map((line) => line.slice(10))
    .join("\n");
}

function runPowerShellStep(script, env, preamble) {
  const wrapped = `$ErrorActionPreference = 'Stop'\n${preamble}\n${script}\nif (Test-Path variable:LASTEXITCODE) { exit $LASTEXITCODE }`;
  return spawnSync(
    "pwsh",
    [
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(wrapped, "utf16le").toString("base64"),
    ],
    { env: { ...process.env, ...env }, encoding: "utf8", timeout: 10_000 }
  );
}

beforeAll(async () => {
  fixtureRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "aim-release-cos-"));
});

afterAll(async () => {
  await fsp.rm(fixtureRoot, { recursive: true, force: true });
});

describe.skipIf(process.platform !== "win32")(
  "candidate PowerShell handoff",
  () => {
    it.each([
      { status: 404, release: null, success: true },
      {
        status: 200,
        release: { tag_name: "v2.2.0", prerelease: true },
        success: true,
      },
      {
        status: 200,
        release: { tag_name: "v2.2.0", draft: true },
        success: true,
      },
      {
        status: 200,
        release: { tag_name: "v2.2.0", prerelease: false },
        success: false,
      },
      {
        status: 200,
        release: { tag_name: "v2.1.0", prerelease: true },
        success: false,
      },
      { status: 401, release: null, success: false },
      { status: 403, release: null, success: false },
      { status: 500, release: null, success: false },
      { status: "timeout", release: null, success: false },
    ])("handles $status / $release without hiding API failures", async ({
      status,
      release,
      success,
    }) => {
      const script = await readWorkflowStep(
        "publish.yaml",
        "Report GitHub prerelease handoff"
      );
      const result = runPowerShellStep(
        script,
        {
          GITHUB_REPOSITORY: "example/repository",
          RELEASE_TAG: "v2.2.0",
          GH_TOKEN: "test-token",
          AIM_TEST_HTTP_STATUS: String(status),
          AIM_TEST_RELEASE_JSON: JSON.stringify(release),
        },
        `
function gh { throw "The handoff must use the authenticated HTTP request" }
function Invoke-WebRequest {
  param($Uri, $Headers, $Method, [switch]$SkipHttpErrorCheck, $TimeoutSec)
  if ($Headers.Authorization -ne 'Bearer test-token' -or $TimeoutSec -ne 60 -or -not $SkipHttpErrorCheck) { throw 'Invalid request configuration' }
  if ($env:AIM_TEST_HTTP_STATUS -eq 'timeout') { throw 'Simulated network timeout' }
  return @{ StatusCode = [int]$env:AIM_TEST_HTTP_STATUS; Content = $env:AIM_TEST_RELEASE_JSON }
}`
      );
      expect(result.error).toBeUndefined();
      expect(result.status === 0, result.stderr || result.stdout).toBe(success);
    });

    it.each([
      {
        failedStep: "Report GitHub prerelease handoff",
        sourceConclusion: "failure",
        success: true,
      },
      {
        failedStep: "Upload candidate to COS testing",
        sourceConclusion: "cancelled",
        success: false,
      },
      {
        failedStep: "Run MSI install or auto-update smoke",
        sourceConclusion: "failure",
        success: false,
      },
      {
        failedStep: "Attest candidate artifacts",
        sourceConclusion: "failure",
        success: false,
      },
    ])("recovers only a fully verified candidate: $failedStep", async ({
      failedStep,
      sourceConclusion,
      success,
    }) => {
      const required = [
        "Gate - static check",
        "Gate - unit tests",
        "Upload candidate to COS testing",
        "Run Squirrel Setup.exe upgrade smoke",
        "Run MSI install or auto-update smoke",
        "Write candidate smoke evidence",
        "Upload Squirrel candidate to COS candidate prefix",
        "Upload immutable versioned download payload to COS",
        "Upload candidate build for promotion",
        "Generate SHA256 release manifest",
        "Attest candidate artifacts",
        "Attest flat download and checksum artifacts",
        "Upload candidate evidence",
        "Report GitHub prerelease handoff",
      ];
      const script = await readWorkflowStep(
        "recover-release-candidate.yaml",
        "Validate failed source run and completed release gates"
      );
      const result = runPowerShellStep(
        script,
        {
          VERSION_INPUT: "2.2.0",
          SOURCE_RUN_ID: "36282664740",
          CONFIRMATION: "RECOVER 2.2.0",
          GITHUB_REPOSITORY: "example/repository",
          GITHUB_OUTPUT: path.join(
            fixtureRoot,
            `recovery-${required.indexOf(failedStep)}.txt`
          ),
          AIM_TEST_SOURCE_RUN: JSON.stringify({
            path: ".github/workflows/publish.yaml",
            status: "completed",
            conclusion: sourceConclusion,
          }),
          AIM_TEST_JOBS: JSON.stringify({
            jobs: [
              {
                steps: required.map((name) => ({
                  name,
                  conclusion: name === failedStep ? "failure" : "success",
                })),
              },
            ],
          }),
        },
        `
function git { if ($args[0] -eq 'rev-list') { return 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' } }
function gh { if ($args[1].Contains('/jobs?')) { return $env:AIM_TEST_JOBS }; return $env:AIM_TEST_SOURCE_RUN }
`
      );
      expect(result.error).toBeUndefined();
      expect(result.status === 0, result.stderr || result.stdout).toBe(success);
    });
  }
);

describe("release version guard", () => {
  const packageJson = { version: "2.1.0" };
  const packageLock = {
    version: "2.1.0",
    packages: { "": { version: "2.1.0" } },
  };

  it("enforces tag, package-lock and newer stable version", () => {
    expect(
      validateReleaseGuard({
        packageJson,
        packageLock,
        tag: "refs/tags/v2.1.0",
        latestStableVersion: "2.0.9",
      })
    ).toMatchObject({ version: "2.1.0", tag: "v2.1.0" });
    expect(() =>
      validateReleaseGuard({
        packageJson,
        packageLock,
        tag: "v2.0.0",
        latestStableVersion: "2.0.9",
      })
    ).toThrow(/tag/i);
    expect(() =>
      validateReleaseGuard({
        packageJson,
        packageLock: { version: "2.0.0" },
        tag: "v2.1.0",
        latestStableVersion: "2.0.9",
      })
    ).toThrow(/package-lock/i);
    expect(() =>
      validateReleaseGuard({
        packageJson,
        packageLock,
        tag: "v2.1.0",
        latestStableVersion: "2.1.0",
      })
    ).toThrow(/newer/i);
    expect(() =>
      validateReleaseGuard({
        packageJson: { version: "2.1.0-rc.1" },
        packageLock,
        tag: "v2.1.0-rc.1",
      })
    ).toThrow(/stable SemVer/i);
  });

  it("allows only an exact immutable retry", () => {
    const hash = "a".repeat(64);
    expect(
      assertImmutableObject(
        { sha256: hash, size: 42 },
        { sha256: hash, size: 42 }
      )
    ).toMatchObject({ status: "idempotent" });
    expect(() =>
      assertImmutableObject(
        { sha256: hash, size: 42 },
        { sha256: "b".repeat(64), size: 42 }
      )
    ).toThrow(/immutable object conflict/i);
  });
});

describe("CosStore SDK v3 boundary", () => {
  it("bounds stalled real SDK sockets and retries with a complete new body", async () => {
    const payload = Buffer.from("release body must survive a timed-out upload");
    const filePath = path.join(fixtureRoot, "stalled-upload.bin");
    await fsp.writeFile(filePath, payload);
    const received = [];
    const server = createServer((request, response) => {
      if (request.method === "HEAD") {
        response.writeHead(404).end();
        return;
      }
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        received.push(Buffer.concat(chunks));
        // Deliberately leave the first request unanswered, like a stalled COS
        // connection. The real SDK must abort it before the outer retry runs.
        if (received.length > 1) {
          response.writeHead(200).end();
        }
      });
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const store = createCosStoreFromEnv(
        {
          COS_SECRET_ID: "local-test-id",
          COS_SECRET_KEY: "local-test-key",
          COS_BUCKET: "bucket-1250000000",
          COS_REGION: "ap-hongkong",
          COS_PROTOCOL: "http:",
          COS_DOMAIN: `127.0.0.1:${server.address().port}`,
        },
        { retryCount: 1, retryDelayMs: 0 }
      );
      expect(store.client.options.Timeout).toBe(120_000);
      store.client.options.Timeout = 100;
      await expect(
        store.putFile("payload.bin", filePath)
      ).resolves.toMatchObject({
        status: "uploaded",
      });
      expect(received).toEqual([payload, payload]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("reopens consumed streams on transient failures and closes every attempt", async () => {
    const filePath = path.join(fixtureRoot, "retry-stream.bin");
    const payload = Buffer.from("retry the full file, not an exhausted stream");
    await fsp.writeFile(filePath, payload);
    const sdk = new FakeCosSdk();
    const streams = [];
    sdk.putObject = (params, callback) => {
      streams.push(params.Body);
      if (streams.length === 1) {
        params.Body.on("end", () =>
          callback(Object.assign(new Error("reset"), { code: "ECONNRESET" }))
        );
        params.Body.resume();
        return;
      }
      FakeCosSdk.prototype.putObject.call(sdk, params, callback);
    };
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryCount: 1,
      retryDelayMs: 0,
    });
    await store.putFile("payload.bin", filePath);
    expect(streams).toHaveLength(2);
    expect(streams[0]).not.toBe(streams[1]);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
    expect(sdk.objects.get("payload.bin").data).toEqual(payload);
  });

  it.each([
    { error: { code: "ESOCKETTIMEDOUT" }, attempts: 3 },
    { error: { statusCode: 403 }, attempts: 1 },
  ])("bounds upload attempts for $error", async ({ error, attempts }) => {
    const filePath = path.join(fixtureRoot, `failed-upload-${attempts}.bin`);
    await fsp.writeFile(filePath, "payload");
    const sdk = new FakeCosSdk();
    const streams = [];
    sdk.putObject = (params, callback) => {
      streams.push(params.Body);
      callback(Object.assign(new Error("upload failed"), error));
    };
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryCount: 2,
      retryDelayMs: 0,
    });
    await expect(store.putFile("payload.bin", filePath)).rejects.toThrow(
      /COS PUT payload.bin failed/
    );
    expect(streams).toHaveLength(attempts);
    expect(streams.every((stream) => stream.destroyed)).toBe(true);
  });

  it("verifies an immutable upload when the first successful response is lost", async () => {
    const filePath = path.join(fixtureRoot, "lost-response.bin");
    const payload = Buffer.from("already committed immutable bytes");
    await fsp.writeFile(filePath, payload);
    const sdk = new FakeCosSdk();
    let attempts = 0;
    sdk.putObject = (params, callback) => {
      attempts += 1;
      FakeCosSdk.prototype.putObject.call(sdk, params, (error, data) => {
        callback(
          attempts === 1
            ? Object.assign(new Error("lost response"), { code: "ETIMEDOUT" })
            : error,
          data
        );
      });
    };
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryCount: 1,
      retryDelayMs: 0,
    });
    await expect(store.putFile("payload.bin", filePath)).resolves.toMatchObject(
      {
        status: "idempotent",
      }
    );
    expect(attempts).toBe(2);
    expect(sdk.objects.get("payload.bin").data).toEqual(payload);
  });

  it("uses private HEAD, streaming upload, encoded CopySource, and streaming hash", async () => {
    const directory = path.join(fixtureRoot, "sdk-boundary");
    await fsp.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "payload.bin");
    const payload = Buffer.from("private COS payload");
    await fsp.writeFile(filePath, payload);
    const sdk = new FakeCosSdk();
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryDelayMs: 0,
    });

    await store.putFile("dir/space file.bin", filePath);
    const headCall = sdk.calls.find((call) => call.method === "headObject");
    expect(headCall.params).toMatchObject({
      Bucket: "bucket-1250000000",
      Region: "ap-hongkong",
      Key: "dir/space file.bin",
      Headers: {},
    });
    const uploadCall = sdk.calls.find((call) => call.method === "putObject");
    expect(Buffer.isBuffer(uploadCall.params.Body)).toBe(false);
    expect(uploadCall.params.ContentLength).toBe(payload.byteLength);
    expect(uploadCall.params.Headers["x-cos-forbid-overwrite"]).toBe("true");
    expect(sdk.calls.some((call) => call.method === "uploadFile")).toBe(false);

    const sourceKey = "dir/space file+%?#.bin";
    sdk.objects.set(sourceKey, { data: payload, sha256: sha256(payload) });
    await store.copy(sourceKey, "stable/copied.bin", {
      sha256: sha256(payload),
      size: payload.byteLength,
    });
    const copyCall = sdk.calls.find((call) => call.method === "putObjectCopy");
    expect(copyCall.params.CopySource).toBe(
      formatCopySource("bucket-1250000000", "ap-hongkong", sourceKey)
    );
    expect(copyCall.params.CopySource).toContain(
      "dir/space%20file%2B%25%3F%23.bin"
    );
    expect(copyCall.params.Headers["x-cos-metadata-directive"]).toBe(
      "Replaced"
    );
    expect(copyCall.params.Headers["x-cos-forbid-overwrite"]).toBe("true");

    const digest = await store.hashObject(sourceKey);
    expect(digest).toMatchObject({
      size: payload.byteLength,
      sha1: sha1(payload),
      sha256: sha256(payload),
    });
  });

  it("retries transient SDK failures and preserves immutable idempotency", async () => {
    const sdk = new FakeCosSdk();
    sdk.failPutCount = 1;
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryCount: 1,
      retryDelayMs: 0,
    });
    const payload = Buffer.from("retry me");
    const result = await store.putBytes("immutable.bin", payload);
    expect(result.status).toBe("uploaded");
    expect(
      sdk.calls.filter((call) => call.method === "putObject")
    ).toHaveLength(2);

    const idempotent = await store.putBytes("immutable.bin", payload);
    expect(idempotent.status).toBe("idempotent");
    await expect(
      store.putBytes("immutable.bin", Buffer.from("different"))
    ).rejects.toThrow(/immutable object conflict/i);

    await store.putMutableBytes("stable/RELEASES", Buffer.from("pointer"));
    const mutablePut = sdk.calls
      .filter((call) => call.method === "putObject")
      .at(-1);
    expect(mutablePut.params.Headers["x-cos-forbid-overwrite"]).toBeUndefined();
  });

  it("allows a fresh immutable upload with write-only COS permissions", async () => {
    const sdk = new FakeCosSdk();
    sdk.denyHead = true;
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryDelayMs: 0,
    });
    const payload = Buffer.from("write-only payload");

    await expect(
      store.putBytes("write-only.bin", payload)
    ).resolves.toMatchObject({ status: "uploaded" });
    const putCall = sdk.calls.find((call) => call.method === "putObject");
    expect(putCall.params.Headers["x-cos-forbid-overwrite"]).toBe("true");
    expect(sdk.objects.get("write-only.bin").data.equals(payload)).toBe(true);

    await expect(store.putBytes("write-only.bin", payload)).rejects.toThrow(
      /forbidden/i
    );
    expect(sdk.objects.get("write-only.bin").data.equals(payload)).toBe(true);
  });

  it("reuses an existing immutable object from metadata without GET for write-only retries", async () => {
    const sdk = new FakeCosSdk();
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryDelayMs: 0,
    });
    const payload = Buffer.from("existing write-only payload");
    const key =
      "ai-image-manager/updates/win32/x64/candidates/2.2.0/existing.bin";
    await store.putBytes(key, payload);

    let getAttempts = 0;
    sdk.getObjectStream = (_params, callback) => {
      getAttempts += 1;
      callback(Object.assign(new Error("Access Denied"), { statusCode: 403 }));
      return Readable.from([]);
    };

    await expect(
      store.putBytes(key, payload, { deferCandidateVerification: true })
    ).resolves.toMatchObject({
      status: "verification-pending",
      metadataVerified: true,
    });
    expect(getAttempts).toBe(0);
  });

  it("defers a FileAlreadyExists conflict when candidate HEAD is forbidden", async () => {
    const sdk = new FakeCosSdk();
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryDelayMs: 0,
    });
    const key =
      "ai-image-manager/updates/win32/x64/candidates/2.2.0/existing.bin";
    const payload = Buffer.from("existing write-only payload");
    sdk.objects.set(key, { data: payload, sha256: sha256(payload) });
    sdk.denyHead = true;

    await expect(
      store.putBytes(key, payload, { deferCandidateVerification: true })
    ).resolves.toMatchObject({
      status: "verification-pending",
      metadataVerified: false,
    });
  });

  it("streams the putObject fallback instead of reading a whole file", async () => {
    const directory = path.join(fixtureRoot, "sdk-fallback");
    await fsp.mkdir(directory, { recursive: true });
    const filePath = path.join(directory, "payload.bin");
    await fsp.writeFile(filePath, Buffer.alloc(128, 7));
    const sdk = new FakeCosSdk();
    sdk.uploadFile = undefined;
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      retryDelayMs: 0,
    });
    await store.putFile("fallback.bin", filePath);
    const putCall = sdk.calls.find((call) => call.method === "putObject");
    expect(Buffer.isBuffer(putCall.params.Body)).toBe(false);
    expect(sdk.objects.get("fallback.bin").data.byteLength).toBe(128);
  });

  it("uses guarded multipart uploads for large files", async () => {
    const filePath = path.join(fixtureRoot, "multipart.bin");
    const payload = Buffer.from("multipart upload keeps the immutable guard");
    await fsp.writeFile(filePath, payload);
    const sdk = new FakeCosSdk();
    const store = new CosStore({
      client: sdk,
      bucket: "bucket-1250000000",
      region: "ap-hongkong",
      sliceSize: 8,
      retryDelayMs: 0,
    });

    await store.putFile("large.bin", filePath);

    const init = sdk.calls.find((call) => call.method === "multipartInit");
    const complete = sdk.calls.find(
      (call) => call.method === "multipartComplete"
    );
    expect(init.params.Headers["x-cos-forbid-overwrite"]).toBe("true");
    expect(complete.params.Headers["x-cos-forbid-overwrite"]).toBe("true");
    expect(sdk.calls.some((call) => call.method === "putObject")).toBe(false);
    expect(sdk.objects.get("large.bin").data).toEqual(payload);
  });
});

describe("checksums and Squirrel manifests", () => {
  it("generates and verifies SHA256SUMS without loading files in collect metadata", async () => {
    const directory = path.join(fixtureRoot, "checksums");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(path.join(directory, "one.bin"), Buffer.from("one"));
    await fsp.writeFile(path.join(directory, "two.bin"), Buffer.from("two"));
    const records = await collectFileRecords(directory);
    expect(records.every((record) => record.data === undefined)).toBe(true);
    const manifest = formatSha256Sums(records);
    expect(await verifySha256Sums(manifest, directory)).toHaveLength(2);
  });

  it("keeps valid full packages and only smaller, valid deltas", () => {
    const full = Buffer.alloc(12, 70);
    const delta = Buffer.alloc(4, 68);
    const fullEntry = {
      hash: sha1(full),
      filename: "App-2.1.0-full.nupkg",
      size: full.length,
    };
    const deltaEntry = {
      hash: sha1(delta),
      filename: "App-2.1.0-delta.nupkg",
      size: delta.length,
    };
    const result = selectProductionReleases(
      parseReleases(formatReleases([fullEntry, deltaEntry])),
      new Map([
        [fullEntry.filename, full],
        [deltaEntry.filename, delta],
      ])
    );
    expect(result.entries.map((entry) => entry.filename)).toEqual([
      fullEntry.filename,
      deltaEntry.filename,
    ]);
    const invalidDelta = Buffer.alloc(20, 68);
    const fallback = filterReleaseManifest(
      formatReleases([
        fullEntry,
        { ...deltaEntry, hash: sha1(invalidDelta), size: invalidDelta.length },
      ]),
      new Map([
        [fullEntry.filename, full],
        [deltaEntry.filename, invalidDelta],
      ])
    );
    expect(fallback.entries.map((entry) => entry.filename)).toEqual([
      fullEntry.filename,
    ]);
    expect(() =>
      parseReleases(`${sha1(full)} App-2.1.0.nupkg ${full.length}\n`)
    ).toThrow(/full|delta/i);
  });

  it("creates a one-line GitHub compatibility feed with the current full package first", () => {
    const oldFull = {
      hash: "a".repeat(40),
      filename: "App-2.0.0-full.nupkg",
      size: 10,
      isFull: true,
    };
    const currentFull = {
      hash: "b".repeat(40),
      filename: "App-2.1.0-full.nupkg",
      size: 20,
      isFull: true,
    };
    const delta = {
      hash: "c".repeat(40),
      filename: "App-2.1.0-delta.nupkg",
      size: 5,
      isDelta: true,
    };
    expect(formatGitHubReleases([oldFull, delta, currentFull], "2.1.0")).toBe(
      formatReleases([currentFull])
    );
    expect(() => formatGitHubReleases([oldFull], "2.1.0")).toThrow(
      /exactly one current full/
    );
  });

  it("checksums in-memory records for unit callers", async () => {
    const records = collectByteRecords({ "a.txt": "a", "b.txt": "b" });
    const manifest = formatSha256Sums(records);
    expect(
      await verifySha256Sums(
        manifest,
        new Map(records.map((record) => [record.relativePath, record.data]))
      )
    ).toHaveLength(2);
  });
});

describe("COS upload and promotion paths", () => {
  it("uploads flat downloads without requiring or publishing RELEASES", async () => {
    const directory = path.join(fixtureRoot, "flat-download");
    await fsp.mkdir(directory, { recursive: true });
    await fsp.writeFile(
      path.join(directory, "AppSetup.exe"),
      Buffer.from("setup")
    );
    await fsp.writeFile(path.join(directory, "App.msi"), Buffer.from("msi"));
    const store = new MemoryStore();
    const result = await uploadRelease(store, directory, {
      prefix: prefixForKind("versioned", {
        version: "2.1.0",
        releasePrefix: "ai-image-manager",
      }),
      version: "2.1.0",
      requireReleases: false,
    });
    expect(result.releaseRecord).toBeNull();
    expect(
      result.uploaded.some((item) => item.relativePath === "RELEASES")
    ).toBe(false);
    for (const relativePath of ["SHA256SUMS.txt", "provenance.json"]) {
      const local = await fsp.readFile(path.join(directory, relativePath));
      const remote = store.objects.get(`${result.prefix}/${relativePath}`).data;
      expect(remote.equals(local)).toBe(true);
    }
    await expect(
      verifyRelease(store, directory, {
        prefix: result.prefix,
        version: "2.1.0",
      })
    ).resolves.toMatchObject({ prefix: result.prefix });
  });

  it("uses COS_RELEASE_PREFIX layout and uploads RELEASES last", async () => {
    const directory = path.join(fixtureRoot, "artifact");
    await fsp.mkdir(directory, { recursive: true });
    const full = Buffer.alloc(12, 70);
    const delta = Buffer.alloc(20, 68);
    await fsp.writeFile(path.join(directory, "App-2.1.0-full.nupkg"), full);
    await fsp.writeFile(path.join(directory, "App-2.1.0-delta.nupkg"), delta);
    await fsp.writeFile(
      path.join(directory, "RELEASES"),
      formatReleases([
        {
          hash: sha1(full),
          filename: "App-2.1.0-full.nupkg",
          size: full.length,
        },
        {
          hash: sha1(delta),
          filename: "App-2.1.0-delta.nupkg",
          size: delta.length,
        },
      ])
    );
    const prepared = await prepareReleaseArtifacts(directory, {
      version: "2.1.0",
    });
    expect(
      prepared.records.some(
        (record) => record.relativePath === "SHA256SUMS.txt"
      )
    ).toBe(true);
    const store = new MemoryStore();
    const result = await uploadRelease(store, directory, {
      prefix: prefixForKind("candidate", {
        version: "2.1.0",
        releasePrefix: "ai-image-manager",
      }),
      version: "2.1.0",
      requireReleases: true,
    });
    const puts = store.calls.filter((call) => call.method === "put");
    expect(result.prefix).toBe(
      "ai-image-manager/updates/win32/x64/candidates/2.1.0"
    );
    expect(puts.at(-1).key).toMatch(/\/RELEASES$/);
    expect(
      puts.slice(0, -1).every((call) => !call.key.endsWith("/RELEASES"))
    ).toBe(true);
    const materializedReleases = await fsp.readFile(
      path.join(directory, "RELEASES"),
      "utf8"
    );
    expect(materializedReleases).toBe(
      formatReleases([
        {
          hash: sha1(full),
          filename: "App-2.1.0-full.nupkg",
          size: full.length,
        },
      ])
    );
    const materializedChecksums = await fsp.readFile(
      path.join(directory, "SHA256SUMS.txt")
    );
    const uploadedChecksums = store.objects.get(
      `${result.prefix}/SHA256SUMS.txt`
    ).data;
    expect(materializedChecksums.equals(uploadedChecksums)).toBe(true);
  });

  it("allows candidate uploads with a write-only COS identity", async () => {
    const directory = path.join(fixtureRoot, "write-only-candidate");
    await fsp.mkdir(directory, { recursive: true });
    const full = Buffer.from("candidate package");
    await fsp.writeFile(path.join(directory, "App-2.1.0-full.nupkg"), full);
    await fsp.writeFile(
      path.join(directory, "RELEASES"),
      formatReleases([
        {
          hash: sha1(full),
          filename: "App-2.1.0-full.nupkg",
          size: full.length,
        },
      ])
    );
    const store = new MemoryStore();
    store.head = async () => {
      throw new Error("Access Denied");
    };

    await expect(
      uploadRelease(store, directory, {
        prefix: prefixForKind("candidate", {
          version: "2.1.0",
          releasePrefix: "ai-image-manager",
        }),
        version: "2.1.0",
        requireReleases: true,
        deferCandidateVerification: true,
      })
    ).resolves.toMatchObject({
      prefix: "ai-image-manager/updates/win32/x64/candidates/2.1.0",
    });
  });

  it("promotes packages before stable RELEASES and writes a real build-base directory", async () => {
    const store = new MemoryStore();
    const prefix = "ai-image-manager";
    const candidate = prefixForKind("candidate", {
      version: "2.1.0",
      releasePrefix: prefix,
    });
    const oldFull = Buffer.alloc(10, 69);
    const full = Buffer.alloc(12, 70);
    const delta = Buffer.alloc(4, 68);
    const manifest = formatReleases([
      {
        hash: sha1(oldFull),
        filename: "App-2.0.9-full.nupkg",
        size: oldFull.length,
      },
      { hash: sha1(full), filename: "App-2.1.0-full.nupkg", size: full.length },
      {
        hash: sha1(delta),
        filename: "App-2.1.0-delta.nupkg",
        size: delta.length,
      },
    ]);
    await store.putBytes(`${candidate}/App-2.0.9-full.nupkg`, oldFull, {
      sha256: sha256(oldFull),
    });
    await store.putBytes(`${candidate}/App-2.1.0-full.nupkg`, full, {
      sha256: sha256(full),
    });
    await store.putBytes(`${candidate}/App-2.1.0-delta.nupkg`, delta, {
      sha256: sha256(delta),
    });
    await store.putBytes(`${candidate}/RELEASES`, Buffer.from(manifest), {
      sha256: sha256(Buffer.from(manifest)),
    });
    store.calls.length = 0;
    const result = await promoteRelease(store, "2.1.0", {
      releasePrefix: prefix,
    });
    const copies = store.calls.filter((call) => call.method === "copy");
    expect(result.stablePrefix).toBe(
      "ai-image-manager/updates/win32/x64/stable"
    );
    expect(
      store.objects.has(`${result.stablePrefix}/App-2.1.0-full.nupkg`)
    ).toBe(true);
    expect(
      store.objects.has(`${result.stablePrefix}/App-2.0.9-full.nupkg`)
    ).toBe(true);
    expect(
      store.objects.has(`${result.buildBasePrefix}/App-2.1.0-full.nupkg`)
    ).toBe(true);
    expect(
      store.objects.get(`${result.buildBasePrefix}/RELEASES`).data.toString()
    ).toBe(
      formatReleases([
        {
          hash: sha1(full),
          filename: "App-2.1.0-full.nupkg",
          size: full.length,
        },
      ])
    );
    const stableManifestIndex = store.calls.findIndex(
      (call) =>
        call.key === `${result.stablePrefix}/RELEASES` && call.method === "copy"
    );
    expect(stableManifestIndex).toBeGreaterThan(
      copies.findIndex((call) => call.key.endsWith("App-2.1.0-full.nupkg"))
    );
    expect(
      copies.some(
        (call) => call.key.includes("build-base") && call.key.endsWith(".nupkg")
      )
    ).toBe(true);
  });

  it("validates candidate packages through a stream digest and switches stable last", async () => {
    const store = new StreamingMemoryStore();
    const prefix = "ai-image-manager";
    const candidate = prefixForKind("candidate", {
      version: "2.2.0",
      releasePrefix: prefix,
    });
    const full = Buffer.alloc(64, 72);
    const manifest = formatReleases([
      {
        hash: sha1(full),
        filename: "App-2.2.0-full.nupkg",
        size: full.length,
      },
    ]);
    await store.putBytes(`${candidate}/App-2.2.0-full.nupkg`, full, {
      sha256: sha256(full),
    });
    await store.putBytes(`${candidate}/RELEASES`, Buffer.from(manifest), {
      sha256: sha256(Buffer.from(manifest)),
    });
    store.calls.length = 0;

    const result = await promoteRelease(store, "2.2.0", {
      releasePrefix: prefix,
    });
    const mutations = store.calls.filter(
      (call) => call.method === "copy" || call.method === "put"
    );
    expect(mutations.at(-1)).toMatchObject({
      method: "copy",
      key: `${result.stablePrefix}/RELEASES`,
    });
    expect(
      store.calls.some(
        (call) => call.method === "get" && call.key.endsWith(".nupkg")
      )
    ).toBe(false);
  });
});

describe("CLI parsing", () => {
  it("supports help and named options", () => {
    expect(parseCliArgs(["--help"])).toMatchObject({
      command: "help",
      options: { help: true },
    });
    expect(
      parseCliArgs(["guard", "--tag", "v2.1.0", "--latest-stable=2.0.0"])
    ).toMatchObject({
      command: "guard",
      options: { tag: "v2.1.0", "latest-stable": "2.0.0" },
    });
  });

  it("does not require RELEASES for the independent downloads area", () => {
    expect(commandRequiresReleases("upload-versioned")).toBe(false);
    expect(commandRequiresReleases("upload-testing")).toBe(false);
    expect(commandRequiresReleases("upload-candidate")).toBe(true);
    expect(commandRequiresReleases("upload-versioned", true)).toBe(true);
    expect(commandRequiresReleases("bootstrap")).toBe(false);
  });

  it("does not expose a stable-writing bootstrap shortcut", async () => {
    expect(HELP_TEXT).not.toMatch(/bootstrap\s*\|\s*seed/);
    await expect(
      runCli(["bootstrap"], { cwd: process.cwd(), env: {} })
    ).rejects.toMatchObject({ code: "CLI_COMMAND" });
  });
});
