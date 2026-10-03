export const UPDATE_ERROR_KEYS = {
  DEV_MODE: "updateDevMode",
  NETWORK_ERROR: "updateErrorNetwork",
  UPDATE_NOT_FOUND: "updateErrorNotFound",
  UPDATE_PACKAGE_CORRUPT: "updateErrorPackageCorrupt",
  UPDATE_RATE_LIMITED: "updateErrorRateLimited",
  UPDATE_ACCESS_DENIED: "updateErrorAccessDenied",
  UPDATE_SERVICE_UNAVAILABLE: "updateErrorServiceUnavailable",
  UPDATE_BUSY: "updateErrorBusy",
  UPDATE_INSTALL_TIMEOUT: "updateErrorInstallTimeout",
  UPDATE_INSTALL_INTERRUPTED: "updateErrorInstallInterrupted",
  UPDATE_INSTALL_ACCESS_DENIED: "updateErrorInstallAccessDenied",
  UPDATE_INSTALL_DISK_FULL: "updateErrorInstallDiskFull",
  UPDATE_RESTART_REQUIRED: "updateErrorRestartRequired",
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
  attempt?: number;
  bytesPerSecond?: number;
  canResume?: boolean;
  canUseFull?: boolean;
  etag?: string;
  fallbackReason?: string;
  installCompletedAt?: string;
  installerPath?: string;
  installerPid?: number;
  installStartedAt?: string;
  lastCheckedAt?: string;
  lastCheckResult?: "up-to-date" | "update-available";
  maxAttempts?: number;
  message?: UpdateErrorCode;
  networkWaiting?: boolean;
  operation?: "check" | "download" | "install";
  percent?: number;
  phase:
    | "idle"
    | "checking"
    | "up-to-date"
    | "downloading"
    | "retry-wait"
    | "downloaded"
    | "installing"
    | "recovering"
    | "restarting"
    | "error";
  phaseStartedAt?: string;
  relaunchToken?: string;
  releaseDate?: string;
  releaseNotes?: string;
  restartAttempts?: number;
  resumeInstallation?: boolean;
  retryAfter?: string;
  sourceVersion?: string;
  total?: number;
  transactionId?: string;
  transferred?: number;
  updateMethod?: "delta" | "full";
  updateURL?: string;
  version?: string;
}
