import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { app, autoUpdater, BrowserWindow, Notification, net } from "electron";
import {
  chooseUpdatePlan,
  GITHUB_UPDATE_REPOSITORY,
  type GitHubUpdateManifest,
  parseUpdateManifest,
  releaseApiURL,
  releaseAssetURL,
  selectLatestRelease,
  type UpdatePackage,
  type UpdatePlan,
} from "@/services/github-update";
import { getSetting } from "@/services/settings-manager";
import { recordUpdateError } from "@/services/update-error";
import { getUpdateState, setUpdateState } from "@/services/update-state";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
} from "@/types/app-preferences";
import type { UpdateErrorCode, UpdateResult } from "@/types/update";

/**
 * Windows/Squirrel needs a little time after startup before it is safe to
 * start network activity. In particular, Squirrel's --squirrel-firstrun
 * process must not race the first-run install/bootstrap work.
 */
export const UPDATE_INITIAL_DELAY_MS = 10 * 1000;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const UPDATE_METADATA_TIMEOUT_MS = 30 * 1000;
export const UPDATE_DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS = 120 * 1000;
export const UPDATE_INSTALL_TIMEOUT_MS = 15 * 60 * 1000;

const TRAILING_SLASH_RE = /\/$/;

// The identifier is replaced by vite.main.config.mts during a release build.
// `typeof` keeps source/test execution safe when no build define is present.
declare const __AIM_UPDATE_BASE_URL__: unknown;

type UpdatePayload = Parameters<typeof setUpdateState>[0];
type UpdatePhase = UpdatePayload["phase"];

interface UpdateManagerTestOverrides {
  feedURL?: string | null;
  squirrelInstallation?: boolean;
}

interface CustomDownloadedUpdate {
  fallbackReason?: string;
  feedDirectory: string;
  manifest: GitHubUpdateManifest;
  method: "delta" | "full";
  package: UpdatePackage;
  releaseNotes?: string;
}

let configured = false;
let configurationError: UpdateErrorCode = "UPDATE_NOT_FOUND";
let listenersAttached = false;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;

// This is deliberately process-local for checking/downloading. A persisted
// downloaded package is also a valid lock because Squirrel can install it
// after a restart, but stale checking/downloading state must not strand the
// updater forever after a crash.
let activePhase: UpdatePhase | null = null;
let testOverrides: UpdateManagerTestOverrides | null = null;
let customDownloaded: CustomDownloadedUpdate | null = null;
let cachedFeedDirectory: string | null = null;
let installTask: Promise<void> | null = null;

function isSupportedEnvironment(): boolean {
  return process.platform === "win32" && app.isPackaged;
}

function isLegacyUpdaterPath(): boolean {
  // The explicit test seam retains the native autoUpdater contract. Packaged
  // builds use the fixed GitHub manifest transport below.
  return testOverrides !== null;
}

function isSquirrelInstallation(): boolean {
  if (testOverrides?.squirrelInstallation !== undefined) {
    return testOverrides.squirrelInstallation;
  }
  // Both the regular Squirrel Setup and MakerWix's MSI auto-update feature
  // install a Squirrel-compatible Update.exe. ZIP/portable installs and MSI
  // installs that opt out of the updater do not.
  const executableDirectory = path.dirname(process.execPath);
  return [
    path.join(executableDirectory, "Update.exe"),
    path.resolve(executableDirectory, "..", "Update.exe"),
  ].some((candidate) => existsSync(candidate));
}

function normalizeFeedURL(value: unknown, allowHttp = false): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && !(allowHttp && url.protocol === "http:")) {
      return null;
    }
    return url.toString().replace(TRAILING_SLASH_RE, "");
  } catch {
    return null;
  }
}

/**
 * Resolve the feed URL without ever falling back to the public GitHub feed.
 *
 * A release build receives __AIM_UPDATE_BASE_URL__ from the build environment
 * (AIM_UPDATE_BASE_URL). Production never reads a runtime environment variable
 * for this value, so changing a preference or process environment cannot
 * redirect an installed application. The in-memory override below is an
 * explicit unit-test seam and is not connected to IPC or process.env.
 */
export function getUpdateFeedURL(): string | null {
  let injected: unknown;
  try {
    injected = __AIM_UPDATE_BASE_URL__;
  } catch {
    injected = undefined;
  }

  if (testOverrides?.feedURL !== undefined) {
    return normalizeFeedURL(testOverrides.feedURL, true);
  }
  return normalizeFeedURL(injected);
}

