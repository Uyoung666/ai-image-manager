export const UPDATE_ERROR_KEYS = {
  DEV_MODE: "updateDevMode",
  NETWORK_ERROR: "updateErrorNetwork",
  UPDATE_NOT_FOUND: "updateErrorNotFound",
  UPDATE_PACKAGE_CORRUPT: "updateErrorPackageCorrupt",
  UPDATE_RATE_LIMITED: "updateErrorRateLimited",
  UPDATE_BUSY: "updateErrorBusy",
  UPDATE_INSTALL_TIMEOUT: "updateErrorInstallTimeout",
  UPDATE_INSTALLER_UNSUPPORTED: "updateErrorInstallerUnsupported",
  UPDATE_NOT_READY: "updateErrorNotReady",
  UPDATE_TLS_ERROR: "updateErrorTls",
  UPDATE_UNKNOWN_ERROR: "updateError",
} as const;

export type UpdateErrorCode = keyof typeof UPDATE_ERROR_KEYS;

export interface UpdateResult {
  error?: UpdateErrorCode;
  ok: boolean;
  skipped?: boolean;
}

export interface UpdateStatus {
  bytesPerSecond?: number;
  fallbackReason?: string;
  message?: UpdateErrorCode;
  percent?: number;
  phase:
    | "idle"
    | "checking"
    | "up-to-date"
    | "downloading"
    | "downloaded"
    | "error";
  releaseDate?: string;
  releaseNotes?: string;
  total?: number;
  transferred?: number;
  updateMethod?: "delta" | "full";
  updateURL?: string;
  version?: string;
}
