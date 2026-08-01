import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { pipeline, Transform } from "node:stream";

const HTTP_STATUS_PATTERN = /HTTP\s*(\d{3})/iu;
const PATH_SEPARATOR_PATTERN = /[\\/]/u;
const TRAILING_SLASH_PATTERN = /\/+$/u;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

// ── Types ───────────────────────────────────────────────────────────────

export interface ModelManifestEntry {
  /** Set false for assets that must never enter a normal release package. */
  bundled?: boolean;
  fileName: string;
  name: string;
  required: boolean;
  sha256: string;
  sizeBytes: number;
  subPath: string;
  urls: string[];
}

export interface DownloadProgress {
  bytesPerSecond: number;
  completedFiles: number;
  currentFileName: string;
  /** 0–100 for in-progress / 100 for file-complete / -1 for file-error */
  currentFilePercent: number;
  /** Bytes already written to disk (completed files + partial current). */
  downloadedBytes: number;
  mirrorLabel: string;
  phase: "idle" | "downloading" | "verifying" | "retrying" | "done" | "error";
  remainingSeconds: number;
  /** Total byte count across ALL files in the current download batch */
  totalBytes: number;
  totalFiles: number;
  warnings: string[];
}

export interface ModelDownloadOptions {
  /** Include non-required assets when a caller explicitly requests them. */
  includeOptional?: boolean;
}

// ── Model Manifest ──────────────────────────────────────────────────────

