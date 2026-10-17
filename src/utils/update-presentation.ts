import type { UpdateStatus } from "@/types/update";

export type UpdateCommand = "check" | "resume" | "full" | "install" | "manual";

export function isUpdateBusy(status: UpdateStatus): boolean {
  return [
    "checking",
    "downloading",
    "retry-wait",
    "recovering",
    "installing",
    "restarting",
  ].includes(status.phase);
}

export function isUpdateReady(status: UpdateStatus): boolean {
  return status.phase === "downloaded" && !status.resumeInstallation;
}

export function updatePercent(status: UpdateStatus): number | undefined {
  if (status.phase !== "downloading" && status.phase !== "retry-wait") {
    return undefined;
  }
  if (typeof status.percent === "number" && Number.isFinite(status.percent)) {
    return Math.max(0, Math.min(100, Math.floor(status.percent)));
  }
  return undefined;
}

export function updateStageKey(status: UpdateStatus): string {
  if (status.phase === "checking") {
    return "updateChecking";
  }
  if (status.phase === "retry-wait") {
    return "updateWaitingRetryShort";
  }
  if (status.phase === "downloading") {
    if (status.networkWaiting) {
      return "updateNetworkWaiting";
    }
    return status.recoveryReason ? "updateRepairingCache" : "updateDownloading";
  }
  if (status.phase === "recovering") {
    return status.recoveryReason ? "updateRepairingCache" : "updateRecovering";
  }
  if (status.phase === "installing") {
    return "updateInstalling";
  }
  if (status.phase === "restarting") {
    return "updateRestarting";
  }
  if (status.phase === "downloaded") {
    return status.resumeInstallation
      ? "updatePreparingInstall"
      : "updateReadyShort";
  }
  return status.phase === "error" ? "updateNeedsAttention" : "updateUpToDate";
}

export function updateShortStageKey(status: UpdateStatus): string {
  if (
    status.phase === "downloading" &&
    !status.networkWaiting &&
    !status.recoveryReason
  ) {
    return "updateDownloadingShort";
  }
  if (status.phase === "downloading" || status.phase === "recovering") {
    return status.networkWaiting
      ? "updateWaitingNetworkShort"
      : "updateRepairingShort";
  }
  if (status.phase === "installing") {
    return "updateInstallingShort";
  }
  if (status.phase === "restarting") {
    return "updateRestartingShort";
  }
  return updateStageKey(status);
}

export function updateReasonKey(status: UpdateStatus): string | undefined {
  if (status.fallbackReason === "user-selected") {
    return "updateFullUserSelected";
  }
  if (status.fallbackReason) {
    return "updateDeltaFallback";
  }
  if (status.recoveryReason) {
    return "updateCacheRepairReason";
  }
  return undefined;
}

export function updatePrimaryAction(
  status: UpdateStatus
): { command: UpdateCommand; label: string } | null {
  if (
    isUpdateBusy(status) ||
    (status.phase === "downloaded" && status.resumeInstallation)
  ) {
    return null;
  }
  if (isUpdateReady(status)) {
    return { command: "install", label: "updateRestartNow" };
  }
  if (status.phase === "error") {
    const disk =
      status.message === "UPDATE_DISK_SPACE" ||
      status.message === "UPDATE_INSTALL_DISK_FULL";
    let command: UpdateCommand = "check";
    let label = "updateRetry";
    if (status.canResume) {
      command = "resume";
      label = "updateContinueDownload";
    } else if (status.operation === "install") {
      command = "install";
      label = "updateRetryUpdate";
    }
    return { command, label: disk ? "updateRetryAfterSpace" : label };
  }
  return { command: "check", label: "updateCheckBtn" };
}

export function canOfferFullUpdate(status: UpdateStatus): boolean {
  return (
    status.phase === "error" &&
    Boolean(status.canUseFull) &&
    (status.message === "UPDATE_PACKAGE_CORRUPT" ||
      status.message === "UPDATE_NOT_FOUND")
  );
}

export function updateRetrySeconds(status: UpdateStatus, now: number): number {
  const deadline = Date.parse(status.retryAfter ?? "");
  return Number.isFinite(deadline)
    ? Math.max(0, Math.ceil((deadline - now) / 1000))
    : 0;
}

export function formatUpdateBytes(
  bytes: number | undefined,
  locale?: string
): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(
    units.length - 1,
    Math.floor(Math.log(Math.max(1, bytes)) / Math.log(1024))
  );
  return `${new Intl.NumberFormat(locale, { maximumFractionDigits: index > 1 ? 1 : 0 }).format(bytes / 1024 ** index)} ${units[index]}`;
}
