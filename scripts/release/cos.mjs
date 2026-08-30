import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import { createRequire } from "node:module";
import { sha256File } from "./checksums.mjs";
import { invariant, ReleaseError } from "./errors.mjs";
import { assertImmutableObject, normalizeSize } from "./semver.mjs";

const require = createRequire(import.meta.url);
const LEADING_SLASH_PATTERN = /^\/+/;

export const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
export const NO_CACHE_CONTROL = "no-cache, no-store, must-revalidate";

const DEFAULT_RETRY_COUNT = 2;
const DEFAULT_RETRY_DELAY_MS = 100;

/**
 * Build a COS client from environment variables. Secrets are deliberately read
 * only here, at the release boundary, and are never included in provenance.
 */
export function createCosStoreFromEnv(env = process.env, options = {}) {
  const secretId = firstEnv(env, ["COS_SECRET_ID", "TENCENT_COS_SECRET_ID"]);
  const secretKey = firstEnv(env, ["COS_SECRET_KEY", "TENCENT_COS_SECRET_KEY"]);
  const bucket = firstEnv(env, ["COS_BUCKET", "TENCENT_COS_BUCKET"]);
  const region = firstEnv(env, ["COS_REGION", "TENCENT_COS_REGION"]);
  const missing = [
    ["COS_SECRET_ID / TENCENT_COS_SECRET_ID", secretId],
    ["COS_SECRET_KEY / TENCENT_COS_SECRET_KEY", secretKey],
    ["COS_BUCKET / TENCENT_COS_BUCKET", bucket],
    ["COS_REGION / TENCENT_COS_REGION", region],
  ]
    .filter(([, value]) => !value)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new ReleaseError(
      `missing COS environment variable(s): ${missing.join(", ")}`,
      {
        code: "COS_CONFIG_MISSING",
      }
    );
  }

  const SDK = options.sdk ?? loadCosSdk();
  const client =
    options.client ??
    new SDK({
      SecretId: secretId,
      SecretKey: secretKey,
      SecurityToken: firstEnv(env, [
        "COS_SESSION_TOKEN",
        "TENCENT_COS_SESSION_TOKEN",
      ]),
      Protocol: firstEnv(env, ["COS_PROTOCOL"]) ?? "https:",
      Domain: firstEnv(env, ["COS_DOMAIN"]),
    });
  return new CosStore({ client, bucket, region, ...options });
}

export class CosStore {
  constructor({
    client,
    bucket,
    region,
    endpoint = undefined,
    sliceSize = 8 * 1024 * 1024,
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  }) {
    invariant(client, "COS client is required", "COS_CLIENT_MISSING");
    invariant(bucket, "COS bucket is required", "COS_BUCKET_MISSING");
    invariant(region, "COS region is required", "COS_REGION_MISSING");
    this.client = client;
    this.bucket = bucket;
    this.region = region;
    this.endpoint = endpoint;
    this.sliceSize = sliceSize;
    this.retryCount = normalizeRetryCount(retryCount);
    this.retryDelayMs = normalizeRetryDelay(retryDelayMs);
  }