export const MODEL_MANIFEST: ModelManifestEntry[] = [
  {
    name: "SigLIP 视觉编码器",
    fileName: "vision_model_quantized.onnx",
    subPath: "Xenova/siglip-base-patch16-224/onnx",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_quantized.onnx",
    ],
    sha256: "ef14a954f3d57e1806666432bd9785004c1dc27100aa260eee0cb0f10a5de058",
    sizeBytes: 99_499_129,
    required: true,
  },
  {
    name: "SigLIP 文本编码器",
    fileName: "text_model_quantized.onnx",
    subPath: "Xenova/siglip-base-patch16-224/onnx",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/onnx/text_model_quantized.onnx",
    ],
    sha256: "ad0329b1f35acc66d8953ff2559ce358da8eb0a7011794cf951523d63a4dbce2",
    sizeBytes: 111_475_220,
    required: true,
  },
  {
    name: "SigLIP 模型配置",
    fileName: "config.json",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: ["{mirror}/Xenova/siglip-base-patch16-224/resolve/main/config.json"],
    sha256: "e6de71291f181b0b81adc93098787bb4597a79dc18f59737feda8f41671fb6a2",
    sizeBytes: 457,
    required: true,
  },
  {
    name: "SigLIP 图像处理配置",
    fileName: "preprocessor_config.json",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/preprocessor_config.json",
    ],
    sha256: "21ee046a8a52a65e5f9c177bf840bfb39ea66c9c54cf2760630efd58e0a3ec80",
    sizeBytes: 368,
    required: true,
  },
  {
    name: "SigLIP 特殊词元配置",
    fileName: "special_tokens_map.json",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/special_tokens_map.json",
    ],
    sha256: "22f82d1c19654c9552ff1368c2c236ebb34f457dbdbc7510d304cebfeb96f3bf",
    sizeBytes: 406,
    required: true,
  },
  {
    name: "SigLIP SentencePiece 词表",
    fileName: "spiece.model",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: ["{mirror}/Xenova/siglip-base-patch16-224/resolve/main/spiece.model"],
    sha256: "1e5036bed065526c3c212dfbe288752391797c4bb1a284aa18c9a0b23fcaf8ec",
    sizeBytes: 798_330,
    required: true,
  },
  {
    name: "SigLIP 分词器",
    fileName: "tokenizer.json",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/tokenizer.json",
    ],
    sha256: "4a17c975210be5ab4c36b47d8dae4eefb866dbfb1e676e394aad85dc30a3ae08",
    sizeBytes: 2_398_744,
    required: true,
  },
  {
    name: "SigLIP 分词器配置",
    fileName: "tokenizer_config.json",
    subPath: "Xenova/siglip-base-patch16-224",
    urls: [
      "{mirror}/Xenova/siglip-base-patch16-224/resolve/main/tokenizer_config.json",
    ],
    sha256: "9a38d3c6b5e26fe5dcc607eda95e38d78d30d9291835bb9e8116e8174c1d4ba2",
    sizeBytes: 739,
    required: true,
  },
  {
    name: "OPUS-MT 翻译编码器",
    fileName: "encoder_model_quantized.onnx",
    subPath: "Xenova/opus-mt-zh-en/onnx",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/onnx/encoder_model_quantized.onnx",
    ],
    sha256: "84d5e171b626bc8b6b220d022ac58696e9528c25deeacca62b5cbf4364547a99",
    sizeBytes: 52_899_742,
    required: true,
  },
  {
    name: "OPUS-MT 翻译解码器",
    fileName: "decoder_model_merged_quantized.onnx",
    subPath: "Xenova/opus-mt-zh-en/onnx",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/onnx/decoder_model_merged_quantized.onnx",
    ],
    sha256: "c6b7f04ff1ba0fbd1bf6852599b4c0cad6fe512d57cd887f44ef36cf705424cb",
    sizeBytes: 60_212_804,
    required: true,
  },
  {
    name: "OPUS-MT 模型配置",
    fileName: "config.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/config.json",
    ],
    sha256: "293d318fce41dbf04114eac45037bb88a32d7c4ee21011a75e24a8b98ca45ad1",
    sizeBytes: 1389,
    required: true,
  },
  {
    name: "OPUS-MT 生成配置",
    fileName: "generation_config.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/generation_config.json",
    ],
    sha256: "8dc29fef0fe82109f94ef3c2e6ea6bded3215d357b226c34cf7b4630726766c9",
    sizeBytes: 293,
    required: true,
  },
  {
    name: "OPUS-MT 中文 SentencePiece",
    fileName: "source.spm",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/source.spm",
    ],
    sha256: "e27a3a1b539f4959ec72ea60e453f49156289f95d4e6000b29332efc45616203",
    sizeBytes: 804_677,
    required: true,
  },
  {
    name: "OPUS-MT 英文 SentencePiece",
    fileName: "target.spm",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/target.spm",
    ],
    sha256: "6a881f4717cd7265f53fea54fd3dc689c767c05338fac7a4590f3088cb2d7855",
    sizeBytes: 806_530,
    required: true,
  },
  {
    name: "OPUS-MT 分词器",
    fileName: "tokenizer.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/tokenizer.json",
    ],
    sha256: "b306d0301cf280bfd647d7067b5ade2a97b987e6d678df110703c002433643ff",
    sizeBytes: 6_381_339,
    required: true,
  },
  {
    name: "OPUS-MT 分词器配置",
    fileName: "tokenizer_config.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/tokenizer_config.json",
    ],
    sha256: "08849acc0a539c4749d8665e9d6217735503a97871ccebeea8a762d5fba1acf7",
    sizeBytes: 282,
    required: true,
  },
  {
    name: "OPUS-MT 特殊词元配置",
    fileName: "special_tokens_map.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/special_tokens_map.json",
    ],
    sha256: "5e4d1f5e759d74cb1c2fe1d165cfc62b5237aa904de759380cd6f43042eec723",
    sizeBytes: 74,
    required: true,
  },
  {
    name: "OPUS-MT 词表",
    fileName: "vocab.json",
    subPath: "Xenova/opus-mt-zh-en",
    urls: [
      "{mirror}/Xenova/opus-mt-zh-en/resolve/92737ae29cee287d5b7dc400c52afb9407207640/vocab.json",
    ],
    sha256: "08a119a1defd522fa047cb5e3bfe3e89633e96caa38ced0dc9cee7ef1021a011",
    sizeBytes: 1_747_906,
    required: true,
  },
  {
    name: "YuNet 人脸检测",
    fileName: "face_detection_yunet_2023mar.onnx",
    subPath: "face",
    urls: [
      "{mirror}/opencv/face_detection_yunet/resolve/main/face_detection_yunet_2023mar.onnx",
    ],
    sha256: "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
    sizeBytes: 232_589,
    required: true,
  },
  {
    name: "SFace 人脸识别",
    fileName: "face_recognition_sface_2021dec.onnx",
    subPath: "face",
    urls: [
      "{mirror}/opencv/face_recognition_sface/resolve/main/face_recognition_sface_2021dec.onnx",
    ],
    sha256: "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
    sizeBytes: 38_696_353,
    required: true,
  },
];

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function isSafeRelativePath(value: string): boolean {
  return (
    value.length > 0 &&
    !path.isAbsolute(value) &&
    !value
      .split(PATH_SEPARATOR_PATTERN)
      .some((part) => part === ".." || part === "")
  );
}

