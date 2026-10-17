import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import { getAppVersion } from "@/actions/app";
import {
  checkForUpdates,
  downloadFullUpdate,
  getUpdateStatus,
  installDownloadedUpdate,
  openReleasePage,
  resumeUpdate,
} from "@/actions/update";
import { ipc } from "@/ipc/manager";
import type {
  UpdateErrorCode,
  UpdateResult,
  UpdateStatus,
} from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";
import { isUpdateReady, type UpdateCommand } from "@/utils/update-presentation";

const READY_NOTICE_KEY = "update.ready-notified-versions";
export interface UpdateNotice {
  error?: UpdateErrorCode;
  id: number;
  kind: "ready" | "error";
  version?: string;
}
export interface UpdateUiSnapshot {
  appVersion: string;
  autoUpdate: boolean;
  commandError?: UpdateErrorCode;
  detailsOpen: boolean;
  failedCommand?: UpdateCommand;
  notice: UpdateNotice | null;
  pending: UpdateCommand | null;
  preferenceError: boolean;
  preferencesPending: boolean;
  preferencesReady: boolean;
  reminder: boolean;
  status: UpdateStatus;
  statusError?: UpdateErrorCode;
  userInitiated: boolean;
}

const defaultDependencies = {
  getStatus: getUpdateStatus,
  getVersion: getAppVersion,
  getPreferences: () => ipc.client.settings.getAppPreferences({}),
  savePreference: (
    key: "update.autoUpdate" | "update.reminder",
    value: string
  ) => ipc.client.settings.setAppPreference({ key, value }),
  check: checkForUpdates,
  resume: resumeUpdate,
  full: downloadFullUpdate,
  install: installDownloadedUpdate,
  manual: openReleasePage,
  storage: () => window.localStorage,
};
type UpdateUiDependencies = typeof defaultDependencies;