  async head(key) {
    try {
      return await invokeCos(
        this.client,
        "headObject",
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizeKey(key),
          Headers: {},
        },
        this.requestOptions()
      );
    } catch (error) {
      if (isNotFound(error)) {
        return null;
      }
      throw wrapCosError("HEAD", key, error);
    }
  }

  async putFile(
    key,
    filePath,
    {
      sha256,
      size,
      cacheControl = IMMUTABLE_CACHE_CONTROL,
      contentType,
      immutable = true,
    } = {}
  ) {
    const normalizedKey = normalizeKey(key);
    const stat = await fsp.stat(filePath);
    const expectedSize = size ?? stat.size;
    invariant(
      normalizeSize(expectedSize) === BigInt(stat.size),
      `local file size mismatch for ${filePath}: expected ${expectedSize}, got ${stat.size}`,
      "LOCAL_SIZE_MISMATCH"
    );
    const expectedSha256 = sha256 ?? (await sha256File(filePath));
    const existing = await this.head(normalizedKey);
    if (existing && immutable) {
      const result = await this.verifyImmutableExisting(
        normalizedKey,
        existing,
        {
          sha256: expectedSha256,
          size: expectedSize,
        }
      );
      if (result.status === "idempotent") {
        return { ...result, key: normalizedKey };
      }
    }

    const headers = metadataHeaders({
      sha256: expectedSha256,
      cacheControl,
      contentType,
      forbidOverwrite: immutable,
    });
    let data;
    try {
      if (typeof this.client.uploadFile === "function") {
        data = await invokeCos(
          this.client,
          "uploadFile",
          {
            Bucket: this.bucket,
            Region: this.region,
            Key: normalizedKey,
            FilePath: filePath,
            SliceSize: this.sliceSize,
            Headers: headers,
            ContentLength: expectedSize,
          },
          this.requestOptions()
        );
      } else {
        // Keep the fallback streaming as well.  The SDK's uploadFile path is
        // preferred because it transparently switches to multipart upload for
        // large files; a simple putObject must never force a 500MB readFile().
        data = await invokeCos(
          this.client,
          "putObject",
          {
            Bucket: this.bucket,
            Region: this.region,
            Key: normalizedKey,
            Body: createReadStream(filePath),
            ContentLength: expectedSize,
            Headers: headers,
          },
          { retryCount: 0 }
        );
      }
    } catch (error) {
      const idempotent = await this.resolveImmutableRace(
        normalizedKey,
        error,
        { sha256: expectedSha256, size: expectedSize },
        immutable
      );
      if (idempotent) {
        return idempotent;
      }
      throw wrapCosError("PUT", normalizedKey, error);
    }
    return {
      status: "uploaded",
      key: normalizedKey,
      data,
      sha256: expectedSha256,
      size: expectedSize,
    };
  }

  async putBytes(
    key,
    bytes,
    {
      sha256,
      cacheControl = IMMUTABLE_CACHE_CONTROL,
      contentType,
      immutable = true,
    } = {}
  ) {
    const normalizedKey = normalizeKey(key);
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const expectedSha256 =
      sha256 ?? createHash("sha256").update(body).digest("hex");
    const existing = await this.head(normalizedKey);
    if (existing && immutable) {
      const result = await this.verifyImmutableExisting(
        normalizedKey,
        existing,
        {
          sha256: expectedSha256,
          size: body.byteLength,
        }
      );
      if (result.status === "idempotent") {
        return { ...result, key: normalizedKey };
      }
    }
    try {
      const data = await invokeCos(
        this.client,
        "putObject",
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizedKey,
          Body: body,
          ContentLength: body.byteLength,
          Headers: metadataHeaders({
            sha256: expectedSha256,
            cacheControl,
            contentType,
            forbidOverwrite: immutable,
          }),
        },
        this.requestOptions()
      );
      return {
        status: "uploaded",
        key: normalizedKey,
        data,
        sha256: expectedSha256,
        size: body.byteLength,
      };
    } catch (error) {
      const idempotent = await this.resolveImmutableRace(
        normalizedKey,
        error,
        { sha256: expectedSha256, size: body.byteLength },
        immutable
      );
      if (idempotent) {
        return idempotent;
      }
      throw wrapCosError("PUT", normalizedKey, error);
    }
  }

  putMutableBytes(key, bytes, options = {}) {
    const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    return this.putBytes(key, body, {
      ...options,
      sha256: options.sha256 ?? createHash("sha256").update(body).digest("hex"),
      immutable: false,
    });
  }

  async copy(
    sourceKey,
    destinationKey,
    {
      cacheControl = NO_CACHE_CONTROL,
      contentType,
      sha256,
      size,
      immutable = true,
    } = {}
  ) {
    const source = normalizeKey(sourceKey);
    const destination = normalizeKey(destinationKey);
    const existing = await this.head(destination);
    if (immutable) {
      invariant(
        sha256 !== undefined,
        "an expected SHA-256 is required for immutable object copies",
        "HASH_MISSING"
      );
      invariant(
        size !== undefined,
        "an expected object size is required for immutable object copies",
        "SIZE_MISSING"
      );
      if (existing) {
        const result = await this.verifyImmutableExisting(
          destination,
          existing,
          { sha256, size }
        );
        if (result.status === "idempotent") {
          return { ...result, key: destination };
        }
      }
    }
    const headers = metadataHeaders({
      sha256,
      cacheControl,
      contentType,
      forbidOverwrite: immutable,
    });
    headers["x-cos-metadata-directive"] = "Replaced";
    try {
      if (typeof this.client.putObjectCopy === "function") {
        const data = await invokeCos(
          this.client,
          "putObjectCopy",
          {
            Bucket: this.bucket,
            Region: this.region,
            Key: destination,
            CopySource: formatCopySource(
              this.bucket,
              this.region,
              source,
              this.endpoint
            ),
            Headers: headers,
          },
          this.requestOptions()
        );
        return { status: "copied", key: destination, data };
      }
      if (typeof this.client.copyObject === "function") {
        const data = await invokeCos(
          this.client,
          "copyObject",
          {
            Bucket: this.bucket,
            Region: this.region,
            Key: destination,
            Source: source,
            Headers: headers,
          },
          this.requestOptions()
        );
        return { status: "copied", key: destination, data };
      }
      throw new ReleaseError(
        "COS client does not support putObjectCopy/copyObject",
        {
          code: "COS_COPY_UNSUPPORTED",
        }
      );
    } catch (error) {
      const idempotent = await this.resolveImmutableRace(
        destination,
        error,
        { sha256, size },
        immutable
      );
      if (idempotent) {
        return idempotent;
      }
      throw wrapCosError("COPY", `${source} -> ${destination}`, error);
    }
  }

  async delete(key) {
    const normalizedKey = normalizeKey(key);
    try {
      return await invokeCos(
        this.client,
        "deleteObject",
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizedKey,
        },
        this.requestOptions()
      );
    } catch (error) {
      throw wrapCosError("DELETE", normalizedKey, error);
    }
  }

  async getBytes(key) {
    const normalizedKey = normalizeKey(key);
    invariant(
      typeof this.client.getObject === "function",
      "COS client does not support getObject",
      "COS_GET_UNSUPPORTED"
    );
    try {
      const result = await invokeCos(
        this.client,
        "getObject",
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizedKey,
        },
        this.requestOptions()
      );
      const body = result?.Body ?? result?.body ?? result;
      return await toBuffer(body);
    } catch (error) {
      throw wrapCosError("GET", normalizedKey, error);
    }
  }

  /**
   * Hash a private COS object without buffering it.  cos-nodejs-sdk-v5 v3
   * exposes getObjectStream for this purpose; the small getObject fallback is
   * retained for test doubles and older compatible clients.
   */
  async hashObject(key) {
    const normalizedKey = normalizeKey(key);
    try {
      if (typeof this.client.getObjectStream === "function") {
        return await retryCosOperation(
          () =>
            hashSdkStream(this.client, {
              Bucket: this.bucket,
              Region: this.region,
              Key: normalizedKey,
            }),
          this.requestOptions()
        );
      }
      const result = await invokeCos(
        this.client,
        "getObject",
        {
          Bucket: this.bucket,
          Region: this.region,
          Key: normalizedKey,
        },
        this.requestOptions()
      );
      const body = result?.Body ?? result?.body ?? result;
      const digests = await digestBody(body);
      return {
        ...digests,
        headers: result?.headers ?? result?.Headers,
        result,
      };
    } catch (error) {
      throw wrapCosError("GET", normalizedKey, error);
    }
  }

  requestOptions() {
    return {
      retryCount: this.retryCount,
      retryDelayMs: this.retryDelayMs,
    };
  }

  async resolveImmutableRace(key, error, expected, immutable) {
    if (!(immutable && isConflict(error))) {
      return null;
    }
    const existing = await this.head(key);
    if (!existing) {
      return null;
    }
    const result = await this.verifyImmutableExisting(key, existing, expected);
    return result.status === "idempotent" ? { ...result, key } : null;
  }

  async verifyImmutableExisting(key, head, expected) {
    const result = assertImmutableObject(head, expected);
    const digest = await this.hashObject(key);
    assertImmutableObject(
      { sha256: digest.sha256, size: digest.size },
      expected
    );
    return result;
  }
}

