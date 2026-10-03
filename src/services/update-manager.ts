import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
import {
  downloadUpdatePackage,
  PackageRequestError,
  verifyUpdatePackage,
} from "@/services/update-download";
import { recordUpdateError } from "@/services/update-error";
import { getUpdateState, setUpdateState } from "@/services/update-state";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
} from "@/types/app-preferences";
import type { UpdateErrorCode, UpdateResult } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

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
export const UPDATE_CHECK_RETRY_COOLDOWN_MS = 15 * 1000;
const UPDATE_INSTALL_KILL_GRACE_MS = 5 * 1000;

const MAX_INSTALL_OUTPUT_CHARS = 8 * 1024;
const MAX_UPDATE_ERROR_BODY_BYTES = 16 * 1024;
const RELAUNCH_TOKEN_PREFIX = "--aim-update-token=";
const STABLE_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const TRAILING_SLASH_RE = /\/$/;
const DELTA_FALLBACK_BLOCK_RE =
  /UPDATE_(?:INSTALL_TIMEOUT|RESTART_REQUIRED|INSTALLER_UNSUPPORTED)|permission|access denied|disk full|not enough space|ENOSPC|EACCES|EPERM|busy|in use|locked|another.*instance|mutex/i;
const DELTA_PATCH_FAILURE_RE =
  /(?:delta|patch|baseline).*(?:corrupt|invalid|mismatch|missing|not found|cannot)|(?:cannot|could not|failed to).*(?:apply.*patch|apply.*delta|find.*base package)|checksum.*mismatch/i;
const SENSITIVE_DIAGNOSTIC_RE =
  /\b((?:authorization|proxy-authorization|cookie|set-cookie|token|access[_-]?token|refresh[_-]?token|password|passwd|secret|api[_-]?key)\s*[:=]\s*)[^\s,;]+/gi;
const SENSITIVE_QUERY_RE =
  /([?&](?:access[_-]?token|refresh[_-]?token|token|signature|sig|key|password)=)[^&\s]+/gi;

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

interface DownloadTask {
  fallbackReason?: string;
  operation: "download" | "install";
  plan: UpdatePlan;
  releaseNotes?: string;
}
let pendingDownload: DownloadTask | null = null;
let downloadTask: Promise<void> | null = null;
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
let installRecoveryTimer: ReturnType<typeof setInterval> | null = null;
let updateQuitAllowed = false;
let downloadedStatus: UpdatePayload | null = null;

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
    phase === "checking" ||
    phase === "downloading" ||
    phase === "retry-wait" ||
    phase === "downloaded" ||
    phase === "installing" ||
    phase === "recovering" ||
    phase === "restarting"
  );
}

function isInstallationPhase(phase: UpdatePhase | null | undefined): boolean {
  return (
    phase === "installing" || phase === "recovering" || phase === "restarting"
  );
}

function nowISO(): string {
  return new Date().toISOString();
}

function getRelaunchToken(): string | undefined {
  const argument = process.argv.find((value) =>
    value.startsWith(RELAUNCH_TOKEN_PREFIX)
  );
  return argument?.slice(RELAUNCH_TOKEN_PREFIX.length) || undefined;
}

function isProcessRunning(pid: number | undefined): boolean {
  if (!pid || pid === process.pid) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Windows can report EPERM for a live process that this process cannot
    // inspect. Treat that as alive so recovery never starts a second installer.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function setInstallStatus(
  phase: "installing" | "recovering" | "restarting",
  extra: Partial<UpdatePayload> = {}
): void {
  const stored = getUpdateState();
  const current = { ...downloadedStatus, ...stored };
  const startedAt = current.installStartedAt ?? nowISO();
  activePhase = phase;
  broadcast({
    ...current,
    ...extra,
    percent: undefined,
    bytesPerSecond: undefined,
    networkWaiting: false,
    retryAfter: undefined,
    message: undefined,
    canResume: false,
    canUseFull: false,
    installStartedAt: startedAt,
    operation: "install",
    phase,
    phaseStartedAt: nowISO(),
    version: extra.version ?? current.version,
  });
}

export function isUpdateInstallationActive(): boolean {
  return (
    installTask !== null ||
    isProcessRunning(getUpdateState().installerPid) ||
    activePhase === "installing" ||
    activePhase === "recovering" ||
    activePhase === "restarting"
  );
}

export function isUpdateQuitAllowed(): boolean {
  return updateQuitAllowed;
}

function markUpdateQuitAllowed(): void {
  updateQuitAllowed = true;
}

function clearInstallRecoveryTimer(): void {
  if (installRecoveryTimer) {
    clearInterval(installRecoveryTimer);
    installRecoveryTimer = null;
  }
}

function markInterruptedInstall(
  current: UpdatePayload,
  message: UpdateErrorCode = "UPDATE_INSTALL_INTERRUPTED"
): void {
  clearInstallRecoveryTimer();
  updateQuitAllowed = false;
  activePhase = customDownloaded ? "downloaded" : null;
  broadcast({
    ...current,
    message,
    operation: "install",
    phase: "error",
    phaseStartedAt: nowISO(),
  });
}

