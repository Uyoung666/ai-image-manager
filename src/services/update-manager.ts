import { existsSync } from "node:fs";
import path from "node:path";
import { app, autoUpdater, BrowserWindow, Notification } from "electron";
import { getSetting } from "@/services/settings-manager";
import { getUpdateState, setUpdateState } from "@/services/update-state";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
} from "@/types/app-preferences";

/**
 * Windows/Squirrel needs a little time after startup before it is safe to
 * start network activity. In particular, Squirrel's --squirrel-firstrun
 * process must not race the first-run install/bootstrap work.
 */
export const UPDATE_INITIAL_DELAY_MS = 10 * 1000;
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const NETWORK_ERROR_RE =
  /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|net::ERR/i;
const HTTP_ERROR_RE = /403|404/i;
const LOCK_ERROR_RE = /acquire.*lock|another.*instance|mutex/i;
const TRAILING_SLASH_RE = /\/$/;

// The identifier is replaced by vite.main.config.mts during a release build.
// `typeof` keeps source/test execution safe when no build define is present.
declare const __AIM_UPDATE_BASE_URL__: unknown;

type UpdatePayload = Parameters<typeof setUpdateState>[0];
type UpdatePhase = UpdatePayload["phase"];

interface UpdateResult {
  error?: string;
  ok: boolean;
  skipped?: boolean;
}

interface UpdateManagerTestOverrides {
  feedURL?: string | null;
  squirrelInstallation?: boolean;
}

let configured = false;
let listenersAttached = false;
let updateTimer: ReturnType<typeof setInterval> | null = null;
let initialCheckTimer: ReturnType<typeof setTimeout> | null = null;

// This is deliberately process-local for checking/downloading. A persisted
// downloaded package is also a valid lock because Squirrel can install it
// after a restart, but stale checking/downloading state must not strand the
// updater forever after a crash.
let activePhase: UpdatePhase | null = null;
let testOverrides: UpdateManagerTestOverrides | null = null;

function isSupportedEnvironment(): boolean {
  return process.platform === "win32" && app.isPackaged;
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
    activePhase = current?.phase === "downloaded" ? "downloaded" : null;
  } catch {
    activePhase = null;
  }
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
    const error = args[0];
    const raw =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
    if (activePhase === "downloaded") {
      return;
    }
    activePhase = null;
    if (LOCK_ERROR_RE.test(raw)) {
      return;
    }
    let message = raw;
    if (NETWORK_ERROR_RE.test(raw)) {
      message = "NETWORK_ERROR";
    } else if (HTTP_ERROR_RE.test(raw)) {
      message = "UPDATE_NOT_FOUND";
    }
    broadcast({ phase: "error", message: message.slice(0, 200) });
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
    return false;
  }

  try {
    autoUpdater.setFeedURL({ url: feedURL });
    hydrateDownloadedLock();
    attachListeners();
    configured = true;
    return true;
  } catch {
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
    broadcast({ phase: "error", message: "UPDATE_NOT_FOUND" });
    return { ok: false, error: "UPDATE_NOT_FOUND" };
  }
  if (isLockedPhase(activePhase)) {
    return { ok: true, skipped: true };
  }

  activePhase = "checking";
  // Mark the lock before calling into Electron. Some updater versions emit
  // checking-for-update asynchronously, and a second IPC call can otherwise
  // slip through during that gap.
  broadcast({ phase: "checking" });
  try {
    autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    activePhase = null;
    const message = error instanceof Error ? error.message : String(error);
    broadcast({ phase: "error", message: message.slice(0, 200) });
    return { ok: false, error: message };
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
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, error: message };
  }
}
