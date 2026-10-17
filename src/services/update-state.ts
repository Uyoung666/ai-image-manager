// Shared update-status store between main.ts (event handlers) and oRPC handlers.
// Both run in the main process but reside in separate modules, so a simple
// module-level variable bridges them without requiring ipcMain.invoke.
import Store from "electron-store";
import { recordUpdateError } from "@/services/update-error";
import type { UpdateStatus } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

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

function getStore() {
  if (!store) {
    store = new Store<PersistedUpdateState>({
      defaults: { state: { phase: "idle" } },
      name: "update-state",
    });
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
    state = getStore().get("state", { phase: "idle" });
    persistedState = structuredClone(state);
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

export function setUpdateState(next: UpdateStatus): void {
  state = structuredClone(next);
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
    persistState();
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