function scheduleInstallRecovery(expected: UpdatePayload): void {
  if (installRecoveryTimer || !expected.installerPid) {
    return;
  }
  const started = Date.now();
  installRecoveryTimer = setInterval(() => {
    const current = getUpdateState();
    if (
      isProcessRunning(expected.installerPid) &&
      Date.now() - started < UPDATE_INSTALL_TIMEOUT_MS
    ) {
      return;
    }
    // An orphan's exit status is unknown. Reinstall the verified cache instead
    // of assuming that an existing target directory is a complete install.
    markInterruptedInstall(
      current,
      isProcessRunning(expected.installerPid)
        ? "UPDATE_INSTALL_TIMEOUT"
        : "UPDATE_INSTALL_INTERRUPTED"
    );
  }, 2000);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: reconcile durable state once before accepting commands
function hydrateDownloadedLock() {
  const current = getUpdateState();
  customDownloaded = null;
  pendingDownload = null;
  cachedFeedDirectory = null;
  downloadedStatus = null;
  activePhase = null;
  const version = current.version;
  if (version && STABLE_VERSION_RE.test(version) && !isLegacyUpdaterPath()) {
    const directory = path.join(
      app.getPath("userData"),
      "updates",
      "github",
      version
    );
    try {
      if (existsSync(path.join(directory, "RELEASES"))) {
        customDownloaded = restoreDownloadedMetadata(current, directory);
        if (customDownloaded) {
          cachedFeedDirectory = directory;
        }
      }
      if (
        ["downloading", "retry-wait", "recovering"].includes(current.phase) ||
        (current.phase === "error" && current.operation === "download")
      ) {
        pendingDownload = restoreDownloadTask(current, directory);
      }
    } catch (error) {
      recordUpdateError(error, "restore-update-cache");
    }
  }
  const installation =
    isInstallationPhase(current.phase) ||
    (current.phase === "error" && current.operation === "install");
  const token = getRelaunchToken();
  const pathMatches =
    version &&
    path.basename(path.dirname(process.execPath)) === `app-${version}`;
  const completed =
    current.installCompletedAt || current.phase === "restarting";
  const legacyDownloaded = current.phase === "downloaded";
  if (
    version === app.getVersion() &&
    pathMatches &&
    (completed || legacyDownloaded) &&
    (!token || token === current.relaunchToken) &&
    !isProcessRunning(current.installerPid)
  ) {
    recordUpdateDiagnostic({
      actualVersion: app.getVersion(),
      expectedVersion: version,
      relaunch: token ? "automatic" : "manual",
      result: "success",
    });
    broadcast({
      phase: "idle",
      lastCheckedAt: current.lastCheckedAt,
      lastCheckResult: current.lastCheckResult,
    });
    pendingDownload = null;
    customDownloaded = null;
    cachedFeedDirectory = null;
    return;
  }
  if (installation && version) {
    if (isProcessRunning(current.installerPid)) {
      activePhase = "installing";
      scheduleInstallRecovery(current);
      return;
    }
    if (completed && !(token && token !== current.relaunchToken)) {
      try {
        launchInstalledVersion(version);
        return;
      } catch {
        markInterruptedInstall(current, "UPDATE_RESTART_REQUIRED");
        return;
      }
    }
    markInterruptedInstall(current);
    return;
  }
  if (current.phase === "downloaded") {
    // Legacy native-updater tests have no custom feed; production needs a cache.
    if (customDownloaded || isLegacyUpdaterPath()) {
      activePhase = "downloaded";
      downloadedStatus = current;
    } else {
      broadcast({
        ...current,
        phase: "error",
        operation: "check",
        message: "UPDATE_NOT_READY",
      });
    }
  } else if (pendingDownload) {
    broadcast({
      ...current,
      phase: "error",
      operation: "download",
      bytesPerSecond: 0,
      networkWaiting: false,
      message: current.message ?? "NETWORK_ERROR",
      canResume: true,
      canUseFull: pendingDownload.plan.method === "delta",
    });
  } else if (
    ["checking", "downloading", "retry-wait"].includes(current.phase)
  ) {
    broadcast({
      ...current,
      phase: "error",
      operation: "check",
      message: "NETWORK_ERROR",
      canResume: false,
      canUseFull: false,
    });
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
  if (manifest.version !== current.version) {
    return null;
  }
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
  const previous = getUpdateState();
  const next: UpdatePayload = {
    ...(previous.lastCheckedAt && !payload.lastCheckedAt
      ? { lastCheckedAt: previous.lastCheckedAt }
      : {}),
    ...(previous.lastCheckResult && !payload.lastCheckResult
      ? { lastCheckResult: previous.lastCheckResult }
      : {}),
    ...(previous.etag && !payload.etag ? { etag: previous.etag } : {}),
    ...payload,
  };
  setUpdateState(next);
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("update:status", next);
    }
  }
}