/** Unit-test seam; no production code imports or calls this function. */
export function setUpdateManagerTestOverrides(
  overrides: UpdateManagerTestOverrides | null
): void {
  testOverrides = overrides ? { ...overrides } : null;
}

function readBoolean(key: string, fallback: boolean): boolean {
  try {
    return parseBooleanPreference(getSetting(key), fallback);
  } catch {
    return fallback;
  }
}

function reminderEnabled() {
  return readBoolean(
    APP_PREFERENCE_KEYS.updateReminder,
    APP_PREFERENCE_DEFAULTS.updateReminder
  );
}

function isLockedPhase(phase: UpdatePhase | null | undefined): boolean {
  return (
    phase === "checking" || phase === "downloading" || phase === "downloaded"
  );
}

function hydrateDownloadedLock() {
  try {
    const current = getUpdateState(app.getVersion());
    customDownloaded = null;
    activePhase = current?.phase === "downloaded" ? "downloaded" : null;
    cachedFeedDirectory = null;
    if (activePhase === "downloaded" && current?.version) {
      try {
        const directory = path.join(
          app.getPath("userData"),
          "updates",
          "github",
          current.version
        );
        if (existsSync(path.join(directory, "RELEASES"))) {
          cachedFeedDirectory = directory;
          customDownloaded = restoreDownloadedMetadata(current, directory);
        }
      } catch {
        // A persisted state still protects the single-flight lock when the
        // local cache cannot be inspected during startup.
      }
    }
  } catch {
    activePhase = null;
    cachedFeedDirectory = null;
  }
}

function restoreDownloadedMetadata(
  current: UpdatePayload,
  directory: string
): CustomDownloadedUpdate | null {
  const manifestPath = path.join(directory, "update-manifest.json");
  if (!existsSync(manifestPath)) {
    return null;
  }
  const manifest = parseUpdateManifest(
    JSON.parse(readFileSync(manifestPath, "utf8")),
    GITHUB_UPDATE_REPOSITORY
  );
  const method =
    current.updateMethod === "delta" && manifest.packages.delta
      ? "delta"
      : "full";
  const packageInfo =
    method === "delta" ? manifest.packages.delta : manifest.packages.full;
  if (
    !(packageInfo && existsSync(path.join(directory, packageInfo.filename)))
  ) {
    return null;
  }
  return {
    fallbackReason: current.fallbackReason,
    feedDirectory: directory,
    manifest,
    method,
    package: packageInfo,
    releaseNotes: current.releaseNotes,
  };
}

function broadcast(payload: UpdatePayload) {
  setUpdateState(payload);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update:status", payload);
    }
  }
}

function notifyDownloaded(payload: UpdatePayload) {
  broadcast(payload);
  if (!reminderEnabled()) {
    return;
  }

  let hasVisibleWindow = false;
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) {
      continue;
    }
    const visible = win.isVisible();
    hasVisibleWindow ||= visible;
    if (visible) {
      win.webContents.send("update:available", {
        releaseDate: payload.releaseDate,
        releaseNotes: payload.releaseNotes,
        updateURL: payload.updateURL,
        version: payload.version,
      });
    }
  }

  if (!hasVisibleWindow && Notification.isSupported()) {
    new Notification({
      body: payload.version
        ? `版本 ${payload.version} 已下载，重启应用完成更新`
        : "新版本已下载，重启应用完成更新",
      title: "AI Image Manager",
    }).show();
  }
}

function optionalString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return value.toISOString();
  }
  return typeof value === "string" ? value : undefined;
}

