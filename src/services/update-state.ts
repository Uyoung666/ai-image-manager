// Shared update-status store between main.ts (event handlers) and oRPC handlers.
// Both run in the main process but reside in separate modules, so a simple
// module-level variable bridges them without requiring ipcMain.invoke.
import Store from "electron-store";

export interface UpdateStatus {
  bytesPerSecond?: number;
  message?: string;
  percent?: number;
  phase: string;
  releaseDate?: string;
  releaseNotes?: string;
  total?: number;
  transferred?: number;
  updateURL?: string;
  version?: string;
}

interface PersistedUpdateState {
  state: UpdateStatus;
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

export function getUpdateState(currentVersion?: string): UpdateStatus {
  if (!state) {
    state = getStore().get("state", { phase: "idle" });
  }
  if (
    currentVersion &&
    state.phase === "downloaded" &&
    state.version === currentVersion
  ) {
    state = { phase: "idle" };
    getStore().set("state", state);
  }
  return { ...state };
}

export function setUpdateState(next: UpdateStatus): void {
  state = { ...next };
  getStore().set("state", state);
}