function notifyDownloaded(payload: UpdatePayload) {
  downloadedStatus = { ...payload };
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
    if (activePhase === "downloaded" || isInstallationPhase(activePhase)) {
      return;
    }
    activePhase = "checking";
    broadcast({ operation: "check", phase: "checking" });
  });
  // Electron's update-available event does not carry update metadata. The
  // downloaded event below is the first point where release details exist.
  updater.on("update-available", () => {
    if (activePhase === "downloaded" || isInstallationPhase(activePhase)) {
      return;
    }
    activePhase = "downloading";
    broadcast({ operation: "check", phase: "downloading" });
  });
  updater.on("update-not-available", () => {
    if (activePhase === "downloaded" || isInstallationPhase(activePhase)) {
      return;
    }
    activePhase = null;
    broadcast({
      lastCheckedAt: nowISO(),
      lastCheckResult: "up-to-date",
      operation: "check",
      phase: "up-to-date",
    });
  });
  updater.on("error", (...args) => {
    if (activePhase === "downloaded") {
      return;
    }
    const operation = isInstallationPhase(activePhase) ? "install" : "check";
    activePhase = null;
    updateQuitAllowed = false;
    const message = recordUpdateError(args[0], "update-event");
    broadcast({ message, operation, phase: "error" });
  });

  updater.on("update-downloaded", (...args) => {
    if (activePhase === "downloaded" || isInstallationPhase(activePhase)) {
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
      lastCheckedAt: nowISO(),
      lastCheckResult: "update-available",
      operation: "check",
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
      if (activePhase === "downloaded" || isInstallationPhase(activePhase)) {
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
        operation: "check",
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

  try {
    // Durable install recovery is independent of the automatic-check
    // preference and of the network feed configuration.
    hydrateDownloadedLock();
  } catch (error) {
    configurationError = recordUpdateError(error, "hydrate-update");
  }

  const feedURL = getUpdateFeedURL();
  if (!feedURL) {
    configurationError = "UPDATE_NOT_FOUND";
    return false;
  }

  try {
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
  if (pendingDownload && !downloadTask && !isLockedPhase(activePhase)) {
    // Exhausted downloads require an explicit user action, including after
    // restart; the periodic checker must not silently restart the retry budget.
    return { ok: true, skipped: true };
  }
  const persisted = getCurrentUpdateStatus();
  if (persisted?.retryAfter && Date.parse(persisted.retryAfter) > Date.now()) {
    const retryError = persisted.message;
    return {
      ok: false,
      error:
        retryError === "UPDATE_RATE_LIMITED" ||
        retryError === "UPDATE_SERVICE_UNAVAILABLE"
          ? retryError
          : "NETWORK_ERROR",
    };
  }
  if (isLockedPhase(activePhase)) {
    return { ok: true, skipped: true };
  }

  activePhase = "checking";
  // Mark the lock before calling into Electron. Some updater versions emit
  // checking-for-update asynchronously, and a second IPC call can otherwise
  // slip through during that gap.
  broadcast({ operation: "check", phase: "checking" });
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
      broadcast({
        etag: getCurrentUpdateStatus()?.etag,
        lastCheckedAt: nowISO(),
        lastCheckResult: "up-to-date",
        operation: "check",
        phase: "up-to-date",
      });
      return;
    }
    const plan = chooseUpdatePlan(app.getVersion(), metadata.manifest);
    if (!plan) {
      activePhase = null;
      broadcast({
        etag: metadata.etag,
        lastCheckedAt: nowISO(),
        lastCheckResult: "up-to-date",
        operation: "check",
        phase: "up-to-date",
      });
      return;
    }
    targetVersion = plan.targetVersion;
    targetURL = plan.package.url;
    broadcast({
      transactionId: randomUUID(),
      sourceVersion: app.getVersion(),
      etag: metadata.etag,
      lastCheckedAt: nowISO(),
      lastCheckResult: "update-available",
      operation: "download",
      phase: "downloading",
      version: plan.targetVersion,
      updateMethod: plan.method,
      updateURL: plan.package.url,
      phaseStartedAt: nowISO(),
    });
    pendingDownload = {
      plan,
      releaseNotes: metadata.release.body,
      operation: "download",
    };
    await executeDownloadTask();
  } catch (error) {
    activePhase = null;
    if (error instanceof UpdateRequestError) {
      recordUpdateDiagnostic({
        body: error.bodySummary,
        headers: error.rateHeaders,
        retryAfter: error.retryAfter,
        stage: "github-update-check",
        status: error.status,
      });
    } else {
      recordUpdateDiagnostic({
        error: error instanceof Error ? error.message : String(error),
        stage: "github-update-check",
      });
    }
    const message = recordUpdateError(error, "github-update");
    const retryAfter =
      error instanceof UpdateRequestError
        ? (error.retryAfter ??
          (message === "UPDATE_RATE_LIMITED" ||
          message === "UPDATE_SERVICE_UNAVAILABLE"
            ? new Date(
                Date.now() + UPDATE_CHECK_RETRY_COOLDOWN_MS
              ).toISOString()
            : undefined))
        : undefined;
    broadcast({
      ...(targetURL ? { updateURL: targetURL } : {}),
      ...(targetVersion ? { version: targetVersion } : {}),
      message,
      operation: "check",
      phase: "error",
      ...(retryAfter ? { retryAfter } : {}),
    });
  }
}

function fullDownloadTask(task: DownloadTask, reason: string): DownloadTask {
  return {
    ...task,
    fallbackReason: reason,
    plan: { ...task.plan, method: "full", package: task.plan.fallback },
  };
}

async function executeDownloadTask(): Promise<void> {
  let task = pendingDownload;
  if (!task) {
    return;
  }
  activePhase = "downloading";
  broadcast({
    ...getUpdateState(),
    phase: "downloading",
    operation: task.operation,
    resumeInstallation: task.operation === "install",
    version: task.plan.targetVersion,
    updateMethod: task.plan.method,
    updateURL: task.plan.package.url,
    releaseNotes: task.releaseNotes,
    fallbackReason: task.fallbackReason,
    percent: 0,
    canResume: false,
    canUseFull: false,
    message: undefined,
    retryAfter: undefined,
  });
  try {
    let downloaded: CustomDownloadedUpdate;
    try {
      downloaded = await downloadAndPrepare(
        task.plan,
        task.releaseNotes,
        task.fallbackReason,
        task.fallbackReason,
        task.operation
      );
    } catch (error) {
      const code = classifyUpdateError(error);
      if (
        task.plan.method !== "delta" ||
        !["UPDATE_NOT_FOUND", "UPDATE_PACKAGE_CORRUPT"].includes(code)
      ) {
        throw error;
      }
      recordUpdateDiagnostic({
        stage: "delta-download-fallback",
        failure: code,
      });
      task = fullDownloadTask(
        task,
        code === "UPDATE_NOT_FOUND" ? "delta-missing" : "delta-corrupt"
      );
      pendingDownload = task;
      broadcast({
        ...getUpdateState(),
        updateMethod: "full",
        fallbackReason: task.fallbackReason,
        updateURL: task.plan.package.url,
        transferred: 0,
        total: task.plan.package.size,
        percent: 0,
      });
      downloaded = await downloadAndPrepare(
        task.plan,
        task.releaseNotes,
        task.fallbackReason,
        task.fallbackReason,
        task.operation
      );
    }
    customDownloaded = downloaded;
    cachedFeedDirectory = downloaded.feedDirectory;
    pendingDownload = null;
    activePhase = "downloaded";
    const status: UpdatePayload = {
      ...getUpdateState(),
      phase: "downloaded",
      operation: "download",
      message: undefined,
      retryAfter: undefined,
      networkWaiting: false,
      canResume: false,
      canUseFull: false,
      total: downloaded.package.size,
      transferred: downloaded.package.size,
      percent: 100,
      bytesPerSecond: 0,
      fallbackReason: downloaded.fallbackReason,
      updateMethod: downloaded.method,
    };
    if (task.operation === "install") {
      downloadedStatus = status;
      broadcast(status);
      installUpdate();
    } else {
      notifyDownloaded(status);
    }
  } catch (error) {
    activePhase = null;
    const message = recordUpdateError(error, "download-update");
    broadcast({
      ...getUpdateState(),
      phase: "error",
      operation: "download",
      message,
      bytesPerSecond: 0,
      networkWaiting: false,
      canResume: true,
      canUseFull: task.plan.method === "delta",
      retryAfter:
        error instanceof PackageRequestError ? error.retryAfter : undefined,
    });
    recordUpdateDiagnostic({
      stage: "download-interrupted",
      failure: message,
      method: task.plan.method,
    });
  }
}

export function resumeUpdateDownload(useFull = false): UpdateResult {
  if (!isSupportedEnvironment()) {
    return { ok: false, error: "DEV_MODE" };
  }
  if (!configure()) {
    return { ok: false, error: configurationError };
  }
  if (
    downloadTask ||
    installTask ||
    isLockedPhase(activePhase) ||
    isProcessRunning(getUpdateState().installerPid)
  ) {
    return { ok: false, error: "UPDATE_BUSY" };
  }
  if (!pendingDownload) {
    return { ok: false, error: "UPDATE_NOT_READY" };
  }
  const retryAfter = getUpdateState().retryAfter;
  if (retryAfter && Date.parse(retryAfter) > Date.now()) {
    return { ok: false, error: "UPDATE_RATE_LIMITED" };
  }
  if (useFull) {
    pendingDownload = fullDownloadTask(pendingDownload, "user-selected");
  }
  downloadTask = executeDownloadTask().finally(() => {
    downloadTask = null;
  });
  return { ok: true };
}

function restoreDownloadTask(
  current: UpdatePayload,
  directory: string
): DownloadTask | null {
  const manifest = parseUpdateManifest(
    JSON.parse(
      readFileSync(path.join(directory, "update-manifest.json"), "utf8")
    ),
    GITHUB_UPDATE_REPOSITORY
  );
  if (manifest.version !== current.version) {
    return null;
  }
  const selected = chooseUpdatePlan(app.getVersion(), manifest);
  if (!selected) {
    return null;
  }
  const plan: UpdatePlan =
    current.updateMethod === "full"
      ? { ...selected, method: "full", package: selected.fallback }
      : selected;
  return {
    plan,
    operation:
      current.operation === "install" || current.resumeInstallation
        ? "install"
        : "download",
    releaseNotes: current.releaseNotes,
    fallbackReason: current.fallbackReason,
  };
}

async function fetchLatestGitHubRelease(): Promise<{
  etag?: string;
  manifest: GitHubUpdateManifest;
  release: { body?: string; tag_name: string };
} | null> {
  const response = await requestJSON(releaseApiURL(), {
    etag: getCurrentUpdateStatus()?.etag,
  });
  if (response.status === 304) {
    return null;
  }
  const releases = response.value as Array<{
    body?: string;
    draft?: boolean;
    prerelease?: boolean;
    tag_name?: string;
  }>;
  const release = selectLatestRelease(releases, app.getVersion());
  if (!release?.tag_name) {
    return null;
  }
  const manifestResponse = await requestJSON(
    releaseAssetURL(
      GITHUB_UPDATE_REPOSITORY,
      release.tag_name,
      "update-manifest.json"
    )
  );
  const manifest = parseUpdateManifest(
    manifestResponse.value,
    GITHUB_UPDATE_REPOSITORY
  );
  if (manifest.tag !== release.tag_name) {
    throw new Error("GitHub release and update manifest do not match");
  }
  return {
    etag: response.etag,
    manifest,
    release: { body: release.body, tag_name: release.tag_name },
  };
}

interface JSONRequestOptions {
  etag?: string;
}

interface JSONResponse {
  etag?: string;
  status: number;
  value: unknown;
}

function sanitizeDiagnosticText(
  value: string,
  limit = MAX_INSTALL_OUTPUT_CHARS
): string {
  return value
    .split("")
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code !== 127;
    })
    .join("")
    .replace(SENSITIVE_DIAGNOSTIC_RE, "$1=[redacted]")
    .replace(SENSITIVE_QUERY_RE, "$1=[redacted]")
    .slice(-limit);
}