export function createUpdateUiStore(
  overrides: Partial<UpdateUiDependencies> = {}
) {
  const dependencies = { ...defaultDependencies, ...overrides };
  let snapshot: UpdateUiSnapshot = {
    status: { phase: "idle" },
    appVersion: "",
    pending: null,
    detailsOpen: false,
    autoUpdate: true,
    reminder: true,
    preferencesReady: false,
    preferencesPending: false,
    preferenceError: false,
    userInitiated: false,
    notice: null,
  };
  const listeners = new Set<() => void>();
  const readyNotified = new Set<string>();
  let readyLoaded = false;
  let revision = 0;
  let generation = 0;
  let mounts = 0;
  let noticeId = 0;
  let snapshotRequest = 0;
  let pendingError: { error: UpdateErrorCode; foreground: boolean } | null =
    null;

  function publish(patch: Partial<UpdateUiSnapshot>) {
    snapshot = { ...snapshot, ...patch };
    for (const listener of listeners) {
      listener();
    }
  }

  function loadReadyClaims() {
    if (!readyLoaded) {
      readyLoaded = true;
      try {
        const stored: unknown = JSON.parse(
          dependencies.storage().getItem(READY_NOTICE_KEY) ?? "[]"
        );
        if (Array.isArray(stored)) {
          for (const entry of stored.slice(-32)) {
            if (typeof entry === "string") {
              readyNotified.add(entry);
            }
          }
        }
      } catch {
        // In-memory deduplication still applies when storage is unavailable.
      }
    }
  }

  function claimReady(version: string): boolean {
    loadReadyClaims();
    if (readyNotified.has(version)) {
      return false;
    }
    readyNotified.add(version);
    try {
      dependencies
        .storage()
        .setItem(
          READY_NOTICE_KEY,
          JSON.stringify([...readyNotified].slice(-32))
        );
    } catch {
      // Keep the claim in memory, including on quota and security errors.
    }
    return true;
  }

  function maybeNotice() {
    if (!snapshot.preferencesReady || snapshot.preferencesPending) {
      return;
    }
    if (pendingError) {
      const candidate = pendingError;
      pendingError = null;
      if (candidate.foreground || snapshot.reminder) {
        publish({
          notice: { id: ++noticeId, kind: "error", error: candidate.error },
        });
      }
      return;
    }
    const { status } = snapshot;
    if (
      snapshot.reminder &&
      !snapshot.pending &&
      isUpdateReady(status) &&
      status.version &&
      claimReady(status.version)
    ) {
      publish({
        notice: { id: ++noticeId, kind: "ready", version: status.version },
      });
    }
  }

  function acceptStatus(status: UpdateStatus, event = false) {
    const previous = snapshot.status;
    const foreground =
      snapshot.userInitiated ||
      status.operation === "install" ||
      Boolean(status.resumeInstallation);
    const newError =
      status.phase === "error" &&
      (previous.phase !== "error" ||
        previous.message !== status.message ||
        previous.transactionId !== status.transactionId);
    if (newError && (event || foreground)) {
      pendingError = { error: classifyUpdateError(status.message), foreground };
    } else if (status.phase !== "error") {
      pendingError = null;
    }
    publish({
      status: { ...status },
      statusError: undefined,
      commandError: undefined,
      failedCommand: undefined,
      userInitiated: ["idle", "up-to-date", "downloaded", "error"].includes(
        status.phase
      )
        ? false
        : snapshot.userInitiated,
      ...(status.phase === previous.phase ? {} : { notice: null }),
    });
    maybeNotice();
  }

  async function refreshStatus() {
    const request = ++snapshotRequest;
    const requestedRevision = revision;
    const requestedGeneration = generation;
    try {
      const status = await dependencies.getStatus();
      if (
        request === snapshotRequest &&
        revision === requestedRevision &&
        generation === requestedGeneration
      ) {
        acceptStatus(status);
      }
    } catch (error) {
      if (
        request === snapshotRequest &&
        revision === requestedRevision &&
        generation === requestedGeneration
      ) {
        publish({ statusError: classifyUpdateError(error) });
      }
    }
  }

  function receive(event: MessageEvent) {
    if (event.data?.channel === "update:status" && event.data.phase) {
      revision++;
      const { channel: _channel, ...status } = event.data;
      acceptStatus(status, true);
    }
  }

  function reminderChanged(event: Event) {
    publish({ reminder: (event as CustomEvent<boolean>).detail === true });
    maybeNotice();
  }

  function start() {
    mounts++;
    if (mounts === 1) {
      const currentGeneration = ++generation;
      window.addEventListener("message", receive);
      window.addEventListener("update-reminder-changed", reminderChanged);
      refreshStatus();
      dependencies
        .getVersion()
        .then((appVersion) => {
          if (currentGeneration === generation) {
            publish({ appVersion });
          }
        })
        .catch(() => undefined);
      dependencies
        .getPreferences()
        .then((preferences) => {
          if (
            currentGeneration === generation &&
            !snapshot.preferencesPending
          ) {
            publish({
              autoUpdate: preferences.updateAutoUpdate,
              reminder: preferences.updateReminder,
              preferencesReady: true,
            });
            maybeNotice();
          }
        })
        .catch(() => {
          if (currentGeneration === generation) {
            publish({
              preferencesReady: true,
              reminder: false,
              preferenceError: true,
            });
            maybeNotice();
          }
        });
    }
    return () => {
      mounts--;
      if (mounts === 0) {
        generation++;
        window.removeEventListener("message", receive);
        window.removeEventListener("update-reminder-changed", reminderChanged);
      }
    };
  }

  async function run(command: UpdateCommand): Promise<UpdateResult> {
    if (snapshot.pending) {
      return { ok: true, skipped: true };
    }
    const requestedRevision = revision;
    publish({
      pending: command,
      commandError: undefined,
      failedCommand: undefined,
      userInitiated: command === "manual" ? snapshot.userInitiated : true,
      notice: null,
    });
    try {
      const response = await dependencies[command]();
      const result =
        command === "manual" ? { ok: true } : (response as UpdateResult);
      if (!result.ok) {
        throw new Error(result.error);
      }
      if (command !== "manual") {
        await refreshStatus();
      }
      return result;
    } catch (error) {
      const code = classifyUpdateError(error);
      if (requestedRevision === revision) {
        publish({
          commandError: code,
          failedCommand: command,
          userInitiated: false,
          notice: { id: ++noticeId, kind: "error", error: code },
        });
      }
      return { ok: false, error: code };
    } finally {
      publish({ pending: null });
      maybeNotice();
    }
  }

  async function setPreference(
    preference: "autoUpdate" | "reminder",
    value: boolean
  ) {
    if (snapshot.preferencesPending) {
      return;
    }
    const previous = snapshot[preference];
    publish({
      [preference]: value,
      preferencesPending: true,
      preferenceError: false,
    });
    try {
      await dependencies.savePreference(
        preference === "autoUpdate" ? "update.autoUpdate" : "update.reminder",
        String(value)
      );
      if (preference === "reminder") {
        window.dispatchEvent(
          new CustomEvent("update-reminder-changed", { detail: value })
        );
      }
    } catch {
      publish({ [preference]: previous, preferenceError: true });
    } finally {
      publish({ preferencesPending: false });
      maybeNotice();
    }
  }

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    run,
    refreshStatus,
    setPreference,
    setDetailsOpen: (detailsOpen: boolean) => publish({ detailsOpen }),
  };
}

export type UpdateUiStore = ReturnType<typeof createUpdateUiStore>;
const defaultStore = createUpdateUiStore();
const UpdateUiContext = createContext(defaultStore);

export function UpdateUiProvider({
  children,
  store = defaultStore,
}: {
  children: ReactNode;
  store?: UpdateUiStore;
}) {
  useEffect(() => store.start(), [store]);
  return (
    <UpdateUiContext.Provider value={store}>
      {children}
    </UpdateUiContext.Provider>
  );
}

function sameSelection<T>(left: T, right: T): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (
    !(left && right) ||
    typeof left !== "object" ||
    typeof right !== "object"
  ) {
    return false;
  }
  const keys = Object.keys(left);
  return (
    keys.length === Object.keys(right).length &&
    keys.every((key) => Object.is(left[key as keyof T], right[key as keyof T]))
  );
}

export function useUpdateUi<T>(selector: (snapshot: UpdateUiSnapshot) => T): T {
  const store = useContext(UpdateUiContext);
  const selectorRef = useRef(selector);
  selectorRef.current = selector;
  const selected = useRef<{ value: T } | null>(null);
  const getSnapshot = useCallback(() => {
    const next = selectorRef.current(store.getSnapshot());
    if (!(selected.current && sameSelection(selected.current.value, next))) {
      selected.current = { value: next };
    }
    return selected.current.value;
  }, [store]);
  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

export function useUpdateUiActions() {
  return useContext(UpdateUiContext);
}