function validateManifestEntry(entry: ModelManifestEntry): void {
  if (!entry.bundled && entry.urls.length === 0) {
    throw new Error(`Model manifest entry has no source: ${entry.fileName}`);
  }
  if (
    !(isSafeRelativePath(entry.subPath) && isSafeRelativePath(entry.fileName))
  ) {
    throw new Error(
      `Unsafe model manifest path: ${entry.subPath}/${entry.fileName}`
    );
  }
  if (!Number.isSafeInteger(entry.sizeBytes) || entry.sizeBytes <= 0) {
    throw new Error(`Invalid model size: ${entry.fileName}`);
  }
  if (!SHA256_PATTERN.test(entry.sha256)) {
    throw new Error(`Missing or invalid SHA256: ${entry.fileName}`);
  }
  for (const url of entry.urls) {
    const candidate = substituteMirror(url, "https://huggingface.co");
    const parsed = new URL(candidate);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) {
      throw new Error(`Unsafe model URL: ${url}`);
    }
  }
}

export function validateModelManifest(
  manifest: readonly ModelManifestEntry[] = MODEL_MANIFEST
): void {
  const seenPaths = new Set<string>();
  for (const entry of manifest) {
    validateManifestEntry(entry);
    const relativePath = path.join(entry.subPath, entry.fileName);
    if (seenPaths.has(relativePath)) {
      throw new Error(`Duplicate model manifest path: ${relativePath}`);
    }
    seenPaths.add(relativePath);
  }
}

validateModelManifest();

// ── Constants ───────────────────────────────────────────────────────────

const MAX_RETRIES_PER_FILE = 3;
const REQUEST_TIMEOUT_MS = 30_000; // 30 s per connection attempt
const TMP_EXT = ".tmp";

/**
 * File path used for mirror speed probing.
 * Uses the SigLIP vision model — it exists on all HuggingFace mirrors
 * and is a real download target, giving accurate TTFB measurements.
 */
export const PROBE_FILE_PATH =
  "Xenova/siglip-base-patch16-224/resolve/main/onnx/vision_model_quantized.onnx";

// ── Transform: Pass-through hash computation ────────────────────────────

class HashTransform extends Transform {
  private hash = createHash("sha256");
  private bytes = 0;

  _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void
  ): void {
    this.hash.update(chunk);
    this.bytes += chunk.length;
    this.push(chunk);
    callback();
  }

  digest(): string {
    return this.hash.digest("hex");
  }

  get byteLength(): number {
    return this.bytes;
  }

  reset(): void {
    this.hash = createHash("sha256");
    this.bytes = 0;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function substituteMirror(url: string, mirrorBaseUrl: string): string {
  return url.replace(/{mirror}/g, mirrorBaseUrl);
}

function resolveDestPath(modelsDir: string, entry: ModelManifestEntry): string {
  return path.join(modelsDir, entry.subPath, entry.fileName);
}

function resolveTmpPath(modelsDir: string, entry: ModelManifestEntry): string {
  return path.join(modelsDir, entry.subPath, `${entry.fileName}${TMP_EXT}`);
}

function resolveMirrorLabel(url: string): string {
  try {
    const u = new URL(url);
    return u.hostname;
  } catch {
    return url;
  }
}

function validateDownloadUrl(rawUrl: string): string {
  const parsed = new URL(rawUrl);
  const isLoopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "[::1]";
  if (
    parsed.username ||
    parsed.password ||
    (parsed.protocol !== "https:" &&
      !(parsed.protocol === "http:" && isLoopback))
  ) {
    throw new Error(`Refusing unsafe model URL: ${rawUrl}`);
  }
  return parsed.href;
}

/**
 * Check whether a file exists on disk and its content passes the manifest's
 * size and SHA256 verification. A missing hash is never considered safe.
 */
export async function verifyModelFile(
  filePath: string,
  expectedSha256: string,
  expectedSizeBytes: number
): Promise<boolean> {
  let stat: fs.Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return false;
  }
  if (stat.size !== expectedSizeBytes) {
    return false;
  }
  if (!SHA256_PATTERN.test(expectedSha256)) {
    return false;
  }
  // Stream SHA256 verification — never fs.readFileSync
  try {
    const actual = await sha256FileStream(filePath);
    return actual === expectedSha256;
  } catch {
    return false;
  }
}

const isFileValid = verifyModelFile;