function sanitizeDiagnosticValue(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizeDiagnosticText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeDiagnosticValue(item));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeDiagnosticValue(item),
      ])
    );
  }
  return value;
}

class UpdateRequestError extends Error {
  readonly bodySummary: string;
  readonly rateHeaders: Record<string, string>;
  readonly retryAfter?: string;
  readonly status: number;

  constructor(status: number, headers: Record<string, string>, body: Buffer) {
    const bodyText = sanitizeDiagnosticText(
      body.toString("utf8").replace(/\s+/g, " "),
      512
    );
    const headerText = [
      "retry-after",
      "x-ratelimit-remaining",
      "x-ratelimit-reset",
    ]
      .filter((name) => headers[name])
      .map((name) => `${name}=${headers[name]}`)
      .join(" ");
    super(
      `HTTP_STATUS_${status}${headerText ? ` ${headerText}` : ""}${bodyText ? ` body=${bodyText}` : ""}`
    );
    this.name = "UpdateRequestError";
    this.bodySummary = bodyText;
    this.rateHeaders = Object.fromEntries(
      ["retry-after", "x-ratelimit-remaining", "x-ratelimit-reset"]
        .filter((name) => headers[name])
        .map((name) => [name, headers[name]])
    );
    this.status = status;
    this.retryAfter = retryAfterISO(headers);
  }
}

