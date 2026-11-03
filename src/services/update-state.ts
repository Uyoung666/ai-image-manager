// Shared update-status store between main.ts (event handlers) and oRPC handlers.
// Both run in the main process but reside in separate modules, so a simple
// module-level variable bridges them without requiring ipcMain.invoke.

import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import Store from "electron-store";
import { recordUpdateError } from "@/services/update-error";
import type { UpdateStatus } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

const STABLE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export type { UpdateStatus } from "@/types/update";

interface PersistedUpdateState {
  releaseCache?: ReleaseListCache;
  state: UpdateStatus;
}

export interface ReleaseListEntry {
  body?: string | null;
  draft?: boolean;
  prerelease?: boolean;
  tag_name: string;
}

export interface ReleaseListCache {
  etag?: string;
  releases: ReleaseListEntry[];
}

export function getReleaseListCache(): ReleaseListCache | null {
  const value = getStore().get("releaseCache");
  if (
    !value ||
    (value.etag !== undefined && typeof value.etag !== "string") ||
    !Array.isArray(value.releases) ||
    !value.releases.every(isReleaseListEntry)
  ) {
    return null;
  }
  return structuredClone(value);
}

export function isReleaseListEntry(value: unknown): value is ReleaseListEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as ReleaseListEntry;
  return (
    typeof entry.tag_name === "string" &&
    (entry.body == null || typeof entry.body === "string") &&
    (entry.draft === undefined || typeof entry.draft === "boolean") &&
    (entry.prerelease === undefined || typeof entry.prerelease === "boolean")
  );
}

export function setReleaseListCache(value: ReleaseListCache): void {
  getStore().set("releaseCache", {
    etag: value.etag,
    releases: value.releases.map((entry) => ({
      tag_name: entry.tag_name,
      draft: entry.draft,
      prerelease: entry.prerelease,
      body: entry.body,
    })),
  });
}

let store: Store<PersistedUpdateState> | null = null;
let quarantinedCorruptState = false;

function getStore() {
  if (!store) {
    const options = {
      defaults: { state: { phase: "idle" as const } },
      name: "update-state",
    };
    try {
      store = new Store<PersistedUpdateState>(options);
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
      const file = path.join(app.getPath("userData"), "update-state.json");
      // Keep the exact corrupt bytes before allowing electron-store to reset JSON.
      fs.copyFileSync(
        file,
        `${file}.corrupt-${randomUUID()}`,
        fs.constants.COPYFILE_EXCL
      );
      store = new Store<PersistedUpdateState>({
        ...options,
        clearInvalidConfig: true,
      });
      quarantinedCorruptState = true;
      recordUpdateError(error, "quarantine-update-state");
    }
  }
  return store;
}

let state: UpdateStatus | null = null;
let persistedState: UpdateStatus | null = null;
let progressTimer: ReturnType<typeof setTimeout> | null = null;
let lastPersistedAt = 0;
export const UPDATE_PROGRESS_PERSIST_MS = 2000;

const PROGRESS_FIELDS = new Set([
  "percent",
  "transferred",
  "total",
  "bytesPerSecond",
  "networkWaiting",
]);

function persistState(): void {
  if (progressTimer) {
    clearTimeout(progressTimer);
    progressTimer = null;
  }
  if (!state) {
    return;
  }
  getStore().set("state", state);
  persistedState = structuredClone(state);
  lastPersistedAt = Date.now();
}

export function getUpdateState(): UpdateStatus {
  if (!state) {
    try {
      const saved = getStore().get("state", { phase: "idle" });
      if (quarantinedCorruptState) {
        quarantinedCorruptState = false;
        throw new Error("Corrupt update state was preserved and reset");
      }
      if (!isValidUpdateState(saved)) {
        throw new Error("Invalid persisted update state");
      }
      state = structuredClone(saved);
      persistedState = structuredClone(state);
    } catch (error) {
      recordUpdateError(error, "read-update-state");
      state = {
        phase: "error",
        operation: "check",
        message: "UPDATE_STATE_SAVE_FAILED",
      };
    }
  }
  if (state.phase === "error") {
    const code = classifyUpdateError(state.message);
    if (state.message !== code) {
      recordUpdateError(state.message, "restore-status");
      state = { ...state, message: code };
    }
  }
  return structuredClone(state);
}

