import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { net } from "electron";
import type { UpdatePackage } from "@/services/github-update";
import type { UpdateStatus } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

export const DOWNLOAD_RETRY_DELAYS = [2000, 5000, 15_000] as const;
const RANGE_RE = /^bytes (\d+)-(\d+)\/(\d+)$/;
const IDLE_TIMEOUT = 120_000;
const DOWNLOAD_TIMEOUT = 30 * 60_000;
type Progress = (status: Partial<UpdateStatus>) => void;

export class PackageRequestError extends Error {
  readonly retryAfter?: string;
  constructor(status: number, headers: Record<string, string | string[]>) {
    const retry = String(headers["retry-after"] ?? "");
    const reset = Number(headers["x-ratelimit-reset"]);
    const limited =
      headers["x-ratelimit-remaining"] === "0" ||
      (status === 403 && Boolean(retry));
    super(`HTTP_STATUS_${status}${limited ? " rate-limit" : ""}`);
    let time = limited && reset > 0 ? reset * 1000 : Number.NaN;
    if (retry) {
      time = Number.isFinite(Number(retry))
        ? Date.now() + Number(retry) * 1000
        : Date.parse(retry);
    }
    if (Number.isFinite(time)) {
      this.retryAfter = new Date(Math.max(Date.now(), time)).toISOString();
    }
  }
}

