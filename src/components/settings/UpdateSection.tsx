// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/useDefaultSwitchClause: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
import { CheckCircle2, XCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  checkForUpdates,
  downloadFullUpdate,
  getUpdateStatus,
  installDownloadedUpdate,
  openReleasePage,
  resumeUpdate,
} from "@/actions/update";
import { SettingRow } from "@/components/settings/setting-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { UpdateProgress } from "@/components/update-progress";
import { ipc } from "@/ipc/manager";

import { UPDATE_ERROR_KEYS, type UpdateStatus } from "@/types/update";
import { classifyUpdateError } from "@/utils/update-error";

type UpdatePhase = UpdateStatus["phase"];

function mapUpdateErrorMessage(
  error: unknown,
  translate: (key: string) => string
): string {
  return translate(UPDATE_ERROR_KEYS[classifyUpdateError(error)]);
}

export function UpdateSection({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastCheckTime, setLastCheckTime] = useState<string>("");
  const [lastCheckResult, setLastCheckResult] =
    useState<UpdateStatus["lastCheckResult"]>();
  const [percent, setPercent] = useState<number | undefined>();
  const [bytesPerSecond, setBytesPerSecond] = useState<number | undefined>();
  const [releaseNotes, setReleaseNotes] = useState("");
  const [updateMethod, setUpdateMethod] = useState<
    "delta" | "full" | undefined
  >();
  const [fallbackReason, setFallbackReason] = useState("");
  const [errorOperation, setErrorOperation] =
    useState<UpdateStatus["operation"]>();
  const [snapshot, setSnapshot] = useState<UpdateStatus>({ phase: "idle" });
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateReminder, setUpdateReminder] = useState(true);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const downloadStartRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const statusRevisionRef = useRef(0);

  const applyStatusSnapshot = useCallback(
    (status: UpdateStatus) => {
      if (!status) {
        return;
      }
      setSnapshot(status);
      setPhase(status.phase);
      setPercent(status.percent);
      setBytesPerSecond(status.bytesPerSecond);
      setErrorOperation(status.operation);
      if (status.version) {
        setUpdateVersion(status.version);
      }
      if (status.releaseNotes) {
        setReleaseNotes(status.releaseNotes);
      }
      if (status.updateMethod) {
        setUpdateMethod(status.updateMethod);
      }
      if (status.fallbackReason) {
        setFallbackReason(status.fallbackReason);
      }
      if (status.percent != null) {
        setPercent(status.percent);
      }
      if (status.bytesPerSecond != null) {
        setBytesPerSecond(status.bytesPerSecond);
      }
      if (status.lastCheckedAt) {
        setLastCheckTime(new Date(status.lastCheckedAt).toLocaleTimeString());
      }
      setLastCheckResult(status.lastCheckResult);
      if (status.phase === "up-to-date") {
        setErrorOperation(undefined);
        setLastCheckResult("up-to-date");
        if (!status.lastCheckedAt) {
          setLastCheckTime(new Date().toLocaleTimeString());
        }
      }
      if (status.phase === "downloaded") {
        setErrorOperation(undefined);
        setLastCheckResult(status.lastCheckResult ?? "update-available");
      }
      if (status.phase === "checking") {
        setErrorOperation("check");
        setPercent(undefined);
        setBytesPerSecond(undefined);
        setUpdateMethod(undefined);
        setFallbackReason("");
      }
      if (status.phase === "downloading") {
        setErrorOperation(status.operation ?? "download");
      }
      if (
        status.phase === "installing" ||
        status.phase === "recovering" ||
        status.phase === "restarting"
      ) {
        setErrorOperation("install");
      }
      if (status.phase === "error") {
        setErrorMsg(mapUpdateErrorMessage(status.message, t));
      } else if (status.phase !== "checking") {
        setErrorMsg("");
      }

      const timestamp = status.installStartedAt ?? status.phaseStartedAt;
      if (timestamp) {
        const parsed = Date.parse(timestamp);
        if (Number.isFinite(parsed)) {
          downloadStartRef.current = parsed;
          setElapsedSeconds(
            Math.max(0, Math.floor((Date.now() - parsed) / 1000))
          );
        }
      } else if (
        status.phase === "downloading" ||
        status.phase === "installing" ||
        status.phase === "recovering" ||
        status.phase === "restarting"
      ) {
        downloadStartRef.current = Date.now();
        setElapsedSeconds(0);
      }
    },
    [t]
  );

  // Restore cached update status on mount (e.g. auto-download completed while on another page)
  useEffect(() => {
    const requestRevision = statusRevisionRef.current;
    getUpdateStatus()
      .then((rawStatus) => {
        if (requestRevision !== statusRevisionRef.current || !rawStatus) {
          return;
        }
        applyStatusSnapshot(rawStatus);
      })
      .catch((error: unknown) => {
        if (requestRevision !== statusRevisionRef.current) {
          return;
        }
        setPhase("error");
        setErrorMsg(mapUpdateErrorMessage(error, t));
      });
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        setAutoUpdate(preferences.updateAutoUpdate);
        setUpdateReminder(preferences.updateReminder);
      })
      .catch(() => undefined);
  }, [applyStatusSnapshot, t]);

  // Listen for update status events from main process
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.channel !== "update:status") {
        return;
      }

      if (!data.phase) {
        return;
      }
      statusRevisionRef.current += 1;
      applyStatusSnapshot(data as UpdateStatus);
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [applyStatusSnapshot]);

  // Track elapsed time while downloading
  useEffect(() => {
    if (
      phase === "downloading" ||
      phase === "installing" ||
      phase === "recovering" ||
      phase === "restarting"
    ) {
      downloadStartRef.current ||= Date.now();
      setElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - downloadStartRef.current) / 1000))
      );
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds(
          Math.floor((Date.now() - downloadStartRef.current) / 1000)
        );
      }, 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
      downloadStartRef.current = 0;
      setElapsedSeconds(0);
    }
    return () => {
      if (elapsedTimerRef.current) {
        clearInterval(elapsedTimerRef.current);
        elapsedTimerRef.current = null;
      }
    };
  }, [phase]);

  function formatSpeed(bps: number | undefined): string {
    if (bps == null || bps <= 0) {
      return "";
    }
    if (bps < 1024) {
      return `${bps} B/s`;
    }
    if (bps < 1_048_576) {
      return `${(bps / 1024).toFixed(0)} KB/s`;
    }
    return `${(bps / 1_048_576).toFixed(1)} MB/s`;
  }

  async function handleCheck() {
    const actionRevision = ++statusRevisionRef.current;
    setPhase("checking");
    setErrorMsg("");
    setErrorOperation("check");
    setUpdateMethod(undefined);
    setFallbackReason("");
    try {
      const result = await checkForUpdates();
      if (actionRevision !== statusRevisionRef.current) {
        return;
      }
      const data = result;
      if (!data?.ok) {
        setPhase("error");
        setErrorOperation("check");
        setErrorMsg(mapUpdateErrorMessage(data?.error, t));
      }
    } catch (err: unknown) {
      if (actionRevision !== statusRevisionRef.current) {
        return;
      }
      setPhase("error");
      setErrorOperation("check");
      setErrorMsg(mapUpdateErrorMessage(err, t));
    }
  }

  async function handleRestart() {
    const actionRevision = ++statusRevisionRef.current;
    setPhase("installing");
    setErrorOperation("install");
    setErrorMsg("");
    try {
      const result = await installDownloadedUpdate();
      if (actionRevision !== statusRevisionRef.current) {
        return;
      }
      if (!result?.ok) {
        setPhase("error");
        setErrorOperation("install");
        setErrorMsg(mapUpdateErrorMessage(result?.error, t));
      }
    } catch {
      if (actionRevision !== statusRevisionRef.current) {
        return;
      }
      setPhase("error");
      setErrorOperation("install");
      setErrorMsg(t("updateError"));
    }
  }

  async function handleResume(full = false) {
    const revision = ++statusRevisionRef.current;
    setPhase("downloading");
    setErrorMsg("");
    try {
      const result = await (full ? downloadFullUpdate() : resumeUpdate());
      if (revision === statusRevisionRef.current && !result.ok) {
        setPhase("error");
        setErrorMsg(mapUpdateErrorMessage(result.error, t));
      }
    } catch (error) {
      if (revision === statusRevisionRef.current) {
        setPhase("error");
        setErrorMsg(mapUpdateErrorMessage(error, t));
      }
    }
  }

  async function handleRetry() {
    if (snapshot.canResume) {
      await handleResume();
      return;
    }
    if (errorOperation === "install") {
      await handleRestart();
      return;
    }
    await handleCheck();
  }

  const isBusy =
    phase === "checking" ||
    phase === "retry-wait" ||
    phase === "downloading" ||
    phase === "installing" ||
    phase === "recovering" ||
    phase === "restarting";

  async function handleOpenManual() {
    await openReleasePage();
  }

  return (
    <section className="min-w-0 space-y-3">
      <div>
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsUpdate")}
        </h2>
        <p className="mt-1 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
          {t("settingsUpdateDescription")}
        </p>
      </div>
      <div className="min-w-0 overflow-hidden rounded-[8px] border border-border bg-secondary">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3 p-3 min-[480px]:p-4">
          <div className="min-w-0">
            <span className="text-[11px] text-muted-foreground">
              {t("settingsVersion")}
            </span>
            <p className="mt-1 font-semibold text-[16px] text-foreground">
              {appVersion || "..."}
            </p>
          </div>
          {phase === "downloaded" ? (
            <button
              className="inline-flex min-h-8 max-w-full shrink-0 items-center justify-center rounded-[6px] bg-primary px-4 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
              onClick={handleRestart}
              type="button"
            >
              {t("updateRestartNow")}
            </button>
          ) : isBusy ? (
            <button
              className="inline-flex min-h-8 max-w-full shrink-0 items-center justify-center gap-1.5 rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground opacity-70"
              disabled
              type="button"
            >
              <LoadingSpinner size="sm" variant="inherit" />
              {t(
                phase === "recovering"
                  ? "updateRecovering"
                  : phase === "downloading" && errorOperation === "install"
                    ? "updateRecovering"
                    : phase === "restarting"
                      ? "updateRestarting"
                      : phase === "installing"
                        ? "updateInstalling"
                        : phase === "retry-wait" || snapshot.networkWaiting
                          ? "updateNetworkWaiting"
                          : phase === "downloading"
                            ? "updateDownloading"
                            : "updateChecking"
              )}
            </button>
          ) : (
            <button
              className="inline-flex min-h-8 max-w-full shrink-0 items-center justify-center rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={isBusy}
              onClick={phase === "error" ? handleRetry : handleCheck}
              type="button"
            >
              {phase === "error" ? t("updateRetry") : t("updateCheckBtn")}
            </button>
          )}
        </div>

        <div className="border-border border-t p-3 min-[480px]:p-4">
          <SettingRow
            action={
              <Switch
                ariaLabel={t("settingsAutoUpdate")}
                checked={autoUpdate}
                onCheckedChange={(checked) => {
                  const previous = autoUpdate;
                  setAutoUpdate(checked);
                  ipc.client.settings
                    .setAppPreference({
                      key: "update.autoUpdate",
                      value: String(checked),
                    })
                    .catch(() => setAutoUpdate(previous));
                }}
              />
            }
            description={t("settingsAutoUpdateHint")}
            title={t("settingsAutoUpdate")}
          />
          <SettingRow
            action={
              <Switch
                ariaLabel={t("settingsUpdateReminder")}
                checked={updateReminder}
                onCheckedChange={(checked) => {
                  const previous = updateReminder;
                  setUpdateReminder(checked);
                  window.dispatchEvent(
                    new CustomEvent("update-reminder-changed", {
                      detail: checked,
                    })
                  );
                  ipc.client.settings
                    .setAppPreference({
                      key: "update.reminder",
                      value: String(checked),
                    })
                    .catch(() => setUpdateReminder(previous));
                }}
              />
            }
            description={t("settingsUpdateReminderHint")}
            title={t("settingsUpdateReminder")}
          />
        </div>

        {/* Status area */}
        {phase !== "idle" && (
          <div className="border-border border-t bg-background/20 p-3 min-[480px]:p-4">
            {phase === "retry-wait" && <UpdateProgress status={snapshot} />}
            {/* Checking */}
            {phase === "checking" && (
              <div className="flex items-center gap-2 rounded-[6px] bg-background/40 px-3 py-2.5">
                <LoadingSpinner size="sm" variant="secondary" />
                <span className="text-[12px] text-muted-foreground">
                  {t("updateChecking")}
                </span>
              </div>
            )}

            {/* Up to date */}
            {phase === "up-to-date" && (
              <div className="rounded-[6px] border border-green-500/20 bg-green-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-[12px] text-muted-foreground">
                    {t("updateUpToDate")}
                  </span>
                </div>
                {lastCheckTime && (
                  <p className="mt-1 text-[11px] text-muted-foreground/60">
                    {t("updateLastCheck", { time: lastCheckTime })}
                  </p>
                )}
              </div>
            )}

            {/* Downloading — indeterminate shimmer bar */}
            {phase === "downloading" && (
              <div className="rounded-[6px] bg-background/40 px-3 py-2.5">
                <p className="text-[12px] text-muted-foreground">
                  {updateVersion
                    ? t("updateFound", { version: updateVersion })
                    : t("updateDownloading")}
                </p>
                {snapshot.networkWaiting && (
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {t("updateNetworkWaiting")}
                  </p>
                )}
                {fallbackReason && (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {t("updateDeltaFallback")}
                  </p>
                )}
                <div
                  className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                  data-reduced-motion-keep="progress-bar"
                >
                  <div
                    className={`absolute inset-y-0 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent ${percent == null ? "w-2/5 animate-indeterminate-bar" : ""}`}
                    data-reduced-motion-keep="progress-bar"
                    style={
                      percent == null ? undefined : { width: `${percent}%` }
                    }
                  />
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground/60">
                  {elapsedSeconds > 0
                    ? `${t("updateElapsed", { seconds: elapsedSeconds })}${bytesPerSecond ? ` · ${formatSpeed(bytesPerSecond)}` : ""}`
                    : t("updateDownloading")}
                </p>
              </div>
            )}

            {["recovering", "installing", "restarting"].includes(phase) && (
              <UpdateProgress status={{ ...snapshot, phase }} />
            )}

            {/* Downloaded */}
            {phase === "downloaded" && (
              <div className="rounded-[6px] border border-green-500/20 bg-green-500/5 px-3 py-2.5">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                  <span className="text-[12px] text-muted-foreground">
                    {t("updateDownloadedStatus", { version: updateVersion })}
                  </span>
                </div>
                {updateMethod && (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {t(
                      updateMethod === "delta"
                        ? "updateDeltaDownloaded"
                        : "updateFullDownloaded"
                    )}
                    {fallbackReason ? ` · ${t("updateDeltaFallback")}` : ""}
                  </p>
                )}
                {releaseNotes && (
                  <div className="mt-2 max-h-32 overflow-y-auto rounded-[6px] border border-border bg-background p-2">
                    <p className="whitespace-pre-wrap text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                      {releaseNotes}
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Error */}
            {phase === "error" && (
              <div className="rounded-[6px] border border-destructive/25 bg-destructive/5 px-3 py-2.5">
                <div className="flex min-w-0 items-start gap-2">
                  <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                  <span className="min-w-0 text-[12px] text-destructive [overflow-wrap:anywhere]">
                    {errorMsg || t("updateError")}
                  </span>
                </div>
                {errorOperation === "check" && (
                  <p className="mt-1 text-[11px] text-muted-foreground/70">
                    {t("updateCheckUnavailable")}
                    {lastCheckResult === "up-to-date" && lastCheckTime
                      ? ` ${t("updateLastKnownUpToDate", { time: lastCheckTime })}`
                      : ""}
                  </p>
                )}
              </div>
            )}

            {phase === "error" && snapshot.canUseFull && (
              <button
                className="mt-2 inline-flex min-h-8 max-w-full items-center justify-center rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground [overflow-wrap:anywhere]"
                onClick={() => handleResume(true)}
                type="button"
              >
                {t("updateUseFull")}
              </button>
            )}
            {/* Manual download link (always show when downloaded or error) */}
            {(phase === "downloaded" || phase === "error") && (
              <button
                className="mt-2 inline-flex min-h-8 max-w-full items-center justify-center rounded-[6px] border border-input px-4 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                onClick={handleOpenManual}
                type="button"
              >
                {t("updateDownloadManually")}
              </button>
            )}
          </div>
        )}
      </div>

      <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
        {t("updateProxySystemHint")}
      </p>
    </section>
  );
}