function sha256FileStream(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

// ── Core: Download a single file ────────────────────────────────────────

interface DownloadFileOptions {
  destPath: string;
  entry: ModelManifestEntry;
  maxRetries: number;
  mirrorBaseUrl: string;
  modelsDir: string;
  onProgress?: (progress: DownloadProgress) => void;
  signal?: AbortSignal;
}

interface DownloadFileResult {
  warnings: string[];
}

/**
 * Download a single model file with streaming, SHA256 verification,
 * .tmp atomic rename, mirror fallback, and retries.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Retry, mirror fallback, abort handling, and atomic verification form one download boundary.
async function downloadOneFile(
  opts: DownloadFileOptions
): Promise<DownloadFileResult> {
  const {
    destPath,
    entry,
    mirrorBaseUrl,
    modelsDir,
    maxRetries,
    signal,
    onProgress,
  } = opts;
  const warnings: string[] = [];
  const tmpPath = resolveTmpPath(modelsDir, entry);

  // Already valid on disk → skip
  if (await isFileValid(destPath, entry.sha256, entry.sizeBytes)) {
    return { warnings };
  }

  // Ensure target directory exists
  const destDir = path.dirname(destPath);
  await fsp.mkdir(destDir, { recursive: true });

  // Clean any stale .tmp from a previous crashed download
  try {
    await fsp.unlink(tmpPath);
  } catch {
    // file doesn't exist, fine
  }

  const resolvedUrls = entry.urls.map((url) =>
    substituteMirror(url, mirrorBaseUrl)
  );

  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal?.aborted) {
      throw new Error("Download cancelled");
    }

    // Try each mirror in order
    for (const url of resolvedUrls) {
      if (signal?.aborted) {
        throw new Error("Download cancelled");
      }

      const mirrorLabel = resolveMirrorLabel(url);

      if (attempt > 0) {
        onProgress?.({
          phase: "retrying",
          totalFiles: 0,
          completedFiles: 0,
          currentFileName: entry.name,
          currentFilePercent: 0,
          bytesPerSecond: 0,
          remainingSeconds: 0,
          mirrorLabel,
          warnings: [
            ...warnings,
            `Retrying ${entry.name} (attempt ${attempt + 1}/${maxRetries})`,
          ],
          totalBytes: 0,
          downloadedBytes: 0,
        });
      }

      try {
        const actualHash = await attemptDownload({
          url,
          tmpPath,
          entry,
          mirrorLabel,
          signal,
          onProgress,
        });

        // Verify SHA256 if configured — uses in-stream hash from attemptDownload,
        // no redundant disk read
        if (entry.sha256) {
          onProgress?.({
            phase: "verifying",
            totalFiles: 0,
            completedFiles: 0,
            currentFileName: entry.name,
            currentFilePercent: 100,
            bytesPerSecond: 0,
            remainingSeconds: 0,
            mirrorLabel,
            warnings,
            totalBytes: 0,
            downloadedBytes: 0,
          });

          if (actualHash !== entry.sha256) {
            throw new Error(
              `SHA256 mismatch: expected ${entry.sha256}, got ${actualHash}`
            );
          }
        }

        // Atomic rename: .tmp → final filename
        await fsp.rename(tmpPath, destPath);
        return { warnings };
      } catch (err: unknown) {
        // If the operation was aborted (by an external AbortController or
        // by our internal concurrent-error abort), re-throw immediately
        // instead of retrying — retries are pointless when the user or
        // the pool controller wants to stop.
        if (signal?.aborted || isAbortError(err)) {
          throw err;
        }

        lastError = err instanceof Error ? err : new Error(errorMessage(err));
        warnings.push(`Mirror ${mirrorLabel}: ${errorMessage(err)}`);
        // Clean up failed .tmp so next attempt starts fresh
        try {
          await fsp.unlink(tmpPath);
        } catch {
          // ignore
        }
        // Continue to next mirror
      }
    }

    // All mirrors failed this attempt, will retry if attempts remain
  }

  // All retries exhausted
  throw new Error(
    `Failed to download ${entry.name} after ${maxRetries} attempts: ${lastError?.message ?? "unknown error"}`
  );
}

// ── Single attempt (one mirror) ─────────────────────────────────────────

interface AttemptDownloadOptions {
  entry: ModelManifestEntry;
  mirrorLabel: string;
  onProgress?: (progress: DownloadProgress) => void;
  redirectsRemaining?: number;
  signal?: AbortSignal;
  tmpPath: string;
  url: string;
}

/**
 * Download a file from a single URL.
 *
 * Uses a `settled` guard to prevent double-resolve/reject from
 * overlapping req error / timeout / pipeline callback events.
 *
 * Sets `timeout: 30_000` on the HTTP request so a hung TCP connection
 * (e.g. firewall silently dropping packets) is detected and fails fast
 * instead of freezing the download pool indefinitely.
 */
function attemptDownload(opts: AttemptDownloadOptions): Promise<string> {
  const {
    url: rawUrl,
    tmpPath,
    entry,
    mirrorLabel,
    signal,
    onProgress,
    redirectsRemaining = 5,
  } = opts;
  const url = validateDownloadUrl(rawUrl);

  return new Promise((resolve, reject) => {
    let settled = false;

    // Guard: if already settled, silently ignore any subsequent
    // resolve/reject calls (prevents unhandled rejection noise).
    const onceSettle = (fn: () => void): void => {
      if (settled) {
        return;
      }
      settled = true;
      fn();
    };

    // Support both http and https
    const proto = (url.startsWith("https://") ? https : http) as typeof https;

    const req = proto.get(
      url,
      { signal, timeout: REQUEST_TIMEOUT_MS },
      (response) => {
        // Follow redirects
        if (
          response.statusCode === 301 ||
          response.statusCode === 302 ||
          response.statusCode === 307 ||
          response.statusCode === 308
        ) {
          const redirectUrl = response.headers.location;
          if (redirectUrl) {
            if (redirectsRemaining <= 0) {
              response.resume();
              onceSettle(() =>
                reject(new Error("Too many model URL redirects"))
              );
              return;
            }
            // Consume response to free socket
            response.resume();
            const resolvedRedirect = new URL(redirectUrl, url).href;
            attemptDownload({
              url: resolvedRedirect,
              tmpPath,
              entry,
              mirrorLabel,
              signal,
              onProgress,
              redirectsRemaining: redirectsRemaining - 1,
            })
              .then((h) => onceSettle(() => resolve(h)))
              .catch((e) => onceSettle(() => reject(e)));
            return;
          }
        }

        if (response.statusCode !== 200) {
          response.resume();
          onceSettle(() => reject(new Error(`HTTP ${response.statusCode}`)));
          return;
        }

        const contentLengthHeader = response.headers["content-length"];
        const totalBytes = contentLengthHeader
          ? Number.parseInt(contentLengthHeader, 10)
          : entry.sizeBytes;
        let downloadedBytes = 0;
        const startTime = Date.now();
        let lastProgressTime = startTime;

        const hashTransform = new HashTransform();
        const writeStream = fs.createWriteStream(tmpPath);

        // Progress tracking
        const onData = (chunk: Buffer): void => {
          downloadedBytes += chunk.length;
          const now = Date.now();
          // Throttle progress updates to ~100ms
          if (now - lastProgressTime >= 100) {
            lastProgressTime = now;
            const elapsed = (now - startTime) / 1000; // seconds
            const bytesPerSecond = elapsed > 0 ? downloadedBytes / elapsed : 0;
            const remainingBytes = totalBytes - downloadedBytes;
            const remainingSeconds =
              bytesPerSecond > 0 ? remainingBytes / bytesPerSecond : 0;
            const percent =
              totalBytes > 0 ? (downloadedBytes / totalBytes) * 100 : 0;

            onProgress?.({
              phase: "downloading",
              totalFiles: 0,
              completedFiles: 0,
              currentFileName: entry.name,
              currentFilePercent: percent,
              bytesPerSecond,
              remainingSeconds,
              mirrorLabel,
              warnings: [],
              totalBytes: 0,
              downloadedBytes: 0,
            });
          }
        };

        hashTransform.on("data", onData);

        // Use pipeline for proper backpressure and error propagation
        pipeline(response, hashTransform, writeStream, (err) => {
          if (err) {
            // Cleanup write stream on error
            writeStream.destroy();
            onceSettle(() => reject(err));
            return;
          }
          // Return SHA256 computed in-stream — avoids re-reading the file from disk
          if (hashTransform.byteLength !== entry.sizeBytes) {
            writeStream.destroy();
            onceSettle(() =>
              reject(
                new Error(
                  `Model size mismatch: expected ${entry.sizeBytes}, got ${hashTransform.byteLength}`
                )
              )
            );
            return;
          }
          onceSettle(() => resolve(hashTransform.digest()));
        });
      }
    );

    req.on("error", (err) => {
      onceSettle(() => reject(err));
    });

    req.on("timeout", () => {
      onceSettle(() => {
        req.destroy();
        reject(
          new Error(`Request timed out after ${REQUEST_TIMEOUT_MS}ms: ${url}`)
        );
      });
    });

    req.end();
  });
}

// ── Mirror Probe ────────────────────────────────────────────────────────

/**
 * Probe a single mirror by sending a HEAD request to a real model file
 * (not the root domain — avoids WAF/CDN false negatives).
 *
 * If HEAD is blocked (403/405/Method Not Allowed), falls back to a GET
 * with `Range: bytes=0-0` which downloads only 1 byte while still
 * proving the file is reachable.
 *
 * Non-retriable errors (DNS failure, connection refused, non-403/405
 * HTTP errors such as 404) are propagated immediately — they will
 * exclude this mirror from the speed ranking.
 *
 * @returns TTFB in milliseconds, or rejects if the mirror is unreachable.
 */
async function probeSingleMirror(
  mirrorBaseUrl: string,
  signal: AbortSignal
): Promise<{ url: string; ttfb: number }> {
  // Strip trailing slash, then append the real model file path
  const base = mirrorBaseUrl.replace(TRAILING_SLASH_PATTERN, "");
  const probeUrl = `${base}/${PROBE_FILE_PATH}`;

  const startTime = Date.now();

  // Strategy 1: HEAD request (cheapest — no body transferred)
  try {
    await headRequest(probeUrl, signal);
    return { url: mirrorBaseUrl, ttfb: Date.now() - startTime };
  } catch (headErr: unknown) {
    // Only fall through to Range GET when HEAD was blocked by a
    // WAF/CDN policy (403 Forbidden, 405 Method Not Allowed).
    // Any other error (DNS, connection refused, 404, timeout)
    // means the mirror is genuinely unreachable — propagate it.
    const headMessage = errorMessage(headErr);
    const statusCode = extractStatusCode(headMessage);
    const isHeadBlocked = statusCode === 403 || statusCode === 405;
    const isTimeout =
      headMessage.includes("timeout") || headMessage.includes("TIMEOUT");

    if (!(isHeadBlocked || isTimeout)) {
      throw headErr; // Fatal: mirror unreachable
    }
  }

  // Strategy 2: GET with Range header (downloads only 1 byte)
  const rangeTtfb = await rangeGetRequest(probeUrl, signal);
  return { url: mirrorBaseUrl, ttfb: rangeTtfb };
}

function extractStatusCode(message: string): number | null {
  const m = message.match(HTTP_STATUS_PATTERN);
  return m ? Number.parseInt(m[1], 10) : null;
}

/**
 * Probe all mirror hosts with HEAD (or Range GET fallback) against a
 * real model file and return the fastest-responding one.
 *
 * Timeout per probe: 5 s.
 * Falls back to the first mirror if all probes fail.
 */
export async function probeFastestMirror(
  mirrorBaseUrls: string[],
  signal?: AbortSignal
): Promise<string> {
  if (mirrorBaseUrls.length === 0) {
    throw new Error("No mirror URLs provided");
  }
  if (mirrorBaseUrls.length === 1) {
    return mirrorBaseUrls[0];
  }

  // Probe all mirrors in parallel, each with its own 5 s timeout
  const results = await Promise.allSettled(
    mirrorBaseUrls.map(async (url) => {
      const probeController = new AbortController();
      const timeoutId = setTimeout(() => probeController.abort(), 5000);

      // If the parent signal fires, also abort this probe
      const onParentAbort = (): void => probeController.abort();
      signal?.addEventListener("abort", onParentAbort, { once: true });

      try {
        return await probeSingleMirror(url, probeController.signal);
      } finally {
        clearTimeout(timeoutId);
        signal?.removeEventListener("abort", onParentAbort);
      }
    })
  );

  // Return the mirror with the lowest TTFB
  let fastest: { url: string; ttfb: number } | null = null;
  for (const result of results) {
    if (
      result.status === "fulfilled" &&
      (!fastest || result.value.ttfb < fastest.ttfb)
    ) {
      fastest = result.value;
    }
  }

  return fastest?.url ?? mirrorBaseUrls[0];
}

/**
 * HEAD request to a real model file URL.
 *
 * ONLY resolves on 200 or 206 — 3xx redirects, 4xx client errors,
 * and 5xx server errors are all rejected.  This prevents probe
 * false-positives where a mirror returns a fast 302/404 that
 * would be mistaken for high bandwidth.
 */
function headRequest(url: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const proto: typeof https | typeof http = url.startsWith("https://")
      ? https
      : http;
    const req = proto.request(
      url,
      { method: "HEAD", signal, timeout: 5000 },
      (res) => {
        res.resume(); // consume response
        if (res.statusCode === 200 || res.statusCode === 206) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("HEAD request timed out"));
    });
    req.end();
  });
}