function retryAfterISO(headers: Record<string, string>): string | undefined {
  const retryAfter = headers["retry-after"];
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds)) {
      return new Date(Date.now() + Math.max(0, seconds) * 1000).toISOString();
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return new Date(date).toISOString();
    }
  }
  const reset = Number(headers["x-ratelimit-reset"]);
  if (Number.isFinite(reset) && reset > 0) {
    return new Date(reset * 1000).toISOString();
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    return new Date(Date.now() + UPDATE_CHECK_RETRY_COOLDOWN_MS).toISOString();
  }
  return undefined;
}

function normalizeResponseHeaders(response: {
  headers?: Record<string, string | string[]>;
}): Record<string, string> {
  return Object.fromEntries(
    Object.entries(response.headers ?? {}).map(([key, value]) => [
      key.toLowerCase(),
      Array.isArray(value) ? value.join(", ") : String(value),
    ])
  );
}

async function requestJSON(
  url: string,
  options: JSONRequestOptions = {}
): Promise<JSONResponse> {
  const response = await requestBytes(
    url,
    "application/vnd.github+json",
    UPDATE_METADATA_TIMEOUT_MS,
    options.etag
  );
  if (response.status === 304) {
    return { status: response.status, value: null };
  }
  try {
    return {
      etag: response.etag,
      status: response.status,
      value: JSON.parse(response.body.toString("utf8")),
    };
  } catch {
    throw new Error("GitHub returned invalid update metadata");
  }
}

interface ByteResponse {
  body: Buffer;
  etag?: string;
  status: number;
}