export function metadataHeaders({
  sha256,
  cacheControl,
  contentType,
  forbidOverwrite = false,
} = {}) {
  const headers = {};
  if (sha256) {
    headers["x-cos-meta-sha256"] = sha256.toLowerCase();
  }
  if (cacheControl) {
    headers["Cache-Control"] = cacheControl;
  }
  if (contentType) {
    headers["Content-Type"] = contentType;
  }
  if (forbidOverwrite) {
    headers["x-cos-forbid-overwrite"] = "true";
  }
  return headers;
}

export function normalizeKey(value) {
  const key = String(value ?? "")
    .replaceAll("\\", "/")
    .replace(LEADING_SLASH_PATTERN, "");
  invariant(
    key && !key.split("/").some((segment) => segment === ".."),
    `invalid COS object key: ${value}`,
    "INVALID_COS_KEY"
  );
  return key;
}

export function invokeCos(
  client,
  method,
  params,
  {
    retryCount = DEFAULT_RETRY_COUNT,
    retryDelayMs = DEFAULT_RETRY_DELAY_MS,
  } = {}
) {
  invariant(
    typeof client?.[method] === "function",
    `COS client method is unavailable: ${method}`,
    "COS_METHOD_MISSING"
  );
  const attempts = normalizeRetryCount(retryCount) + 1;
  return (async () => {
    let attempt = 0;
    while (true) {
      try {
        return await invokeCosOnce(client, method, params);
      } catch (error) {
        if (attempt >= attempts - 1 || !isRetryableCosError(error)) {
          throw error;
        }
        attempt += 1;
        await waitForRetry(retryDelayMs, attempt);
      }
    }
  })();
}