/**
 * GET request with `Range: bytes=0-0` header — downloads only the first
 * byte of the file.  Used as a fallback when HEAD is blocked by WAF/CDN.
 *
 * ONLY resolves on 200 or 206.  3xx redirects are NOT followed and are
 * rejected — a redirect proves nothing about the actual file availability.
 *
 * @returns TTFB in milliseconds
 */
function rangeGetRequest(url: string, signal: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    const proto: typeof https | typeof http = url.startsWith("https://")
      ? https
      : http;
    const startTime = Date.now();
    const req = proto.get(
      url,
      {
        headers: { Range: "bytes=0-0" },
        signal,
        timeout: 5000,
      },
      (res) => {
        // Consume the single byte and close
        res.resume();
        if (res.statusCode === 200 || res.statusCode === 206) {
          resolve(Date.now() - startTime);
        } else {
          reject(new Error(`HTTP ${res.statusCode}`));
        }
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("Range GET request timed out"));
    });
    req.end();
  });
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Scan the models directory and return candidates that are missing or have
 * the wrong size. Hash verification is asynchronous and is completed by
 * downloadAllModels before a file is considered usable.
 */
function shouldDownloadEntry(
  entry: ModelManifestEntry,
  options: ModelDownloadOptions
): boolean {
  if (entry.urls.length === 0) {
    return false;
  }
  return entry.required || options.includeOptional === true;
}