function attachListeners() {
  if (listenersAttached) {
    return;
  }
  listenersAttached = true;

  const updater = autoUpdater as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  updater.on("checking-for-update", () => {
    if (activePhase === "downloaded") {
      return;
    }
    activePhase = "checking";
    broadcast({ phase: "checking" });
  });
  // Electron's update-available event does not carry update metadata. The
  // downloaded event below is the first point where release details exist.
  updater.on("update-available", () => {
    if (activePhase === "downloaded") {
      return;
    }
    activePhase = "downloading";
    broadcast({ phase: "downloading" });
  });
  updater.on("update-not-available", () => {
    if (activePhase === "downloaded") {
      return;
    }
    activePhase = null;
    broadcast({ phase: "up-to-date" });
  });
  updater.on("error", (...args) => {
    if (activePhase === "downloaded") {
      return;
    }
    activePhase = null;
    const message = recordUpdateError(args[0], "update-event");
    broadcast({ phase: "error", message });
  });

  updater.on("update-downloaded", (...args) => {
    if (activePhase === "downloaded") {
      return;
    }
    const [, releaseNotes, releaseName, releaseDate, updateURL] = args as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
    ];
    activePhase = "downloaded";
    notifyDownloaded({
      phase: "downloaded",
      releaseDate: optionalString(releaseDate),
      releaseNotes: optionalString(releaseNotes),
      updateURL: optionalString(updateURL),
      version: optionalString(releaseName),
    });
  });

  try {
    updater.on("download-progress", (progress) => {
      if (!progress || typeof progress !== "object") {
        return;
      }
      if (activePhase === "downloaded") {
        return;
      }
      const value = progress as {
        bytesPerSecond?: number;
        percent?: number;
        total?: number;
        transferred?: number;
      };
      activePhase = "downloading";
      broadcast({
        bytesPerSecond: value.bytesPerSecond,
        percent: Math.round(value.percent ?? 0),
        phase: "downloading",
        total: value.total,
        transferred: value.transferred,
      });
    });
  } catch {
    // Some Electron versions do not expose download-progress.
  }
}

function configure(): boolean {
  if (!(isSupportedEnvironment() && isSquirrelInstallation())) {
    return false;
  }
  if (configured) {
    return true;
  }

  const feedURL = getUpdateFeedURL();
  if (!feedURL) {
    configurationError = "UPDATE_NOT_FOUND";
    return false;
  }

  try {
    hydrateDownloadedLock();
    if (isLegacyUpdaterPath()) {
      autoUpdater.setFeedURL({ url: feedURL });
      attachListeners();
    }
    configured = true;
    return true;
  } catch (error) {
    configurationError = recordUpdateError(error, "configure");
    return false;
  }
}

function check(): UpdateResult {
  if (!isSupportedEnvironment()) {
    broadcast({ phase: "error", message: "DEV_MODE" });
    return { ok: false, error: "DEV_MODE" };
  }
  if (!isSquirrelInstallation()) {
    const error = "UPDATE_INSTALLER_UNSUPPORTED";
    broadcast({ phase: "error", message: error });
    return { ok: false, error };
  }
  if (!configure()) {
    // Keep the existing UI error vocabulary; this also avoids exposing a
    // source URL/configuration detail in the renderer.
    broadcast({ phase: "error", message: configurationError });
    return { ok: false, error: configurationError };
  }
  if (isLockedPhase(activePhase)) {
    return { ok: true, skipped: true };
  }

  activePhase = "checking";
  // Mark the lock before calling into Electron. Some updater versions emit
  // checking-for-update asynchronously, and a second IPC call can otherwise
  // slip through during that gap.
  broadcast({ phase: "checking" });
  if (!isLegacyUpdaterPath()) {
    checkGitHubUpdate().catch(() => undefined);
    return { ok: true };
  }
  try {
    autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    activePhase = null;
    const message = recordUpdateError(error, "check");
    broadcast({ phase: "error", message });
    return { ok: false, error: message };
  }
}

async function checkGitHubUpdate(): Promise<void> {
  let targetVersion: string | undefined;
  let targetURL: string | undefined;
  try {
    const metadata = await fetchLatestGitHubRelease();
    if (!metadata) {
      activePhase = null;
      broadcast({ phase: "up-to-date" });
      return;
    }
    const plan = chooseUpdatePlan(app.getVersion(), metadata.manifest);
    if (!plan) {
      activePhase = null;
      broadcast({ phase: "up-to-date" });
      return;
    }
    targetVersion = plan.targetVersion;
    targetURL = plan.package.url;
    activePhase = "downloading";
    broadcast({
      phase: "downloading",
      percent: 0,
      total: plan.package.size,
      updateMethod: plan.method,
      updateURL: plan.package.url,
      version: plan.targetVersion,
    });
    let downloaded: CustomDownloadedUpdate;
    try {
      downloaded = await downloadAndPrepare(plan, metadata.release.body);
    } catch (error) {
      if (plan.method !== "delta") {
        throw error;
      }
      const reason = error instanceof Error ? error.message : String(error);
      const fallbackPlan: UpdatePlan = {
        ...plan,
        method: "full",
        package: plan.fallback,
      };
      broadcast({
        fallbackReason: "delta-failed",
        phase: "downloading",
        percent: 0,
        total: fallbackPlan.package.size,
        updateMethod: "full",
        updateURL: fallbackPlan.package.url,
        version: fallbackPlan.targetVersion,
      });
      targetURL = fallbackPlan.package.url;
      downloaded = await downloadAndPrepare(
        fallbackPlan,
        metadata.release.body,
        reason
      );
    }
    customDownloaded = downloaded;
    cachedFeedDirectory = downloaded.feedDirectory;
    activePhase = "downloaded";
    notifyDownloaded({
      fallbackReason: downloaded.fallbackReason,
      phase: "downloaded",
      releaseNotes: downloaded.releaseNotes,
      total: downloaded.package.size,
      transferred: downloaded.package.size,
      updateMethod: downloaded.method,
      updateURL: downloaded.package.url,
      version: downloaded.manifest.version,
    });
  } catch (error) {
    activePhase = null;
    const message = recordUpdateError(error, "github-update");
    broadcast({
      ...(targetURL ? { updateURL: targetURL } : {}),
      ...(targetVersion ? { version: targetVersion } : {}),
      message,
      phase: "error",
    });
  }
}