export function setUpdateState(next: UpdateStatus, persist = true): void {
  if (!isValidUpdateState(next)) {
    throw new Error("UPDATE_STATE_SAVE_FAILED");
  }
  const previous = state;
  state = structuredClone(next);
  if (!persist) {
    if (progressTimer) {
      clearTimeout(progressTimer);
      progressTimer = null;
    }
    return;
  }
  const onlyProgress =
    persistedState &&
    next.phase === "downloading" &&
    [...new Set([...Object.keys(persistedState), ...Object.keys(next)])].every(
      (key) =>
        PROGRESS_FIELDS.has(key) ||
        JSON.stringify(persistedState?.[key as keyof UpdateStatus]) ===
          JSON.stringify(next[key as keyof UpdateStatus])
    );
  if (
    !onlyProgress ||
    Date.now() - lastPersistedAt >= UPDATE_PROGRESS_PERSIST_MS
  ) {
    try {
      persistState();
    } catch (error) {
      state = previous;
      recordUpdateError(error, "persist-update-state");
      throw new Error("UPDATE_STATE_SAVE_FAILED", { cause: error });
    }
  } else if (!progressTimer) {
    progressTimer = setTimeout(
      () => {
        try {
          persistState();
        } catch (error) {
          recordUpdateError(error, "persist-update-progress");
        }
      },
      UPDATE_PROGRESS_PERSIST_MS - (Date.now() - lastPersistedAt)
    );
    progressTimer.unref?.();
  }
}

const STATE_PHASES = new Set([
  "idle",
  "checking",
  "up-to-date",
  "downloading",
  "retry-wait",
  "downloaded",
  "installing",
  "recovering",
  "restarting",
  "confirming",
  "error",
]);
const STRING_FIELDS = new Set([
  "installerCreatedAt",
  "installerPath",
  "confirmationStartedAt",
  "confirmedAt",
  "etag",
  "fallbackReason",
  "installCompletedAt",
  "installStartedAt",
  "lastCheckedAt",
  "message",
  "phaseStartedAt",
  "relaunchToken",
  "releaseDate",
  "releaseNotes",
  "retryAfter",
  "sourceVersion",
  "transactionId",
  "updateURL",
  "version",
]);
const NUMBER_FIELDS = new Set([
  "attempt",
  "bytesPerSecond",
  "installerPid",
  "maxAttempts",
  "percent",
  "restartAttempts",
  "total",
  "transferred",
]);
const BOOLEAN_FIELDS = new Set([
  "canResume",
  "canUseFull",
  "fullFallbackAttempted",
  "networkWaiting",
  "resumeInstallation",
]);
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: validate untrusted legacy state before accepting recovery instructions
export function isValidUpdateState(value: unknown): value is UpdateStatus {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (!STATE_PHASES.has(String(record.phase))) {
    return false;
  }
  for (const [key, field] of Object.entries(record)) {
    if (field === undefined) {
      continue;
    }
    if (STRING_FIELDS.has(key) && typeof field !== "string") {
      return false;
    }
    if (
      NUMBER_FIELDS.has(key) &&
      (typeof field !== "number" || !Number.isFinite(field) || field < 0)
    ) {
      return false;
    }
    if (BOOLEAN_FIELDS.has(key) && typeof field !== "boolean") {
      return false;
    }
  }
  if (
    record.version !== undefined &&
    !STABLE_VERSION.test(String(record.version))
  ) {
    return false;
  }
  if (
    record.installerPid !== undefined &&
    (!Number.isSafeInteger(record.installerPid) ||
      Number(record.installerPid) <= 0)
  ) {
    return false;
  }
  if (
    record.operation !== undefined &&
    !["check", "download", "install", "startup"].includes(
      String(record.operation)
    )
  ) {
    return false;
  }
  if (
    record.updateMethod !== undefined &&
    !["delta", "full"].includes(String(record.updateMethod))
  ) {
    return false;
  }
  if (
    record.lastCheckResult !== undefined &&
    !["up-to-date", "update-available"].includes(String(record.lastCheckResult))
  ) {
    return false;
  }
  if (
    record.recoveryReason !== undefined &&
    !["cache-missing", "cache-corrupt"].includes(String(record.recoveryReason))
  ) {
    return false;
  }
  if (
    record.cacheRepairs !== undefined &&
    (!record.cacheRepairs ||
      typeof record.cacheRepairs !== "object" ||
      Object.entries(record.cacheRepairs).some(
        ([key, entry]) =>
          !["delta", "full"].includes(key) || typeof entry !== "boolean"
      ))
  ) {
    return false;
  }
  return true;
}