export function getMissingModels(
  modelsDir: string,
  options: ModelDownloadOptions = {}
): ModelManifestEntry[] {
  const missing: ModelManifestEntry[] = [];

  for (const entry of MODEL_MANIFEST) {
    if (!shouldDownloadEntry(entry, options)) {
      continue;
    }
    const destPath = resolveDestPath(modelsDir, entry);

    let valid = false;
    try {
      // Synchronous size check (fast, no I/O storm)
      const stat = fs.statSync(destPath);
      if (stat.size === entry.sizeBytes) {
        // Hashes are mandatory. Keep hashed files in the queue so the async
        // downloader performs the authoritative verification before skipping.
        valid = false;
      }
    } catch {
      // File doesn't exist
    }

    if (!valid) {
      missing.push(entry);
    }
  }

  return missing;
}

/**
 * Clean up any stale .tmp files in the models directory from
 * previous interrupted downloads.
 */
async function cleanupTempFiles(modelsDir: string): Promise<void> {
  async function cleanDir(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const dent of entries) {
      const fullPath = path.join(dir, dent.name);
      if (dent.isDirectory()) {
        await cleanDir(fullPath);
      } else if (dent.isFile() && dent.name.endsWith(TMP_EXT)) {
        try {
          await fsp.unlink(fullPath);
          console.log(`[ModelDownloader] Cleaned stale tmp: ${fullPath}`);
        } catch {
          // best-effort
        }
      }
    }
  }
  await cleanDir(modelsDir);
}