async function fetchLatestGitHubRelease(): Promise<{
  manifest: GitHubUpdateManifest;
  release: { body?: string; tag_name: string };
} | null> {
  const releases = (await requestJSON(releaseApiURL())) as Array<{
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    tag_name?: string;
  }>;
  const release = selectLatestRelease(releases, app.getVersion());
  if (!release?.tag_name) {
    return null;
  }
  const manifest = parseUpdateManifest(
    await requestJSON(
      releaseAssetURL(
        GITHUB_UPDATE_REPOSITORY,
        release.tag_name,
        "update-manifest.json"
      )
    ),
    GITHUB_UPDATE_REPOSITORY
  );
  if (manifest.tag !== release.tag_name) {
    throw new Error("GitHub release and update manifest do not match");
  }
  return {
    manifest,
    release: { body: release.body, tag_name: release.tag_name },
  };
}

async function requestJSON(url: string): Promise<unknown> {
  const bytes = await requestBytes(
    url,
    "application/vnd.github+json",
    UPDATE_METADATA_TIMEOUT_MS
  );
  try {
    return JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("GitHub returned invalid update metadata");
  }
}

function requestBytes(
  url: string,
  accept: string,
  timeoutMs: number
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!net) {
      reject(new Error("Update network is unavailable"));
      return;
    }
    const request = net.request({ method: "GET", url });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error, data?: Buffer) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout) {
        clearTimeout(timeout);
      }
      if (error) {
        reject(error);
      } else {
        resolve(data ?? Buffer.alloc(0));
      }
    };
    timeout = setTimeout(() => {
      request.abort();
      finish(new Error("ETIMEDOUT"));
    }, timeoutMs);
    request.setHeader("Accept", accept);
    request.setHeader("User-Agent", "AI-Image-Manager-Updater");
    request.on("redirect", (_statusCode, _method, redirectURL) => {
      if (!String(redirectURL).startsWith("https://")) {
        request.abort();
        finish(new Error("UPDATE_TLS_ERROR"));
        return;
      }
      request.followRedirect();
    });
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.on("data", () => undefined);
        finish(new Error(`HTTP_STATUS_${status}`));
        request.abort();
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => finish(undefined, Buffer.concat(chunks)));
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

async function downloadAndPrepare(
  plan: UpdatePlan,
  releaseNotes?: string,
  fallbackReason?: string
): Promise<CustomDownloadedUpdate> {
  const feedDirectory = path.join(
    app.getPath("userData"),
    "updates",
    "github",
    plan.targetVersion
  );
  await fsp.mkdir(feedDirectory, { recursive: true });
  const packagePath = path.join(feedDirectory, plan.package.filename);
  await downloadToFile(plan.package, packagePath);
  await fsp.writeFile(
    path.join(feedDirectory, "RELEASES"),
    `${plan.package.sha1} ${plan.package.filename} ${plan.package.size}\n`,
    "utf8"
  );
  await fsp.writeFile(
    path.join(feedDirectory, "update-manifest.json"),
    `${JSON.stringify(plan.manifest, null, 2)}\n`,
    "utf8"
  );
  recordUpdateDiagnostic({
    bytes: plan.package.size,
    fallbackReason,
    filename: plan.package.filename,
    method: plan.method,
    sha256: plan.package.sha256,
  });
  return {
    fallbackReason,
    feedDirectory,
    manifest: plan.manifest,
    method: plan.method,
    package: plan.package,
    releaseNotes,
  };
}