function invokeCosOnce(client, method, params) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      callback(value);
    };
    const callback = (error, data) => {
      if (error) {
        finish(reject, error);
      } else {
        finish(resolve, data);
      }
    };
    let result;
    try {
      result = client[method](params, callback);
    } catch (error) {
      finish(reject, error);
      return;
    }
    if (result && typeof result.then === "function") {
      result.then(
        (value) => finish(resolve, value),
        (error) => finish(reject, error)
      );
    } else if (result !== undefined && client[method].length < 2) {
      finish(resolve, result);
    }
  });
}

export function isNotFound(error) {
  return [
    error?.statusCode,
    error?.status,
    error?.code,
    error?.Code,
    error?.error?.statusCode,
    error?.error?.status,
    error?.error?.code,
    error?.error?.Code,
  ].some(
    (value) =>
      value === 404 ||
      value === "404" ||
      value === "NoSuchKey" ||
      value === "NotFound" ||
      value === "NoSuchObject"
  );
}

/** Build the URL form required by cos-nodejs-sdk-v5 putObjectCopy. */
export function formatCopySource(bucket, region, key, endpoint = undefined) {
  const host = copySourceHost(bucket, region, endpoint);
  return `${host}/${encodeObjectKey(normalizeKey(key))}`;
}

export function encodeObjectKey(key) {
  return normalizeKey(key)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function isRetryableCosError(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  if (Number.isInteger(statusCode) && statusCode >= 500 && statusCode <= 599) {
    return true;
  }
  const code = String(
    error?.code ?? error?.Code ?? error?.error?.code ?? error?.error?.Code ?? ""
  ).toUpperCase();
  return [
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "ENETUNREACH",
    "EPIPE",
    "REQUESTTIMEOUT",
    "INTERNALERROR",
    "SLOWDOWN",
    "SERVICEUNAVAILABLE",
  ].includes(code);
}

function isConflict(error) {
  const statusCode = Number(error?.statusCode ?? error?.status);
  if (statusCode === 409 || statusCode === 412) {
    return true;
  }
  const code = String(
    error?.code ?? error?.Code ?? error?.error?.code ?? error?.error?.Code ?? ""
  ).toLowerCase();
  return [
    "conflict",
    "preconditionfailed",
    "conditionalrequestconflict",
  ].includes(code);
}

function copySourceHost(bucket, region, endpoint) {
  if (endpoint) {
    const value = String(endpoint).trim();
    const withProtocol = value.includes("://") ? value : `https://${value}`;
    try {
      return new URL(withProtocol).host;
    } catch {
      throw new ReleaseError(`invalid COS endpoint: ${value}`, {
        code: "INVALID_COS_ENDPOINT",
      });
    }
  }
  return `${bucket}.cos.${region}.myqcloud.com`;
}

function normalizeRetryCount(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    return DEFAULT_RETRY_COUNT;
  }
  return Math.min(value, 10);
}

