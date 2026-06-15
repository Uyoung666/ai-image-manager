// Shared update-status store between main.ts (event handlers) and oRPC handlers.
// Both run in the main process but reside in separate modules, so a simple
// module-level variable bridges them without requiring ipcMain.invoke.

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

let state: UpdateStatus = { phase: "idle" };

export function getUpdateState(): UpdateStatus {
  return { ...state };
}

export function setUpdateState(next: UpdateStatus): void {
  state = { ...next };
}