function requestBytes(
  url: string,
  accept: string,
  timeoutMs: number,
  etag?: string
): Promise<ByteResponse> {
  return new Promise((resolve, reject) => {
    if (!net) {
      reject(new Error("Update network is unavailable"));
      return;
    }
    const request = net.request({ method: "GET", url });
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    const finish = (error?: Error, data?: ByteResponse) => {
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
        resolve(data ?? { body: Buffer.alloc(0), status: 0 });
      }
    };
    timeout = setTimeout(() => {
      request.abort();
      finish(new Error("ETIMEDOUT"));
    }, timeoutMs);
    request.setHeader("Accept", accept);
    request.setHeader("User-Agent", "AI-Image-Manager-Updater");
    if (etag) {
      request.setHeader("If-None-Match", etag);
    }
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
      const headers = normalizeResponseHeaders(response);
      const chunks: Buffer[] = [];
      let captured = 0;
      response.on("data", (chunk: Buffer) => {
        if (status >= 200 && status < 300) {
          chunks.push(chunk);
          return;
        }
        if (captured >= MAX_UPDATE_ERROR_BODY_BYTES) {
          return;
        }
        const remaining = MAX_UPDATE_ERROR_BODY_BYTES - captured;
        const bounded = chunk.subarray(0, remaining);
        chunks.push(bounded);
        captured += bounded.byteLength;
      });
      response.on("end", () => {
        const body = Buffer.concat(chunks);
        if (status < 200 || (status >= 300 && status !== 304)) {
          finish(new UpdateRequestError(status, headers, body));
          return;
        }
        finish(undefined, {
          body,
          etag: headers.etag,
          status,
        });
      });
      response.on("error", (error) => finish(error));
    });
    request.on("error", (error) => finish(error));
    request.end();
  });
}