async function downloadToFile(
  packageInfo: UpdatePackage,
  destination: string
): Promise<void> {
  const tempPath = `${destination}.download`;
  await fsp.rm(tempPath, { force: true });
  await fsp.mkdir(path.dirname(destination), { recursive: true });
  const output = createWriteStream(tempPath, { flags: "w" });
  const hash = createHash("sha256");
  const sha1 = createHash("sha1");
  let transferred = 0;
  let lastProgress = Date.now();
  const downloadStartedAt = lastProgress;
  let settled = false;
  await new Promise<void>((resolve, reject) => {
    if (!net) {
      reject(new Error("Update network is unavailable"));
      return;
    }
    const request = net.request({ method: "GET", url: packageInfo.url });
    const timeout = setTimeout(() => {
      request.abort();
      finish(new Error("ETIMEDOUT"));
    }, UPDATE_DOWNLOAD_TIMEOUT_MS);
    const idleTimer = setInterval(() => {
      if (Date.now() - lastProgress > UPDATE_DOWNLOAD_IDLE_TIMEOUT_MS) {
        request.abort();
        finish(new Error("ETIMEDOUT"));
      }
    }, 1000);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearInterval(idleTimer);
      output.destroy();
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    request.setHeader("Accept", "application/octet-stream");
    request.setHeader("User-Agent", "AI-Image-Manager-Updater");
    request.on("redirect", (_statusCode, _method, redirectURL) => {
      if (!String(redirectURL).startsWith("https://")) {
        request.abort();
        finish(new Error("UPDATE_TLS_ERROR"));
        return;
      }
      request.followRedirect();
    });
    request.on("response", (response) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.on("data", () => undefined);
        finish(new Error(`HTTP_STATUS_${status}`));
        request.abort();
        return;
      }
      response.on("data", (chunk: Buffer) => {
        lastProgress = Date.now();
        transferred += chunk.byteLength;
        hash.update(chunk);
        sha1.update(chunk);
        output.write(chunk);
        broadcast({
          bytesPerSecond: Math.round(
            transferred / Math.max(1, (Date.now() - downloadStartedAt) / 1000)
          ),
          percent: Math.min(
            100,
            Math.round((transferred / packageInfo.size) * 100)
          ),
          phase: "downloading",
          total: packageInfo.size,
          transferred,
        });
      });
      response.on("end", () => {
        output.end(() => {
          if (
            transferred !== packageInfo.size ||
            hash.digest("hex") !== packageInfo.sha256.toLowerCase() ||
            sha1.digest("hex") !== packageInfo.sha1.toLowerCase()
          ) {
            finish(new Error("Checksummed file size or hash does not match"));
            return;
          }
          finish();
        });
      });
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    request.end();
  }).catch(async (error) => {
    await fsp.rm(tempPath, { force: true });
    throw error;
  });
  await fsp.rename(tempPath, destination);
}

function recordUpdateDiagnostic(fields: Record<string, unknown>) {
  try {
    recordUpdateError(
      new Error(`package=${JSON.stringify(fields)}`),
      "github-download-proof"
    );
  } catch {
    // Diagnostics are best effort and must not block a verified update.
  }
}

function scheduleAutomaticChecks() {
  if (initialCheckTimer || updateTimer) {
    return;
  }

  // The first-run argument is intentionally not a bypass. It follows the
  // same delayed path as every other startup, ensuring no immediate network
  // request races Squirrel's bootstrap process.
  initialCheckTimer = setTimeout(() => {
    initialCheckTimer = null;
    check();
    updateTimer = setInterval(check, UPDATE_INTERVAL_MS);
  }, UPDATE_INITIAL_DELAY_MS);
}

export function startUpdateManager() {
  if (
    !(
      configure() &&
      readBoolean(
        APP_PREFERENCE_KEYS.updateAutoUpdate,
        APP_PREFERENCE_DEFAULTS.updateAutoUpdate
      )
    )
  ) {
    stopAutomaticChecks();
    return;
  }
  scheduleAutomaticChecks();
}

export function stopAutomaticChecks() {
  if (initialCheckTimer) {
    clearTimeout(initialCheckTimer);
    initialCheckTimer = null;
  }
  if (updateTimer) {
    clearInterval(updateTimer);
    updateTimer = null;
  }
}

export function setAutoUpdateEnabled(enabled: boolean) {
  if (enabled) {
    startUpdateManager();
  } else {
    stopAutomaticChecks();
  }
}

export function checkForUpdatesManually() {
  return check();
}