/**
 * Download all missing models from the manifest.
 *
 * Strategy:
 *  - Files download in parallel with a concurrency limit (MAX_CONCURRENCY).
 *  - An internal AbortController is created so that a fatal error on any
 *    one file immediately cancels all other parallel downloads (avoids
 *    wasting bandwidth on doomed transfers).
 *  - Each file gets up to 3 retries, trying all configured mirrors.
 *  - .tmp atomic rename + SHA256 verification (if configured).
 *  - Per-file completion events (currentFilePercent: 100) are emitted so
 *    the UI can track parallel progress accurately without guessing.
 *
 * @param modelsDir    Path to the models directory (e.g. <data>/models)
 * @param mirrorBaseUrl  Base URL for the primary mirror (replaces {mirror})
 * @param onProgress   Callback for real-time progress updates
 * @param signal       External AbortSignal to cancel the entire download
 */
export async function downloadAllModels(
  modelsDir: string,
  mirrorBaseUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
  signal?: AbortSignal,
  options: ModelDownloadOptions = {}
): Promise<{ success: boolean; downloaded: number; warnings: string[] }> {
  // Ensure models directory exists
  await fsp.mkdir(modelsDir, { recursive: true });

  // Clean stale .tmp files from previous runs
  await cleanupTempFiles(modelsDir);

  // Filter to actually missing or hash-invalid files. The synchronous scan
  // above deliberately avoids reading hundreds of megabytes into memory.
  const candidates = getMissingModels(modelsDir, options);
  const missing = (
    await Promise.all(
      candidates.map(async (entry) => {
        const destPath = resolveDestPath(modelsDir, entry);
        return (await verifyModelFile(destPath, entry.sha256, entry.sizeBytes))
          ? null
          : entry;
      })
    )
  ).filter((entry): entry is ModelManifestEntry => entry !== null);

  if (missing.length === 0) {
    onProgress?.({
      phase: "done",
      totalFiles: 0,
      completedFiles: 0,
      currentFileName: "",
      currentFilePercent: 100,
      bytesPerSecond: 0,
      remainingSeconds: 0,
      mirrorLabel: "",
      warnings: [],
      totalBytes: 0,
      downloadedBytes: 0,
    });
    return { success: true, downloaded: 0, warnings: [] };
  }

  const totalFiles = missing.length;
  const allWarnings: string[] = [];
  let completedFiles = 0;

  // ── Byte-level progress tracking (问题 1: stable percentage) ─────
  const totalBytes = missing.reduce((s, e) => s + e.sizeBytes, 0);
  let completedBytes = 0;

  // ── External abort only (问题 3: 不因单文件失败中止整个队列) ──
  const MAX_CONCURRENCY = 4;

  // Tracks which files failed so we can signal per-file errors to the UI
  const failedFileNames = new Set<string>();

  const downloadOne = async (entry: ModelManifestEntry): Promise<void> => {
    const destPath = resolveDestPath(modelsDir, entry);

    // Per-file progress forwarder: adds global byte counters to
    // each per-file event so the UI can compute overallPercent
    // from (downloadedBytes / totalBytes) without flickering.
    const forwardProgress = (p: DownloadProgress): void => {
      // Partial bytes for the file currently being downloaded
      const currentPartial = (p.currentFilePercent / 100) * entry.sizeBytes;
      onProgress?.({
        ...p,
        totalFiles,
        completedFiles,
        totalBytes,
        downloadedBytes: completedBytes + currentPartial,
      });
    };

    try {
      const result = await downloadOneFile({
        destPath,
        entry,
        mirrorBaseUrl,
        modelsDir,
        maxRetries: MAX_RETRIES_PER_FILE,
        signal, // external signal only — individual failures don't abort siblings
        onProgress: forwardProgress,
      });

      // ── Success ────────────────────────────────────────────────
      allWarnings.push(...result.warnings);
      completedBytes += entry.sizeBytes;
      completedFiles++;

      // Per-file completion signal (护栏 1: 精确的单文件完成标记)
      onProgress?.({
        phase: "downloading",
        totalFiles,
        completedFiles,
        currentFileName: entry.name,
        currentFilePercent: 100,
        bytesPerSecond: 0,
        remainingSeconds: 0,
        mirrorLabel: "",
        warnings: [...allWarnings],
        totalBytes,
        downloadedBytes: completedBytes,
      });
    } catch (err: unknown) {
      // ── Per-file failure — do NOT abort siblings (问题 3) ─────
      if (signal?.aborted) {
        throw err; // external cancellation
      }

      failedFileNames.add(entry.name);
      allWarnings.push(`${entry.name}: ${errorMessage(err)}`);

      // Per-file error signal so the UI can mark this card red
      onProgress?.({
        phase: "downloading",
        totalFiles,
        completedFiles,
        currentFileName: entry.name,
        currentFilePercent: -1, // ← signal: this file errored
        bytesPerSecond: 0,
        remainingSeconds: 0,
        mirrorLabel: "",
        warnings: [...allWarnings],
        totalBytes,
        downloadedBytes: completedBytes,
      });
      // Worker continues to next queue item — other files are unaffected
    }
  };

  // ── Concurrent worker pool (问题 3: sorted by size ascending) ─────
  // Smallest files first — metadata completes immediately
  // instead of waiting behind 166 MB face recognition model.
  const queue = [...missing].sort((a, b) => a.sizeBytes - b.sizeBytes);

  async function worker(): Promise<void> {
    while (queue.length > 0) {
      if (signal?.aborted) {
        return;
      }
      const entry = queue.shift();
      if (!entry) {
        break;
      }

      await downloadOne(entry);
    }
  }

  // Launch the worker pool
  const workerCount = Math.min(MAX_CONCURRENCY, queue.length);
  const workers = Array.from({ length: workerCount }, () => worker());
  await Promise.all(workers);

  // ── Determine final phase ────────────────────────────────────────
  const hasError = failedFileNames.size > 0;
  const phase: DownloadProgress["phase"] = hasError ? "error" : "done";

  onProgress?.({
    phase,
    totalFiles,
    completedFiles,
    currentFileName: "",
    currentFilePercent: hasError ? 0 : 100,
    bytesPerSecond: 0,
    remainingSeconds: 0,
    mirrorLabel: "",
    warnings: allWarnings,
    totalBytes,
    downloadedBytes: completedBytes,
  });

  return {
    success: !hasError,
    downloaded: completedFiles,
    warnings: allWarnings,
  };
}