async function downloadAndPrepare(
  plan: UpdatePlan,
  releaseNotes?: string,
  fallbackReason?: string,
  progressFallbackReason?: string,
  operation: UpdatePayload["operation"] = "download"
): Promise<CustomDownloadedUpdate> {
  const feedDirectory = path.join(
    app.getPath("userData"),
    "updates",
    "github",
    plan.targetVersion
  );
  await fsp.mkdir(feedDirectory, { recursive: true });
  await fsp.writeFile(
    path.join(feedDirectory, "update-manifest.json"),
    JSON.stringify(plan.manifest),
    "utf8"
  );
  const packagePath = path.join(feedDirectory, plan.package.filename);
  await downloadToFile(
    plan.package,
    packagePath,
    progressFallbackReason,
    operation
  );
  await fsp.writeFile(
    path.join(feedDirectory, "RELEASES"),
    formatLocalReleaseFeed(plan),
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

/**
 * Squirrel needs a full entry to calculate whether the downloaded delta is
 * smaller, but it only reads the selected package from the local directory.
 * Keep that metadata in the delta feed without downloading the full package;
 * a full fallback deliberately rewrites the feed to a single full entry.
 */
export function formatLocalReleaseFeed(plan: UpdatePlan): string {
  const packages =
    plan.method === "delta" && plan.manifest.packages.delta
      ? [plan.manifest.packages.full, plan.manifest.packages.delta]
      : [plan.manifest.packages.full];
  return `${packages
    .map((packageInfo) =>
      [packageInfo.sha1, packageInfo.filename, packageInfo.size].join(" ")
    )
    .join("\n")}\n`;
}

async function downloadToFile(
  packageInfo: UpdatePackage,
  destination: string,
  fallbackReason?: string,
  operation: UpdatePayload["operation"] = "download"
): Promise<void> {
  await downloadUpdatePackage(packageInfo, destination, (progress) => {
    activePhase = progress.phase ?? "downloading";
    broadcast({ ...getUpdateState(), ...progress, operation, fallbackReason });
    if (progress.phase === "retry-wait") {
      recordUpdateDiagnostic({
        stage: "download-retry",
        attempt: progress.attempt,
        reason: progress.message,
        retryAfter: progress.retryAfter,
      });
    }
  });
}

function recordUpdateDiagnostic(fields: Record<string, unknown>) {
  try {
    recordUpdateError(
      new Error(
        `package=${JSON.stringify(sanitizeDiagnosticValue({ transactionId: getUpdateState().transactionId, sourceVersion: getUpdateState().sourceVersion, targetVersion: getUpdateState().version, ...fields }))}`
      ),
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
  if (pendingDownload && !downloadTask && !isLockedPhase(activePhase)) {
    return resumeUpdateDownload();
  }
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
  return getUpdateState();
}

export function installUpdate(): UpdateResult {
  if (!isSupportedEnvironment()) {
    return { ok: false, error: "DEV_MODE" };
  }
  if (!isSquirrelInstallation()) {
    return { ok: false, error: "UPDATE_INSTALLER_UNSUPPORTED" };
  }

  if (!isLegacyUpdaterPath()) {
    if (installTask) {
      return { ok: true, skipped: true };
    }
    const feedDirectory =
      customDownloaded?.feedDirectory ?? cachedFeedDirectory;
    const current = getCurrentUpdateStatus();
    if (isProcessRunning(current?.installerPid)) {
      return { ok: false, error: "UPDATE_BUSY" };
    }
    const canRetryInstall =
      current?.phase === "error" && current.operation === "install";
    if (
      !(
        (activePhase === "downloaded" || canRetryInstall) &&
        feedDirectory &&
        customDownloaded
      )
    ) {
      return { ok: false, error: "UPDATE_NOT_READY" };
    }
    const update = customDownloaded;
    updateQuitAllowed = false;
    setInstallStatus("installing", {
      fallbackReason: update.fallbackReason,
      updateMethod: update.method,
      updateURL: update.package.url,
      version: update.manifest.version,
      relaunchToken: randomUUID(),
      restartAttempts: 0,
      installCompletedAt: undefined,
      installerPid: undefined,
      resumeInstallation: false,
    });
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
    const current = getCurrentUpdateStatus();
    setInstallStatus("installing", {
      version: current?.version,
    });
    // Keep the downloaded lock until Squirrel has restarted the application.
    markUpdateQuitAllowed();
    autoUpdater.quitAndInstall();
    return { ok: true };
  } catch (error) {
    updateQuitAllowed = false;
    activePhase = "downloaded";
    const message = recordUpdateError(error, "install");
    broadcast({
      ...getCurrentUpdateStatus(),
      message,
      operation: "install",
      phase: "error",
      phaseStartedAt: nowISO(),
    });
    return { ok: false, error: message };
  }
}

function getInstallRoot(): string {
  const executableDirectory = path.dirname(process.execPath);
  return path.basename(executableDirectory).startsWith("app-")
    ? path.resolve(executableDirectory, "..")
    : executableDirectory;
}

function resolveInstalledExecutable(version: string): string {
  if (!STABLE_VERSION_RE.test(version)) {
    throw new Error("UPDATE_RESTART_REQUIRED");
  }
  const executableName = path.basename(process.execPath);
  const installRoot = path.resolve(getInstallRoot());
  const targetDirectory = path.resolve(installRoot, `app-${version}`);
  const target = path.resolve(targetDirectory, executableName);
  const relativeTarget = path.relative(installRoot, target);
  if (
    path.dirname(target) !== targetDirectory ||
    !relativeTarget ||
    relativeTarget.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeTarget)
  ) {
    throw new Error("UPDATE_RESTART_REQUIRED");
  }
  try {
    if (!statSync(target).isFile()) {
      throw new Error("not a file");
    }
  } catch {
    throw new Error("UPDATE_RESTART_REQUIRED");
  }
  return target;
}

function relaunchArgs(token: string): string[] {
  return [
    ...process.argv
      .slice(1)
      .filter(
        (argument) =>
          !(
            argument.startsWith("--squirrel-") ||
            argument.startsWith(RELAUNCH_TOKEN_PREFIX) ||
            argument === "--relaunch"
          )
      ),
    `${RELAUNCH_TOKEN_PREFIX}${token}`,
  ];
}

function launchInstalledVersion(version: string): void {
  const targetExecutable = resolveInstalledExecutable(version);
  const current = getCurrentUpdateStatus();
  if ((current?.restartAttempts ?? 0) >= 2) {
    throw new Error("UPDATE_RESTART_REQUIRED");
  }
  const token = current?.relaunchToken ?? randomUUID();
  setInstallStatus("restarting", {
    installerPath: undefined,
    installerPid: undefined,
    relaunchToken: token,
    restartAttempts: (current?.restartAttempts ?? 0) + 1,
    version,
  });
  recordUpdateDiagnostic({
    execPath: targetExecutable,
    expectedVersion: version,
    phase: "restarting",
  });
  markUpdateQuitAllowed();
  app.relaunch({
    args: relaunchArgs(token),
    execPath: targetExecutable,
  });
  app.quit();
}

async function applyLocalUpdate(feedDirectory: string): Promise<void> {
  try {
    if (
      !(
        customDownloaded &&
        (await verifyUpdatePackage(
          path.join(feedDirectory, customDownloaded.package.filename),
          customDownloaded.package
        ))
      )
    ) {
      throw new Error("UPDATE_PACKAGE_CORRUPT");
    }
    await runLocalSquirrelUpdate(feedDirectory);
    const targetVersion = customDownloaded?.manifest.version;
    if (!targetVersion) {
      throw new Error("UPDATE_RESTART_REQUIRED");
    }
    launchInstalledVersion(targetVersion);
  } catch (error) {
    let installError = error;
    if (
      customDownloaded?.method === "delta" &&
      !customDownloaded.fallbackReason &&
      shouldFallbackFromDelta(error)
    ) {
      const reason = error instanceof Error ? error.message : String(error);
      recordUpdateDiagnostic({
        fallbackReason: "delta-failed",
        failure: reason,
        stage: "delta-install-fallback",
      });
      try {
        setInstallStatus("recovering", {
          fallbackReason: "delta-failed",
          updateMethod: "full",
          resumeInstallation: true,
        });
        const fallbackPackage = customDownloaded.manifest.packages.full;
        const fallbackPlan: UpdatePlan = {
          currentVersion: app.getVersion(),
          fallback: fallbackPackage,
          manifest: customDownloaded.manifest,
          method: "full",
          package: fallbackPackage,
          targetVersion: customDownloaded.manifest.version,
        };
        pendingDownload = {
          plan: fallbackPlan,
          operation: "install",
          releaseNotes: customDownloaded.releaseNotes,
          fallbackReason: "delta-failed",
        };
        const downloaded = await downloadAndPrepare(
          fallbackPlan,
          customDownloaded.releaseNotes,
          "delta-failed",
          "delta-failed",
          "install"
        );
        pendingDownload = null;
        customDownloaded = downloaded;
        cachedFeedDirectory = downloaded.feedDirectory;
        setInstallStatus("installing", {
          fallbackReason: downloaded.fallbackReason,
          releaseNotes: downloaded.releaseNotes,
          total: downloaded.package.size,
          transferred: downloaded.package.size,
          updateMethod: downloaded.method,
          updateURL: downloaded.package.url,
          version: downloaded.manifest.version,
        });
        await runLocalSquirrelUpdate(downloaded.feedDirectory);
        launchInstalledVersion(downloaded.manifest.version);
        return;
      } catch (fallbackError) {
        installError = fallbackError;
      }
    }
    updateQuitAllowed = false;
    activePhase = !pendingDownload && customDownloaded ? "downloaded" : null;
    const message = recordUpdateError(installError, "install-github-update");
    broadcast({
      ...getCurrentUpdateStatus(),
      message,
      operation: pendingDownload ? "download" : "install",
      retryAfter:
        installError instanceof PackageRequestError
          ? installError.retryAfter
          : undefined,
      canResume: !!pendingDownload,
      canUseFull: pendingDownload?.plan.method === "delta",
      bytesPerSecond: 0,
      phase: "error",
      phaseStartedAt: nowISO(),
    });
  }
}

function shouldFallbackFromDelta(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error);
  return (
    !DELTA_FALLBACK_BLOCK_RE.test(text) &&
    DELTA_PATCH_FAILURE_RE.test(text) &&
    ![
      "NETWORK_ERROR",
      "UPDATE_TLS_ERROR",
      "UPDATE_ACCESS_DENIED",
      "UPDATE_RATE_LIMITED",
      "UPDATE_INSTALL_ACCESS_DENIED",
      "UPDATE_INSTALL_DISK_FULL",
      "UPDATE_BUSY",
    ].includes(classifyUpdateError(error))
  );
}

function terminateInstallerProcess(child: {
  kill(): boolean;
  pid?: number;
}): void {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn(
        "taskkill.exe",
        ["/PID", String(child.pid), "/T", "/F"],
        { stdio: "ignore", windowsHide: true }
      );
      killer.once("error", () => child.kill());
      return;
    } catch {
      // Fall through to the direct signal if taskkill cannot be started.
    }
  }
  child.kill();
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
    const startedAt = Date.now();
    const child = spawn(updateExecutable, ["--update", feedDirectory], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let timedOut = false;
    let settled = false;
    let stdout = "";
    let stderr = "";
    let exitCode: number | null = null;
    const appendOutput = (kind: "stderr" | "stdout", chunk: Buffer) => {
      const value = chunk.toString("utf8");
      if (kind === "stdout") {
        stdout = `${stdout}${value}`.slice(-MAX_INSTALL_OUTPUT_CHARS);
      } else {
        stderr = `${stderr}${value}`.slice(-MAX_INSTALL_OUTPUT_CHARS);
      }
    };
    child.stdout?.on("data", (chunk: Buffer) => appendOutput("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => appendOutput("stderr", chunk));
    if (child.pid) {
      const current = getCurrentUpdateStatus();
      broadcast({
        ...current,
        installerPath: updateExecutable,
        installerPid: child.pid,
        operation: "install",
        phase: activePhase === "recovering" ? "recovering" : "installing",
      });
    }
    let killGrace: ReturnType<typeof setTimeout> | undefined;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateInstallerProcess(child);
      killGrace = setTimeout(() => {
        if (child.pid && isProcessRunning(child.pid)) {
          // Keep the transaction locked until the process actually exits. A
          // successful taskkill command alone does not prove Update.exe is
          // gone, and starting a second installer would corrupt the feed.
          recordUpdateDiagnostic({
            installer: updateExecutable,
            installerPid: child.pid,
            result: "timeout-awaiting-exit",
          });
          finish(new Error("UPDATE_INSTALL_TIMEOUT"));
          return;
        }
        finish(new Error("UPDATE_INSTALL_TIMEOUT"));
      }, UPDATE_INSTALL_KILL_GRACE_MS);
    }, UPDATE_INSTALL_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (killGrace) {
        clearTimeout(killGrace);
      }
      recordUpdateDiagnostic({
        elapsedMs: Date.now() - startedAt,
        exitCode,
        installer: updateExecutable,
        stderr,
        stdout,
        targetVersion: getCurrentUpdateStatus()?.version,
        updateMethod: getCurrentUpdateStatus()?.updateMethod,
        timedOut,
      });
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
      exitCode = code;
      if (settled) {
        return;
      }
      broadcast({ ...getUpdateState(), installerPid: undefined });
      if (timedOut) {
        finish(new Error("UPDATE_INSTALL_TIMEOUT"));
      } else if (code === 0) {
        broadcast({
          ...getUpdateState(),
          installerPid: undefined,
          installCompletedAt: nowISO(),
        });
        finish();
      } else {
        const output = sanitizeDiagnosticText(
          `${stderr}\n${stdout}`.trim(),
          1024
        );
        finish(
          new Error(
            `Squirrel update exited with code ${code}${
              output ? `: ${output}` : ""
            }`
          )
        );
      }
    });
  });
}