export function setReminderEnabled(enabled: boolean) {
  if (!enabled) {
    return;
  }
  const current = getCurrentUpdateStatus();
  if (current?.phase === "downloaded") {
    activePhase = "downloaded";
    notifyDownloaded(current);
  }
}

function getCurrentUpdateStatus(): UpdatePayload | null {
  return getUpdateState(app.getVersion());
}

export function installUpdate(): UpdateResult {
  if (!isSupportedEnvironment()) {
    return { ok: false, error: "DEV_MODE" };
  }
  if (!isSquirrelInstallation()) {
    return { ok: false, error: "UPDATE_INSTALLER_UNSUPPORTED" };
  }

  if (!isLegacyUpdaterPath()) {
    const feedDirectory =
      customDownloaded?.feedDirectory ?? cachedFeedDirectory;
    if (activePhase !== "downloaded" || !feedDirectory) {
      return { ok: false, error: "UPDATE_NOT_READY" };
    }
    if (installTask) {
      return { ok: true, skipped: true };
    }
    installTask = applyLocalUpdate(feedDirectory).finally(() => {
      installTask = null;
    });
    return { ok: true };
  }

  if (activePhase !== "downloaded") {
    const current = getCurrentUpdateStatus();
    if (current?.phase === "downloaded") {
      activePhase = "downloaded";
    }
  }
  if (activePhase !== "downloaded") {
    return { ok: false, error: "UPDATE_NOT_READY" };
  }

  try {
    // Keep the downloaded lock until Squirrel has restarted the application.
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (error) {
    const message = recordUpdateError(error, "install");
    return { ok: false, error: message };
  }
}

async function applyLocalUpdate(feedDirectory: string): Promise<void> {
  try {
    await runLocalSquirrelUpdate(feedDirectory);
    app.relaunch({
      args: process.argv
        .slice(1)
        .filter((argument) => !argument.startsWith("--squirrel-")),
    });
    app.quit();
  } catch (error) {
    let installError = error;
    if (
      customDownloaded?.method === "delta" &&
      !customDownloaded.fallbackReason
    ) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        const fallbackPackage = customDownloaded.manifest.packages.full;
        const fallbackPlan: UpdatePlan = {
          currentVersion: app.getVersion(),
          fallback: fallbackPackage,
          manifest: customDownloaded.manifest,
          method: "full",
          package: fallbackPackage,
          targetVersion: customDownloaded.manifest.version,
        };
        const downloaded = await downloadAndPrepare(
          fallbackPlan,
          customDownloaded.releaseNotes,
          reason
        );
        customDownloaded = downloaded;
        cachedFeedDirectory = downloaded.feedDirectory;
        activePhase = "downloaded";
        notifyDownloaded({
          fallbackReason: downloaded.fallbackReason,
          phase: "downloaded",
          releaseNotes: downloaded.releaseNotes,
          total: downloaded.package.size,
          transferred: downloaded.package.size,
          updateMethod: downloaded.method,
          updateURL: downloaded.package.url,
          version: downloaded.manifest.version,
        });
        await runLocalSquirrelUpdate(downloaded.feedDirectory);
        app.relaunch({
          args: process.argv
            .slice(1)
            .filter((argument) => !argument.startsWith("--squirrel-")),
        });
        app.quit();
        return;
      } catch (fallbackError) {
        installError = fallbackError;
      }
    }
    activePhase = null;
    const message = recordUpdateError(installError, "install-github-update");
    broadcast({ phase: "error", message });
  }
}

async function runLocalSquirrelUpdate(feedDirectory: string): Promise<void> {
  const executableDirectory = path.dirname(process.execPath);
  const updateExecutable = [
    path.join(executableDirectory, "Update.exe"),
    path.resolve(executableDirectory, "..", "Update.exe"),
  ].find((candidate) => existsSync(candidate));
  if (!updateExecutable) {
    throw new Error("UPDATE_INSTALLER_UNSUPPORTED");
  }
  await new Promise<void>((resolve, reject) => {
    const child = spawn(updateExecutable, ["--update", feedDirectory], {
      windowsHide: true,
    });
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, UPDATE_INSTALL_TIMEOUT_MS);
    const finish = (error?: Error) => {
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    child.once("error", (error) =>
      finish(timedOut ? new Error("UPDATE_INSTALL_TIMEOUT") : error)
    );
    child.once("exit", (code) => {
      if (timedOut) {
        finish(new Error("UPDATE_INSTALL_TIMEOUT"));
      } else if (code === 0) {
        finish();
      } else {
        finish(new Error(`Squirrel update exited with code ${code}`));
      }
    });
  });
}
