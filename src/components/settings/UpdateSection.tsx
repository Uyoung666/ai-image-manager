import { CheckCircle2, XCircle } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ipc } from "@/ipc/manager";

type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

export function UpdateSection({ appVersion }: { appVersion: string }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastCheckTime, setLastCheckTime] = useState<string>("");
  const [percent, setPercent] = useState<number | undefined>();
  const [bytesPerSecond, setBytesPerSecond] = useState<number | undefined>();
  const [releaseNotes, setReleaseNotes] = useState("");
  const [manualUrl, setManualUrl] = useState("");
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
    ipc.client.app.getUpdateStatus({}).then((status: any) => {
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
      if (status.updateURL) {
        setManualUrl(status.updateURL);
      }
      if (status.percent != null) {
        setPercent(status.percent);
      }
      if (status.bytesPerSecond != null) {
        setBytesPerSecond(status.bytesPerSecond);
      }
      if (status.message && status.message !== "DEV_MODE") {
        setErrorMsg(mapErrorMessage(status.message));
      }
    });
    // Restore saved proxy
    ipc.client.app.getUpdateProxy({}).then((r: any) => {
      if (r?.proxy) {
        setProxy(r.proxy);
      }
    });
  }, []);

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
          if (data.updateURL) {
            setManualUrl(data.updateURL);
          }
          break;
        case "error":
          setPhase("error");
          setErrorMsg(mapErrorMessage(data.message));
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

  function mapErrorMessage(msg: string | undefined): string {
    if (!msg) {
      return t("updateError");
    }
    if (msg === "DEV_MODE") {
      return t("updateDevMode");
    }
    if (msg === "NETWORK_ERROR") {
      return t("updateErrorNetwork");
    }
    if (msg === "UPDATE_NOT_FOUND") {
      return t("updateErrorNotFound");
    }
    return msg;
  }

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
      const result = await ipc.client.app.checkForUpdates({});
      const data = result as { ok?: boolean; error?: string } | undefined;
      if (!data?.ok) {
        setPhase("error");
        setErrorMsg(mapErrorMessage(data?.error));
      }
    } catch (err: any) {
      setPhase("error");
      setErrorMsg(err?.message || t("updateError"));
    }
  }

  function handleRestart() {
    window.electronAPI?.installUpdate?.();
  }

  async function handleSaveProxy() {
    try {
      await ipc.client.app.setUpdateProxy({ proxy });
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
      const r = (await ipc.client.app.testProxy({})) as {
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
    await ipc.client.app.openReleasePage({});
  }

  return (
    <section className="space-y-3">
      <h2 className="font-semibold text-[14px] text-foreground">
        {t("settingsUpdate")}
      </h2>
      <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
        {/* Current version */}
        <div className="flex items-center justify-between">
          <span className="text-[13px] text-muted-foreground">
            {t("settingsVersion")}
          </span>
          <span className="text-[13px] text-foreground">
            {appVersion || "..."}
          </span>
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
              <div className="relative mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="absolute inset-y-0 w-2/5 animate-indeterminate-bar rounded-full bg-gradient-to-r from-transparent via-primary to-transparent" />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                {elapsedSeconds > 0
                  ? t("updateElapsed", { seconds: elapsedSeconds })
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
                  <p className="whitespace-pre-wrap text-[11px] text-muted-foreground">
                    {releaseNotes}
                  </p>
                </div>
              )}
              <button
                className="mt-2 w-full rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
                onClick={handleRestart}
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
              <div className="flex items-center gap-2">
                <XCircle className="h-3.5 w-3.5 text-destructive" />
                <span className="text-[13px] text-destructive">
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
          <label className="text-[11px] text-muted-foreground">
            {t("updateProxyLabel")}
          </label>
          <div className="mt-1 flex flex-wrap gap-2">
            <input
              className="min-w-0 flex-1 rounded-[6px] border border-input bg-background px-2 py-1 text-[12px] placeholder:text-muted-foreground/40"
              onChange={(e) => setProxy(e.target.value)}
              placeholder="127.0.0.1:7890"
              value={proxy}
            />
            <button
              className="shrink-0 rounded-[6px] border border-input px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
              onClick={handleSaveProxy}
            >
              {proxySaved ? t("updateSaved") : t("updateSave")}
            </button>
            <button
              className="shrink-0 rounded-[6px] border border-input px-2.5 py-1 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              disabled={proxyTesting}
              onClick={handleTestProxy}
            >
              {proxyTesting ? t("updateProxyTesting") : t("updateProxyTest")}
            </button>
          </div>
          {proxyResult && (
            <p
              className={`mt-1 text-[11px] ${proxyResult.ok ? "text-green-600" : "text-destructive"}`}
            >
              {proxyResult.ok
                ? `${t("updateProxyTestOk", { latency: proxyResult.latency ?? "?" })} · ${formatSpeed(proxyResult.bytesPerSecond)}`
                : `${t("updateProxyTestFail")}${proxyResult.error ? `: ${proxyResult.error}` : ""}`}
            </p>
          )}
          <p className="mt-1 text-[10px] text-muted-foreground/50">
            {t("updateProxyHint")}
          </p>
        </div>
      </div>
    </section>
  );
}
