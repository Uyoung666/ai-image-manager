// Shared update-status store between main.ts (event handlers) and oRPC handlers.
// Both run in the main process but reside in separate modules, so a simple
// module-level variable bridges them without requiring ipcMain.invoke.
import Store from "electron-store";
import { recordUpdateError } from "@/services/update-error";
import type { UpdateStatus } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

export type { UpdateStatus } from "@/types/update";

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

export function getUpdateState(): UpdateStatus {
  if (!state) {
    state = getStore().get("state", { phase: "idle" });
  }
  if (state.phase === "error") {
    const code = classifyUpdateError(state.message);
    if (state.message !== code) {
      recordUpdateError(state.message, "restore-status");
      state = { ...state, message: code };
    }
  }
  return { ...state };
}

export function setUpdateState(next: UpdateStatus): void {
  state = { ...next };
  getStore().set("state", state);
}