function normalizeRetryDelay(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RETRY_DELAY_MS;
  }
  return Math.min(value, 30_000);
}

function waitForRetry(delayMs, attempt) {
  const delay = normalizeRetryDelay(delayMs) * 2 ** (attempt - 1);
  return new Promise((resolve) => setTimeout(resolve, delay));
}

async function retryCosOperation(operation, { retryCount, retryDelayMs }) {
  const attempts = normalizeRetryCount(retryCount) + 1;
  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts - 1 || !isRetryableCosError(error)) {
        throw error;
      }
      attempt += 1;
      await waitForRetry(retryDelayMs, attempt);
    }
  }
}

function hashSdkStream(client, params) {
  return new Promise((resolve, reject) => {
    const sha1 = createHash("sha1");
    const sha256 = createHash("sha256");
    let size = 0;
    let result;
    let ended = false;
    let settled = false;
    const finish = () => {
      if (settled || !ended) {
        return;
      }
      settled = true;
      resolve({
        size,
        sha1: sha1.digest("hex"),
        sha256: sha256.digest("hex"),
        headers: result?.headers ?? result?.Headers,
        result,
      });
    };
    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      reject(error);
    };
    let stream;
    try {
      stream = client.getObjectStream(params, (error, data) => {
        if (error) {
          fail(error);
          return;
        }
        result = data;
        finish();
      });
    } catch (error) {
      fail(error);
      return;
    }
    if (!stream || typeof stream.on !== "function") {
      fail(
        new ReleaseError("COS getObjectStream returned no readable stream", {
          code: "COS_STREAM_MISSING",
        })
      );
      return;
    }
    stream.on("data", (chunk) => {
      const data = Buffer.from(chunk);
      size += data.byteLength;
      sha1.update(data);
      sha256.update(data);
    });
    stream.once("error", fail);
    stream.once("end", () => {
      ended = true;
      finish();
    });
  });
}

async function digestBody(body) {
  const sha1 = createHash("sha1");
  const sha256 = createHash("sha256");
  let size = 0;
  const consume = (chunk) => {
    const data = Buffer.from(chunk);
    size += data.byteLength;
    sha1.update(data);
    sha256.update(data);
  };
  if (
    Buffer.isBuffer(body) ||
    body instanceof Uint8Array ||
    typeof body === "string"
  ) {
    consume(body);
  } else if (body && typeof body[Symbol.asyncIterator] === "function") {
    for await (const chunk of body) {
      consume(chunk);
    }
  } else if (body && typeof body.on === "function") {
    await new Promise((resolve, reject) => {
      body.on("data", consume);
      body.on("end", resolve);
      body.on("error", reject);
    });
  } else {
    throw new ReleaseError("COS getObject returned no readable body", {
      code: "COS_BODY_MISSING",
    });
  }
  return { size, sha1: sha1.digest("hex"), sha256: sha256.digest("hex") };
}

async function toBuffer(body) {
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (typeof body === "string") {
    return Buffer.from(body);
  }
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    for await (const chunk of body) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (body && typeof body.on === "function") {
    return new Promise((resolve, reject) => {
      const chunks = [];
      body.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      body.on("end", () => resolve(Buffer.concat(chunks)));
      body.on("error", reject);
    });
  }
  throw new ReleaseError("COS getObject returned no readable body", {
    code: "COS_BODY_MISSING",
  });
}

function loadCosSdk() {
  try {
    const module = require("cos-nodejs-sdk-v5");
    return module.default ?? module;
  } catch (error) {
    throw new ReleaseError(
      "cos-nodejs-sdk-v5 is unavailable; run npm ci before using a COS command",
      { code: "COS_SDK_MISSING", cause: error }
    );
  }
}

function firstEnv(env, names) {
  for (const name of names) {
    const value = env?.[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function wrapCosError(action, key, error) {
  if (error instanceof ReleaseError) {
    return error;
  }
  const detail = error?.message ?? String(error);
  return new ReleaseError(`COS ${action} ${key} failed: ${detail}`, {
    code: "COS_REQUEST_FAILED",
    cause: error,
  });
}
