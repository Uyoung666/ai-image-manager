import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  checkForUpdates,
  getUpdateProxy,
  getUpdateStatus,
  installDownloadedUpdate,
  openReleasePage,
  setUpdateProxy,
  testUpdateProxy,
} from "@/actions/update";
import { SettingRow } from "@/components/settings/setting-row";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import { ipc } from "@/ipc/manager";

type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

interface UpdateStatusPayload {
  bytesPerSecond?: number;
  message?: string;
  percent?: number;
  phase: UpdatePhase;
  releaseDate?: string;
  releaseNotes?: string;
  total?: number;
  transferred?: number;
  updateURL?: string;
  version?: string;
}

interface UpdateProxyPayload {
  proxy?: string;
}

function mapUpdateErrorMessage(
  message: string | undefined,
  translate: (key: string) => string
): string {
  if (!message) {
    return translate("updateError");
  }
  if (message === "DEV_MODE") {
    return translate("updateDevMode");
  }
  if (message === "NETWORK_ERROR") {
    return translate("updateErrorNetwork");
  }
  if (message === "UPDATE_NOT_FOUND") {
    return translate("updateErrorNotFound");
  }
  return message;
}

export function UpdateSection({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastCheckTime, setLastCheckTime] = useState<string>("");
  const [percent, setPercent] = useState<number | undefined>();
  const [bytesPerSecond, setBytesPerSecond] = useState<number | undefined>();
  const [releaseNotes, setReleaseNotes] = useState("");
  const [autoUpdate, setAutoUpdate] = useState(true);
  const [updateReminder, setUpdateReminder] = useState(true);
  const [proxy, setProxy] = useState("");
  const [proxySaved, setProxySaved] = useState(false);
  const [proxyTesting, setProxyTesting] = useState(false);
  const [proxyResult, setProxyResult] = useState<
    | {
        ok: boolean;
        latency?: number;
        error?: string;
        bytes?: number;
        bytesPerSecond?: number;
      }
    | undefined
  >();
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const downloadStartRef = useRef<number>(0);
  const elapsedTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Restore cached update status on mount (e.g. auto-download completed while on another page)
  useEffect(() => {
    getUpdateStatus().then((rawStatus) => {
      const status = rawStatus as UpdateStatusPayload | null;
      if (!status || status.phase === "idle") {
        return;
      }
      setPhase(status.phase);
      if (status.version) {
        setUpdateVersion(status.version);
      }
      if (status.releaseNotes) {
        setReleaseNotes(status.releaseNotes);
      }
      if (status.percent != null) {
        setPercent(status.percent);
      }
      if (status.bytesPerSecond != null) {
        setBytesPerSecond(status.bytesPerSecond);
      }
      if (status.message && status.message !== "DEV_MODE") {
        setErrorMsg(mapUpdateErrorMessage(status.message, t));
      }
    });
    // Restore saved proxy
    getUpdateProxy().then((r) => {
      const proxyResult = r as UpdateProxyPayload;
      if (proxyResult.proxy) {
        setProxy(proxyResult.proxy);
      }
    });
    ipc.client.settings
      .getAppPreferences({})
      .then((preferences) => {
        setAutoUpdate(preferences.updateAutoUpdate);
        setUpdateReminder(preferences.updateReminder);
      })
      .catch(() => undefined);
  }, [t]);

  // Listen for update status events from main process
  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.channel !== "update:status") {
        return;
      }

      switch (data.phase) {
        case "checking":
          setPhase("checking");
          setPercent(undefined);
          setBytesPerSecond(undefined);
          break;
        case "downloading":
          setPhase("downloading");
          if (data.version) {
            setUpdateVersion(data.version);
          }
          if (data.percent != null) {
            setPercent(data.percent);
          }
          if (data.bytesPerSecond != null) {
            setBytesPerSecond(data.bytesPerSecond);
          }
          break;
        case "up-to-date":
          setPhase("up-to-date");
          setLastCheckTime(new Date().toLocaleTimeString());
          break;
        case "downloaded":
          setPhase("downloaded");
          if (data.version) {
            setUpdateVersion(data.version);
          }
          if (data.releaseNotes) {
            setReleaseNotes(data.releaseNotes);
          }
          break;
        case "error":
          setPhase("error");
          setErrorMsg(mapUpdateErrorMessage(data.message, t));
          break;
      }
    }
    // Also listen for update:available to sync state
    function onUpdateAvailable(event: MessageEvent) {
      if (event.data?.channel === "update:available") {
        setPhase("downloaded");
        setUpdateVersion(event.data.version || "");
        if (event.data.releaseNotes) {
          setReleaseNotes(event.data.releaseNotes);
        }
      }
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("message", onUpdateAvailable);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", onUpdateAvailable);
    };
  }, [t]);

  // Track elapsed time while downloading
  useEffect(() => {
    if (phase === "downloading") {
      downloadStartRef.current = Date.now();
      setElapsedSeconds(0);
      elapsedTimerRef.current = setInterval(() => {
        setElapsedSeconds(
          Math.floor((Date.now() - downloadStartRef.current) / 1000)
        );
      }, 1000);
    } else if (elapsedTimerRef.current) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
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
    setPhase("checking");
    setErrorMsg("");
    try {
      const result = await checkForUpdates();
      const data = result as { ok?: boolean; error?: string } | undefined;
      if (!data?.ok) {
        setPhase("error");
        setErrorMsg(mapUpdateErrorMessage(data?.error, t));
      }
    } catch (err: unknown) {
      setPhase("error");
      setErrorMsg(
        err && typeof err === "object" && "message" in err
          ? String((err as { message?: unknown }).message)
          : t("updateError")
      );
    }
  }

  async function handleRestart() {
    await installDownloadedUpdate();
  }

  async function handleSaveProxy() {
    try {
      await setUpdateProxy(proxy);
      setProxySaved(true);
      setProxyResult(undefined);
      toast.success(t("updateSaved"));
      setTimeout(() => setProxySaved(false), 2000);
    } catch {
      toast.error(t("saveFailed"));
    }
  }

  async function handleTestProxy() {
    setProxyTesting(true);
    setProxyResult(undefined);
    try {
      const r = (await testUpdateProxy()) as {
        ok: boolean;
        status?: number;
        latency?: number;
        error?: string;
        bytes?: number;
        bytesPerSecond?: number;
      };
      setProxyResult({
        ok: r.ok,
        latency: r.latency,
        error: r.error,
        bytes: r.bytes,
        bytesPerSecond: r.bytesPerSecond,
      });
      if (r.ok) {
        toast.success(t("updateProxyTestOk", { latency: r.latency ?? "?" }));
      } else {
        toast.error(t("updateProxyTestFail"));
      }
    } catch {
      setProxyResult({ ok: false, error: "IPC error" });
      toast.error(t("updateProxyTestFail"));
    } finally {
      setProxyTesting(false);
    }
  }

  async function handleOpenManual() {
    await openReleasePage();
  }

  return (
    <section className="min-w-0 space-y-3">
      <h2 className="font-semibold text-[14px] text-foreground">
        {t("settingsUpdate")}
      </h2>
      <div className="min-w-0 space-y-3 rounded-[8px] border border-border bg-secondary p-3 min-[480px]:p-4">
        {/* Current version */}
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <span className="text-[13px] text-muted-foreground">
            {t("settingsVersion")}
          </span>
          <span className="text-[13px] text-foreground">
            {appVersion || "..."}
          </span>
        </div>

        <div className="border-border border-t pt-3">
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
        <div className="border-border border-t pt-3">
          {/* Checking */}
          {phase === "checking" && (
            <div className="flex items-center gap-2">
              <LoadingSpinner size="sm" variant="secondary" />
              <span className="text-[13px] text-muted-foreground">
                {t("updateChecking")}
              </span>
            </div>
          )}

          {/* Up to date */}
          {phase === "up-to-date" && (
            <div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                <span className="text-[13px] text-muted-foreground">
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
            <div>
              <p className="text-[13px] text-muted-foreground">
                {updateVersion
                  ? t("updateFound", { version: updateVersion })
                  : t("updateDownloading")}
              </p>
              <div
                className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted"
                data-reduced-motion-keep="progress-bar"
              >
                <div
                  className={`absolute inset-y-0 rounded-full bg-gradient-to-r from-transparent via-primary to-transparent ${percent == null ? "w-2/5 animate-indeterminate-bar" : ""}`}
                  data-reduced-motion-keep="progress-bar"
                  style={percent == null ? undefined : { width: `${percent}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                {elapsedSeconds > 0
                  ? `${t("updateElapsed", { seconds: elapsedSeconds })}${bytesPerSecond ? ` · ${formatSpeed(bytesPerSecond)}` : ""}`
                  : t("updateDownloading")}
              </p>
            </div>
          )}

          {/* Downloaded */}
          {phase === "downloaded" && (
            <div>
              <div className="flex items-center gap-2">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-600" />
                <span className="text-[13px] text-muted-foreground">
                  {t("updateDownloadedStatus", { version: updateVersion })}
                </span>
              </div>
              {releaseNotes && (
                <div className="mt-2 max-h-32 overflow-y-auto rounded-[6px] border border-border bg-background p-2">
                  <p className="whitespace-pre-wrap text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
                    {releaseNotes}
                  </p>
                </div>
              )}
              <button
                className="mt-2 w-full rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={handleRestart}
                type="button"
              >
                {t("updateRestartNow")}
              </button>
            </div>
          )}

          {/* Idle (no check done yet) */}
          {phase === "idle" && (
            <p className="text-[13px] text-muted-foreground/70">
              {appVersion
                ? t("updateStatusIdle", { version: appVersion })
                : "..."}
            </p>
          )}

          {/* Error */}
          {phase === "error" && (
            <div>
              <div className="flex min-w-0 items-start gap-2">
                <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-destructive" />
                <span className="min-w-0 text-[13px] text-destructive [overflow-wrap:anywhere]">
                  {errorMsg || t("updateError")}
                </span>
              </div>
            </div>
          )}

          {/* Manual download link (always show when downloaded or error) */}
          {(phase === "downloaded" || phase === "error") && (
            <button
              className="mt-2 w-full rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
              onClick={handleOpenManual}
              type="button"
            >
              {t("updateDownloadManually")}
            </button>
          )}
        </div>

        {/* Action button */}
        <div className="border-border border-t pt-3">
          {phase === "downloaded" ? null : (
            <button
              className="w-full rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={phase === "checking" || phase === "downloading"}
              onClick={handleCheck}
              type="button"
            >
              {phase === "checking" || phase === "downloading" ? (
                <span className="flex items-center justify-center gap-1.5">
                  <LoadingSpinner size="sm" variant="inherit" />
                  {t("updateChecking")}
                </span>
              ) : phase === "error" ? (
                t("updateRetry")
              ) : (
                t("updateCheckBtn")
              )}
            </button>
          )}
        </div>

        {/* Proxy setting */}
        <div className="border-border border-t pt-3">
          <label
            className="text-[11px] text-muted-foreground"
            htmlFor="update-proxy"
          >
            {t("updateProxyLabel")}
          </label>
          <div className="mt-1 flex min-w-0 flex-wrap gap-2">
            <input
              className="min-w-0 flex-1 rounded-[6px] border border-input bg-background px-2 py-1 text-[12px] placeholder:text-muted-foreground/40"
              id="update-proxy"
              onChange={(e) => setProxy(e.target.value)}
              placeholder="127.0.0.1:7890"
              value={proxy}
            />
            <button
              className="shrink-0 rounded-[6px] border border-input px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
              onClick={handleSaveProxy}
              type="button"
            >
              {proxySaved ? t("updateSaved") : t("updateSave")}
            </button>
            <button
              className="shrink-0 rounded-[6px] border border-input px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={proxyTesting}
              onClick={handleTestProxy}
              type="button"
            >
              {proxyTesting ? t("updateProxyTesting") : t("updateProxyTest")}
            </button>
          </div>
          {proxyResult && (
            <p
              className={`mt-1 text-[11px] [overflow-wrap:anywhere] ${proxyResult.ok ? "text-green-600" : "text-destructive"}`}
            >
              {proxyResult.ok
                ? `${t("updateProxyTestOk", { latency: proxyResult.latency ?? "?" })} · ${formatSpeed(proxyResult.bytesPerSecond)}`
                : `${t("updateProxyTestFail")}${proxyResult.error ? `: ${proxyResult.error}` : ""}`}
            </p>
          )}
          <p className="mt-1 text-[10px] text-muted-foreground/50 [overflow-wrap:anywhere]">
            {t("updateProxyHint")}
          </p>
        </div>
      </div>
    </section>
  );
}
