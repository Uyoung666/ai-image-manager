import { app, autoUpdater, BrowserWindow, Notification } from "electron";
import { getSetting } from "@/services/settings-manager";
import { getUpdateState, setUpdateState } from "@/services/update-state";
import {
  APP_PREFERENCE_DEFAULTS,
  APP_PREFERENCE_KEYS,
  parseBooleanPreference,
} from "@/types/app-preferences";

const UPDATE_INTERVAL_MS = 10 * 60 * 1000;
const NETWORK_ERROR_RE =
  /ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|net::ERR/i;
const HTTP_ERROR_RE = /403|404/i;
const LOCK_ERROR_RE = /acquire.*lock|another.*instance|mutex/i;

let configured = false;
let listenersAttached = false;
let updateTimer: ReturnType<typeof setInterval> | null = null;

type UpdatePayload = Parameters<typeof setUpdateState>[0];

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

function attachListeners() {
  if (listenersAttached) {
    return;
  }
  listenersAttached = true;

  const updater = autoUpdater as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
  };
  updater.on("checking-for-update", () => broadcast({ phase: "checking" }));
  // Electron's update-available event does not carry update metadata. The
  // downloaded event below is the first point where release details exist.
  updater.on("update-available", () => broadcast({ phase: "downloading" }));
  updater.on("update-not-available", () => broadcast({ phase: "up-to-date" }));
  updater.on("error", (...args) => {
    const error = args[0];
    const raw =
      error && typeof error === "object" && "message" in error
        ? String((error as { message?: unknown }).message)
        : String(error);
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
    const [, releaseNotes, releaseName, releaseDate, updateURL] = args as [
      unknown,
      string | null | undefined,
      string | null | undefined,
      string | null | undefined,
      string | null | undefined,
    ];
    notifyDownloaded({
      phase: "downloaded",
      releaseDate: releaseDate ?? undefined,
      releaseNotes: releaseNotes ?? undefined,
      updateURL: updateURL ?? undefined,
      version: releaseName ?? undefined,
    });
  });

  try {
    (
      autoUpdater as unknown as {
        on: (event: string, listener: (progress: unknown) => void) => void;
      }
    ).on("download-progress", (progress) => {
      if (!progress || typeof progress !== "object") {
        return;
      }
      const value = progress as {
        bytesPerSecond?: number;
        percent?: number;
        total?: number;
        transferred?: number;
      };
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

function configure() {
  if (configured || !app.isPackaged) {
    return app.isPackaged;
  }
  autoUpdater.setFeedURL({
    url: `https://update.electronjs.org/Uyoung666/ai-image-manager/${process.platform}-${process.arch}/${app.getVersion()}`,
  });
  attachListeners();
  configured = true;
  return true;
}

function check() {
  if (!configure()) {
    broadcast({ phase: "error", message: "DEV_MODE" });
    return { ok: false, error: "DEV_MODE" };
  }
  try {
    autoUpdater.checkForUpdates();
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
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
  if (!updateTimer) {
    check();
    updateTimer = setInterval(check, UPDATE_INTERVAL_MS);
  }
}

export function stopAutomaticChecks() {
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
    notifyDownloaded(current);
  }
}

function getCurrentUpdateStatus(): UpdatePayload | null {
  return getUpdateState(app.getVersion());
}

export function installUpdate() {
  autoUpdater.quitAndInstall();
}