export async function verifyUpdatePackage(
  file: string,
  info: UpdatePackage
): Promise<boolean> {
  try {
    if ((await fsp.stat(file)).size !== info.size) {
      return false;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
  const sha256 = createHash("sha256");
  const sha1 = createHash("sha1");
  for await (const chunk of createReadStream(file)) {
    sha256.update(chunk);
    sha1.update(chunk);
  }
  return (
    sha256.digest("hex") === info.sha256.toLowerCase() &&
    sha1.digest("hex") === info.sha1.toLowerCase()
  );
}

export function isRetryableDownloadError(error: unknown): boolean {
  return [
    "NETWORK_ERROR",
    "UPDATE_RATE_LIMITED",
    "UPDATE_SERVICE_UNAVAILABLE",
  ].includes(classifyUpdateError(error));
}

/** Retry the same immutable asset; a network change is never a delta failure. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: retries retain one immutable package and distinguish corrupt bytes from transport failures
export async function downloadUpdatePackage(
  info: UpdatePackage,
  destination: string,
  progress: Progress
): Promise<void> {
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  if (await verifyUpdatePackage(destination, info)) {
    return;
  }
  const partial = `${destination}.download`;
  let retries = 0;
  let corruptRetries = 0;
  for (;;) {
    progress({
      phase: "downloading",
      attempt: retries + 1,
      maxAttempts: 4,
      retryAfter: undefined,
      message: undefined,
      networkWaiting: false,
      bytesPerSecond: 0,
    });
    try {
      if (!(await verifyUpdatePackage(partial, info))) {
        const size = await fsp
          .stat(partial)
          .then((s) => s.size)
          .catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") {
              return 0;
            }
            throw error;
          });
        if (size >= info.size) {
          await fsp.rm(partial, { force: true });
        }
        await downloadAttempt(info, partial, progress);
        if (!(await verifyUpdatePackage(partial, info))) {
          throw new Error("UPDATE_PACKAGE_CORRUPT");
        }
      }
      await fsp.rename(partial, destination);
      return;
    } catch (error) {
      const code = classifyUpdateError(error);
      if (code === "UPDATE_PACKAGE_CORRUPT") {
        await fsp.rm(partial, { force: true });
        if (corruptRetries++ === 0) {
          continue;
        }
      }
      if (
        !isRetryableDownloadError(error) ||
        retries >= DOWNLOAD_RETRY_DELAYS.length
      ) {
        throw error;
      }
      const retryAfter =
        error instanceof PackageRequestError ? error.retryAfter : undefined;
      const delay = Math.max(
        DOWNLOAD_RETRY_DELAYS[retries++],
        retryAfter ? Date.parse(retryAfter) - Date.now() : 0
      );
      progress({
        phase: "retry-wait",
        attempt: retries,
        maxAttempts: 4,
        message: code,
        bytesPerSecond: 0,
        networkWaiting: true,
        retryAfter: new Date(Date.now() + delay).toISOString(),
      });
      // Bound each timer to Node's supported range, including long rate limits.
      const deadline = Date.now() + delay;
      while (Date.now() < deadline) {
        await new Promise((resolve) =>
          setTimeout(resolve, Math.min(deadline - Date.now(), 60_000))
        );
      }
    }
  }
}

// Chromium fetch exposes a backpressured stream and uses the same system proxy
// configuration as net.request. Every retry opens a new request.
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the attempt owns stream validation, cancellation and the file lifetime
async function downloadAttempt(
  info: UpdatePackage,
  partial: string,
  progress: Progress
): Promise<void> {
  const offset = await fsp
    .stat(partial)
    .then((s) => s.size)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") {
        return 0;
      }
      throw error;
    });
  const controller = new AbortController();
  let transferred = offset;
  let received = 0;
  let lastData = Date.now();
  let lastBroadcast = 0;
  const started = lastData;
  const report = (waiting = false) => {
    lastBroadcast = Date.now();
    progress({
      phase: "downloading",
      transferred,
      total: info.size,
      percent: Math.min(100, Math.floor((transferred / info.size) * 100)),
      bytesPerSecond: waiting
        ? 0
        : Math.round(received / Math.max(1, (Date.now() - started) / 1000)),
      networkWaiting: waiting,
    });
  };
  const timer = setInterval(() => {
    const idle = Date.now() - lastData;
    if (idle >= IDLE_TIMEOUT || Date.now() - started >= DOWNLOAD_TIMEOUT) {
      controller.abort();
    } else if (idle >= 15_000) {
      report(true);
    }
  }, 1000);
  let file: Awaited<ReturnType<typeof fsp.open>> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const headers: Record<string, string> = {
      Accept: "application/octet-stream",
      "Accept-Encoding": "identity",
      "User-Agent": "AI-Image-Manager-Updater",
    };
    if (offset) {
      headers.Range = `bytes=${offset}-`;
    }
    const response = await fetchPackage(info.url, headers, controller.signal);
    if (response.status !== 200 && response.status !== 206) {
      await response.body?.cancel();
      if (response.status === 416) {
        throw new Error("UPDATE_PACKAGE_CORRUPT");
      }
      throw new PackageRequestError(
        response.status,
        Object.fromEntries(response.headers.entries())
      );
    }
    if (response.status === 206) {
      const range = (response.headers.get("content-range") ?? "").match(
        RANGE_RE
      );
      if (
        !range ||
        Number(range[1]) !== offset ||
        Number(range[2]) !== info.size - 1 ||
        Number(range[3]) !== info.size
      ) {
        await response.body?.cancel();
        throw new Error("UPDATE_PACKAGE_CORRUPT");
      }
    } else {
      transferred = 0;
    }
    if (!response.body) {
      throw new Error("ECONNRESET");
    }
    reader = response.body.getReader();
    file = await fsp.open(
      partial,
      response.status === 206 && offset ? "a" : "w"
    );
    report();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      lastData = Date.now();
      transferred += value.byteLength;
      received += value.byteLength;
      if (transferred > info.size) {
        throw new Error("UPDATE_PACKAGE_CORRUPT");
      }
      // Await disk writes before requesting another chunk. Close before any
      // retry so the next Range offset describes only durable accepted bytes.
      await file.writeFile(value);
      if (Date.now() - lastBroadcast >= 250) {
        report();
      }
    }
    if (transferred !== info.size) {
      throw new Error("ECONNRESET");
    }
    report();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error("ETIMEDOUT");
    }
    throw error;
  } finally {
    clearInterval(timer);
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await file?.close();
  }
}

async function fetchPackage(
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal
): Promise<Response> {
  let current = url;
  for (let redirects = 0; redirects < 10; redirects++) {
    if (!current.startsWith("https://")) {
      throw new Error("UPDATE_TLS_ERROR");
    }
    const response = await net.fetch(current, {
      headers,
      signal,
      redirect: "manual",
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      return response;
    }
    const location = response.headers.get("location");
    await response.body?.cancel();
    if (!location) {
      throw new Error("NETWORK_ERROR");
    }
    current = new URL(location, current).toString();
  }
  throw new Error("NETWORK_ERROR");
}
