import { SiGithub } from "@icons-pack/react-simple-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { openExternalLink } from "@/actions/shell";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import { CloudConfigPanel } from "@/components/CloudConfigPanel";
import { GpuSettingsCard } from "@/components/gpu-settings-card";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  WatermarkPreview,
  type WatermarkPreviewSettings,
} from "@/components/WatermarkPreview";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { ipc } from "@/ipc/manager";

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  const precision = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${units[i]}`;
}

interface WatermarkSettings extends WatermarkPreviewSettings {
  position?: string; // legacy, auto-migrated
  wmX?: number; // legacy
  wmY?: number; // legacy
}

const DEFAULT_WM: WatermarkSettings = {
  enabled: false,
  text: "",
  imagePath: "",
  anchor: "bottomRight",
  margin: 5,
  opacity: 50,
  fontSize: 24,
  imageScale: 15,
};

// Module-level cache — survives page navigation so re-entry shows preview immediately
let cachedSamplePhoto = "";

function DataDirSection() {
  const { t } = useTranslation();
  const [dataPath, setDataPathState] = useState("");
  const [isDefault, setIsDefault] = useState(true);
  const [msg, setMsg] = useState("");
  const [restarting, setRestarting] = useState(false);
  const [migrating, setMigrating] = useState(false);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);

  useEffect(() => {
    ipc.client.settings.getDataPathInfo({}).then((r) => {
      setDataPathState((r as any).path);
      setIsDefault((r as any).isDefault);
    });
  }, []);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      const data = event.data;
      if (!data || data.channel !== "data-path-migrate-progress") {
        return;
      }
      switch (data.phase) {
        case "start":
          setProgress({
            current: 0,
            total: data.total,
            label: t("preparingMigration"),
          });
          break;
        case "stopping-services":
          setProgress((p) => ({
            current: p?.current ?? 0,
            total: p?.total ?? 0,
            label: t("stoppingServices"),
          }));
          break;
        case "copying":
          setProgress({
            current: data.index - 1,
            total: data.total,
            label: t("copyingDataDir", {
              dir: data.dir,
              index: data.index,
              total: data.total,
            }),
          });
          break;
        case "copied":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("copiedDataDir", {
              dir: data.dir,
              index: data.index,
              total: data.total,
            }),
          });
          break;
        case "skipped":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("skippedDataDir", { dir: data.dir, reason: data.reason }),
          });
          break;
        case "failed":
          setProgress({
            current: data.index,
            total: data.total,
            label: t("dataDirCopyFailed", { dir: data.dir, error: data.error }),
          });
          break;
        case "done":
          setProgress(null);
          break;
        default:
          break;
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  async function handleChangeDir() {
    const result = await ipc.client.shell.openFolderDialog({});
    const newPath = (result as any).path;
    if (!newPath) {
      return;
    }

    setMsg(t("migratingData"));
    setMigrating(true);
    setRestarting(false);
    const setResult = await ipc.client.settings.setDataPath({ newPath });
    const data = setResult as any;
    setMigrating(false);
    if (data.ok) {
      const parts = [t("dataMigratedTo", { path: newPath })];
      if (data.copied > 0) {
        parts.push(t("dataMigratedDirs", { count: data.copied }));
      }
      if (data.cleaned > 0) {
        parts.push(t("cleanedOldDirs", { count: data.cleaned }));
      }
      if (data.errors?.length > 0) {
        parts.push(
          t("dataMigrationPartialFailed", { errors: data.errors.join("; ") })
        );
      }
      if (data.cleanupErrors?.length > 0) {
        parts.push(
          t("cleanupOldDataPartialFailed", {
            errors: data.cleanupErrors.join("; "),
          })
        );
      }
      setMsg(`${parts.join("")}${t("refreshingAfterMigration")}`);
      setDataPathState(newPath);
      setIsDefault(false);
      setRestarting(true);
      // Services have already been restarted in-place by the main process.
      // A renderer reload re-establishes the oRPC port and refetches data
      // from the new location. No app relaunch needed (which is unreliable
      // under `npm run dev` because forge tears down the dev server).
      setTimeout(() => {
        window.location.reload();
      }, 1500);
    } else {
      setMsg(data.error || t("dataPathSetFailed"));
    }
  }

  const percent =
    progress && progress.total > 0
      ? Math.min(100, Math.round((progress.current / progress.total) * 100))
      : 0;

  return (
    <section className="space-y-3">
      <h2 className="font-[590] text-[14px] text-foreground">
        {t("dataDirectory")}
      </h2>
      <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
        <div>
          <span className="text-[13px] text-muted-foreground">
            {t("currentPath")}
          </span>
          <p className="mt-0.5 break-all font-mono text-[11px] text-muted-foreground/70">
            {dataPath || "..."}
          </p>
          <p className="mt-0.5 text-[11px] text-muted-foreground/50">
            {isDefault ? t("defaultPath") : t("customPath")}
          </p>
        </div>
        <div className="border-border border-t pt-3">
          <button
            className="rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={restarting || migrating}
            onClick={handleChangeDir}
          >
            {restarting
              ? t("refreshing")
              : migrating
                ? t("migrating")
                : t("chooseDirectory")}
          </button>
          {progress && (
            <div className="mt-3 space-y-1.5">
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full bg-primary transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>
              <p className="text-[11px] text-muted-foreground/70">
                {progress.label}
              </p>
            </div>
          )}
          {msg && (
            <p className="mt-2 text-[12px] text-muted-foreground">{msg}</p>
          )}
        </div>
      </div>
    </section>
  );
}

type UpdatePhase =
  | "idle"
  | "checking"
  | "up-to-date"
  | "downloading"
  | "downloaded"
  | "error";

function UpdateSection({ appVersion }: { appVersion: string }) {
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
    window.electronAPI?.restartApp?.();
  }

  async function handleSaveProxy() {
    await ipc.client.app.setUpdateProxy({ proxy });
    setProxySaved(true);
    setProxyResult(undefined);
    setTimeout(() => setProxySaved(false), 2000);
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
    } catch {
      setProxyResult({ ok: false, error: "IPC error" });
    } finally {
      setProxyTesting(false);
    }
  }

  async function handleOpenManual() {
    await ipc.client.app.openReleasePage({});
  }

  return (
    <section className="space-y-3">
      <h2 className="font-[590] text-[14px] text-foreground">
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
              <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
              <span className="text-[13px] text-muted-foreground">
                {t("updateChecking")}
              </span>
            </div>
          )}

          {/* Up to date */}
          {phase === "up-to-date" && (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-green-600">✓</span>
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

          {/* Downloading — real progress bar */}
          {phase === "downloading" && (
            <div>
              <p className="text-[13px] text-muted-foreground">
                {updateVersion
                  ? t("updateFound", { version: updateVersion })
                  : t("updateDownloading")}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width] duration-300 ease-out"
                  style={{ width: `${Math.max(percent ?? 0, 2)}%` }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                {percent != null && `${percent}%`}
                {formatSpeed(bytesPerSecond) &&
                  ` · ${formatSpeed(bytesPerSecond)}`}
                {percent == null &&
                  !formatSpeed(bytesPerSecond) &&
                  t("updateDownloading")}
              </p>
            </div>
          )}

          {/* Downloaded */}
          {phase === "downloaded" && (
            <div>
              <div className="flex items-center gap-2">
                <span className="text-[13px] text-green-600">✓</span>
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
                <span className="text-[13px] text-destructive">✗</span>
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
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
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

function SkeletonBlock({
  className,
  lines = 3,
}: {
  className?: string;
  lines?: number;
}) {
  return (
    <div
      aria-hidden="true"
      className={`animate-pulse space-y-2 ${className ?? ""}`}
    >
      {Array.from({ length: lines }).map((_, i) => (
        <div
          className="h-3 rounded bg-muted-foreground/10"
          key={i}
          style={{ width: `${[90, 70, 50][i] ?? 40}%` }}
        />
      ))}
    </div>
  );
}

function SettingsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [clearCacheStatus, setClearCacheStatus] = useState("");
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
  const [cleanupCount, setCleanupCount] = useState(0);
  const [orphanCleanStatus, setOrphanCleanStatus] = useState("");
  const [orphanDialogOpen, setOrphanDialogOpen] = useState(false);
  const [wm, setWm] = useState<WatermarkSettings>(DEFAULT_WM);
  const [wmLoaded, setWmLoaded] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [appVersion, setAppVersion] = useState("");
  const [samplePhoto, setSamplePhoto] = useState(cachedSamplePhoto);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wmOriginalRef = useRef<WatermarkSettings | null>(null);
  const wmSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wmLatestRef = useRef<WatermarkSettings>(DEFAULT_WM);
  const scrollMainRef = useRef<HTMLDivElement>(null);
  const scrollLogsRef = useRef<HTMLDivElement>(null);
  const scrollAiRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollMainRef, {
    getRouteKey: () => "settings-main",
  });
  useRouteScrollRestoration(scrollLogsRef, {
    getRouteKey: () => "settings-logs",
  });
  useRouteScrollRestoration(scrollAiRef, { getRouteKey: () => "settings-ai" });

  const handleCopyPath = useCallback((path: string) => {
    if (!path) {
      return;
    }
    navigator.clipboard.writeText(path).catch(() => {});
    if (copyTimerRef.current) {
      clearTimeout(copyTimerRef.current);
    }
    setCopiedPath(path);
    copyTimerRef.current = setTimeout(() => setCopiedPath(null), 2000);
  }, []);

  const { data: indexStats } = useQuery({
    queryKey: ["indexStats"],
    queryFn: () => ipc.client.photos.getIndexStats({}),
    staleTime: 60_000, // 60s cache — invalidated explicitly after clear/cleanup operations
    refetchOnWindowFocus: false,
  });

  const { data: orphanData, refetch: refetchOrphans } = useQuery({
    queryKey: ["orphanThumbnails"],
    queryFn: () =>
      ipc.client.photos.scanOrphanThumbnails({}) as Promise<{
        orphanCount: number;
        orphanSizeBytes: number;
        totalFiles: number;
      }>,
    staleTime: 300_000, // 5min cache — orphans only change after index mutations
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    getCurrentTheme().then(setThemeMode);
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

  // Load watermark settings + preload sample photo
  useEffect(() => {
    ipc.client.photos
      .getWatermarkSettings({})
      .then((result: any) => {
        if (result) {
          const w = { ...DEFAULT_WM, ...result };
          // Migrate old wmX/wmY → anchor
          if (!w.anchor && typeof w.wmX === "number") {
            w.anchor = "bottomRight";
            w.margin = 5;
          }
          if (!w.anchor && w.position) {
            w.anchor =
              w.position === "topLeft" ||
              w.position === "topRight" ||
              w.position === "bottomLeft" ||
              w.position === "bottomRight" ||
              w.position === "center" ||
              w.position === "topCenter" ||
              w.position === "centerLeft" ||
              w.position === "centerRight" ||
              w.position === "bottomCenter"
                ? (w.position as WatermarkSettings["anchor"])
                : "bottomRight";
            w.margin = 5;
          }
          setWm(w);
          wmLatestRef.current = w;
          // Snapshot original values so we can skip the initial no-op save
          wmOriginalRef.current = { ...w };
        } else {
          // No saved settings yet — snapshot defaults to skip initial save
          wmOriginalRef.current = { ...DEFAULT_WM };
        }
        setWmLoaded(true);
      })
      .catch(() => {
        if (!wmOriginalRef.current) {
          wmOriginalRef.current = { ...DEFAULT_WM };
        }
        setWmLoaded(true);
      });

    // Preload sample photo (cached at module level, fetched once per session)
    if (cachedSamplePhoto) {
      setSamplePhoto(cachedSamplePhoto);
    } else {
      ipc.client.photos
        .listPhotos({ sort: "date", order: "desc", limit: 30 })
        .then((r: any) => {
          const photos = r?.pages?.[0]?.items || r?.items || [];
          const horizontal = photos.find(
            (p: any) => p.width && p.height && p.width >= p.height
          );
          if (horizontal?.path) {
            cachedSamplePhoto = horizontal.path;
            setSamplePhoto(horizontal.path);
          }
        })
        .catch(() => {});
    }
  }, []);

  // Keep ref in sync for the unmount flush
  wmLatestRef.current = wm;

  // Persist watermark settings (debounced 300ms, skips unchanged values)
  useEffect(() => {
    if (!wmLoaded) {
      return;
    }
    // Skip if unchanged from originally loaded values
    const original = wmOriginalRef.current;
    if (original && JSON.stringify(wm) === JSON.stringify(original)) {
      return;
    }
    // Debounce slider drags into a single write
    if (wmSaveTimerRef.current) {
      clearTimeout(wmSaveTimerRef.current);
    }
    wmSaveTimerRef.current = setTimeout(() => {
      ipc.client.photos.setWatermarkSettings(wmLatestRef.current).catch(() => {
        /* ignore */
      });
    }, 300);
    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
      }
    };
  }, [wm, wmLoaded]);

  // Flush pending debounced save on unmount so quick navigation doesn't lose changes
  useEffect(() => {
    return () => {
      if (wmSaveTimerRef.current) {
        clearTimeout(wmSaveTimerRef.current);
        ipc.client.photos
          .setWatermarkSettings(wmLatestRef.current)
          .catch(() => {});
      }
    };
  }, []);

  async function handleClearCache() {
    setClearDialogOpen(false);
    setClearCacheStatus(t("settingsClearing"));
    try {
      const result = await ipc.client.photos.clearThumbCache({});
      const data = result as { fileCount?: number; freedMB?: number } | null;
      if (data?.fileCount === undefined) {
        setClearCacheStatus(t("settingsCleared"));
      } else {
        setClearCacheStatus(
          t("cacheCleanedDetail", {
            count: data.fileCount,
            size: data.freedMB ?? 0,
          })
        );
      }
    } catch {
      setClearCacheStatus(t("clearCacheFailed"));
    }
    setTimeout(() => setClearCacheStatus(""), 4000);
  }

  async function handleCleanOrphans() {
    setOrphanDialogOpen(false);
    setOrphanCleanStatus(t("orphanThumbnailsCleaning"));
    try {
      const result = (await ipc.client.photos.cleanOrphanThumbnails({})) as {
        removed: number;
        freedMB: number;
      };
      setOrphanCleanStatus(
        t("orphanThumbnailsCleaned", {
          count: result.removed,
          size: result.freedMB,
        })
      );
      refetchOrphans();
      queryClient.invalidateQueries({ queryKey: ["indexStats"] });
    } catch {
      setOrphanCleanStatus(t("clearCacheFailed"));
    }
    setTimeout(() => setOrphanCleanStatus(""), 4000);
  }

  const handleCleanupOrphans = useCallback(async () => {
    setCleanupStatus(t("cleanupOrphansRunning"));
    try {
      const result = await ipc.client.photos.cleanupOrphanPhotos({});
      const removed = result?.removed ?? 0;
      setCleanupCount(removed);
      setCleanupStatus(t("cleanupOrphansDone", { count: removed }));
      queryClient.invalidateQueries({ queryKey: ["indexStats"] });
    } catch {
      setCleanupStatus(t("cleanupOrphansFailed"));
    }
    setTimeout(() => setCleanupStatus(""), 4000);
  }, [queryClient]);

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center gap-4 border-border border-b px-6 py-4">
        <button
          className="text-muted-foreground hover:text-foreground"
          onClick={() => navigate({ to: "/" })}
        >
          <ArrowLeft className="h-5 w-5" />
        </button>
        <h1 className="font-[590] text-[18px] text-foreground">
          {t("settingsTitle")}
        </h1>
      </div>

      <div className="flex min-h-0 flex-1">
        {/* ── Left column: General settings ── */}
        <div
          className="min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden p-6"
          ref={scrollMainRef}
          style={{ maxWidth: 446, scrollbarGutter: "stable" }}
        >
          <section className="space-y-3">
            <h2 className="font-[590] text-[14px] text-foreground">
              {t("settingsAppearance")}
            </h2>
            <div className="rounded-[8px] border border-border bg-secondary p-4">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-[13px] text-muted-foreground">
                    {t("settingsTheme")}
                  </span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    {themeMode === "dark"
                      ? t("themeDark")
                      : themeMode === "light"
                        ? t("themeLight")
                        : t("themeSystem")}
                  </p>
                </div>
                <ToggleTheme onChange={setThemeMode} />
              </div>
              <div className="mt-3 flex items-center justify-between border-border border-t pt-3">
                <span className="text-[13px] text-muted-foreground">
                  {t("settingsLanguage")}
                </span>
                <LangToggle />
              </div>
            </div>
          </section>

          <section className="space-y-3">
            <h2 className="font-[590] text-[14px] text-foreground">
              {t("settingsIndexing")}
            </h2>
            <div className="rounded-[8px] border border-border bg-secondary p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] text-muted-foreground">
                    {t("settingsThumbnailCache")}
                  </span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    {t("settingsThumbnailCacheHint")}
                  </p>
                  <div className="mt-2">
                    {indexStats ? (
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            {t("settingsThumbnailCacheLocation")}
                          </span>
                          <span
                            className={`cursor-pointer truncate font-mono text-[11px] hover:text-foreground ${
                              copiedPath === indexStats.thumbnailCacheDir
                                ? "text-green-600"
                                : "text-muted-foreground/80"
                            }`}
                            onClick={() =>
                              handleCopyPath(indexStats.thumbnailCacheDir)
                            }
                            title={indexStats.thumbnailCacheDir || ""}
                          >
                            {copiedPath === indexStats.thumbnailCacheDir
                              ? t("copied")
                              : indexStats.thumbnailCacheDir || "-"}
                          </span>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            {t("settingsThumbnailCacheSize")}
                          </span>
                          <span className="font-[590] text-[12px] text-foreground">
                            {formatBytes(indexStats.thumbnailCacheBytes)}
                          </span>
                          <span className="text-[11px] text-muted-foreground/60">
                            ({indexStats.thumbnailCacheFileCount})
                          </span>
                        </div>
                      </div>
                    ) : (
                      <SkeletonBlock lines={3} />
                    )}
                  </div>
                </div>
                <AlertDialog
                  onOpenChange={setClearDialogOpen}
                  open={clearDialogOpen}
                >
                  <AlertDialogTrigger asChild>
                    <button
                      className="max-w-[140px] shrink-0 truncate rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                      title={clearCacheStatus || t("settingsClear")}
                    >
                      {clearCacheStatus || t("settingsClear")}
                    </button>
                  </AlertDialogTrigger>
                  <AlertDialogContent size="sm">
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("clearThumbConfirmTitle")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("clearThumbConfirmDesc")}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                      <AlertDialogAction onClick={handleClearCache}>
                        {t("confirm")}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>

              {/* Orphan thumbnail warning + one-click cleanup */}
              {orphanData && orphanData.orphanCount > 0 && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-[6px] border border-amber-500/30 bg-amber-500/10 px-3 py-2">
                  <div className="min-w-0 flex-1">
                    <span className="text-[12px] text-amber-600 dark:text-amber-400">
                      {orphanCleanStatus ||
                        t("orphanThumbnailsDetected", {
                          count: orphanData.orphanCount,
                          size: (
                            orphanData.orphanSizeBytes /
                            (1024 * 1024)
                          ).toFixed(1),
                        })}
                    </span>
                  </div>
                  <AlertDialog
                    onOpenChange={setOrphanDialogOpen}
                    open={orphanDialogOpen}
                  >
                    <AlertDialogTrigger asChild>
                      <button className="shrink-0 rounded-[6px] border border-amber-500/50 px-3 py-1.5 text-[12px] text-amber-600 transition-colors hover:bg-amber-500/20 dark:text-amber-400">
                        {t("orphanThumbnailsClean")}
                      </button>
                    </AlertDialogTrigger>
                    <AlertDialogContent size="sm">
                      <AlertDialogHeader>
                        <AlertDialogTitle>
                          {t("cleanOrphanThumbConfirmTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("cleanOrphanThumbConfirmDesc", {
                            count: orphanData.orphanCount,
                            size: (
                              orphanData.orphanSizeBytes /
                              (1024 * 1024)
                            ).toFixed(1),
                          })}
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
                        <AlertDialogAction onClick={handleCleanOrphans}>
                          {t("confirm")}
                        </AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>
              )}

              <div className="mt-3 flex items-start justify-between gap-3 border-border border-t pt-3">
                <div className="min-w-0 flex-1">
                  <span className="text-[13px] text-muted-foreground">
                    {t("cleanupInvalidIndex")}
                  </span>
                  <p className="mt-0.5 text-[11px] text-muted-foreground/70">
                    {t("settingsInvalidIndexHint")}
                    {cleanupCount > 0 && " "}
                    {cleanupCount > 0 &&
                      t("lastCleanupCount", { count: cleanupCount })}
                  </p>
                  <div className="mt-2">
                    {indexStats ? (
                      <div className="space-y-1">
                        <div className="flex items-baseline gap-3">
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[11px] text-muted-foreground/60">
                              {t("settingsValidIndexCount")}
                            </span>
                            <span className="font-[590] text-[12px] text-foreground">
                              {indexStats.validPhotoCount.toLocaleString()}
                            </span>
                          </div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-[11px] text-muted-foreground/60">
                              {t("settingsInvalidIndexCount")}
                            </span>
                            <span
                              className={`font-[590] text-[12px] ${
                                indexStats.invalidPhotoCount > 0
                                  ? "text-destructive"
                                  : "text-foreground"
                              }`}
                            >
                              {indexStats.invalidPhotoCount.toLocaleString()}
                            </span>
                          </div>
                        </div>
                        <div className="flex items-baseline gap-2">
                          <span className="shrink-0 text-[11px] text-muted-foreground/60">
                            {t("settingsIndexDbLocation")}
                          </span>
                          <span
                            className={`cursor-pointer truncate font-mono text-[11px] hover:text-foreground ${
                              copiedPath === indexStats.databasePath
                                ? "text-green-600"
                                : "text-muted-foreground/80"
                            }`}
                            onClick={() =>
                              handleCopyPath(indexStats.databasePath)
                            }
                            title={indexStats.databasePath || ""}
                          >
                            {copiedPath === indexStats.databasePath
                              ? t("copied")
                              : indexStats.databasePath || "-"}
                          </span>
                        </div>
                      </div>
                    ) : (
                      <SkeletonBlock lines={3} />
                    )}
                  </div>
                </div>
                <button
                  className="flex max-w-[140px] shrink-0 items-center gap-1.5 rounded-[6px] border border-destructive/30 px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive/50 hover:bg-destructive/5"
                  onClick={handleCleanupOrphans}
                  title={cleanupStatus || t("cleanupInvalidRecords")}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">
                    {cleanupStatus || t("cleanupInvalidRecords")}
                  </span>
                </button>
              </div>
            </div>
          </section>

          <DataDirSection />
        </div>

        {/* ── Divider ── */}
        <div className="w-px self-stretch border-border border-l" />

        {/* ── Right column: Watermark ── */}
        <div
          className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6"
          ref={scrollLogsRef}
          style={{ maxWidth: 566, scrollbarGutter: "stable" }}
        >
          <section className="space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="font-[590] text-[14px] text-foreground">
                {t("watermarkSettings")}
              </h2>
              <button
                className={`h-5 w-9 rounded-full transition-colors ${
                  wm.enabled ? "bg-primary" : "bg-muted"
                }`}
                onClick={() =>
                  setWm((prev) => ({ ...prev, enabled: !prev.enabled }))
                }
              >
                <div
                  className={`h-4 w-4 rounded-full bg-white transition-transform ${
                    wm.enabled ? "translate-x-[18px]" : "translate-x-[2px]"
                  }`}
                />
              </button>
            </div>

            {/* Preview (always visible, dimmed when disabled) */}
            <div className={wm.enabled ? "" : "pointer-events-none opacity-30"}>
              <WatermarkPreview
                onSettingsChange={(patch) =>
                  setWm((prev) => ({ ...prev, ...patch }))
                }
                samplePhotoPath={samplePhoto}
                wm={wm}
              />
            </div>

            {wm.enabled && (
              <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
                {/* Margin slider */}
                <div>
                  <label className="mb-1 block text-[11px] text-muted-foreground/70">
                    {t("watermarkMargin", { value: wm.margin })}
                  </label>
                  <input
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    max={15}
                    min={2}
                    onChange={(e) =>
                      setWm((prev) => ({
                        ...prev,
                        margin: Number(e.target.value),
                      }))
                    }
                    step={1}
                    type="range"
                    value={wm.margin}
                  />
                </div>

                {/* Text watermark */}
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[11px] text-muted-foreground/70">
                    {t("watermarkText")}
                  </label>
                  <input
                    className="h-8 w-full rounded-[6px] border border-input bg-card px-3 text-[13px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary"
                    onChange={(e) =>
                      setWm((prev) => ({ ...prev, text: e.target.value }))
                    }
                    placeholder={t("watermarkTextPlaceholder")}
                    value={wm.text}
                  />
                </div>

                {/* Image watermark */}
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[11px] text-muted-foreground/70">
                    {t("watermarkImage")}
                  </label>
                  <div className="flex items-center gap-2">
                    <button
                      className="rounded-[6px] border border-input px-3 py-1.5 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                      onClick={async () => {
                        try {
                          const result = (await ipc.client.shell.openFileDialog(
                            {
                              filters: [
                                {
                                  name: "Images",
                                  extensions: [
                                    "png",
                                    "jpg",
                                    "jpeg",
                                    "webp",
                                    "svg",
                                  ],
                                },
                              ],
                            }
                          )) as { path?: string };
                          if (result?.path) {
                            setWm((prev) => ({
                              ...prev,
                              imagePath: result.path!,
                            }));
                          }
                        } catch {
                          /* ignore */
                        }
                      }}
                      type="button"
                    >
                      {wm.imagePath ? t("changeFile") : t("chooseFile")}
                    </button>
                    {wm.imagePath && (
                      <span className="min-w-0 flex-1 truncate text-[11px] text-muted-foreground/70">
                        {wm.imagePath.split(/[\\/]/).pop()}
                      </span>
                    )}
                    {wm.imagePath && (
                      <button
                        className="text-[10px] text-destructive hover:underline"
                        onClick={() =>
                          setWm((prev) => ({ ...prev, imagePath: "" }))
                        }
                        type="button"
                      >
                        {t("clear")}
                      </button>
                    )}
                  </div>
                </div>

                {/* Size slider */}
                <div className="border-border border-t pt-3">
                  <label className="mb-1 flex items-center justify-between text-[11px] text-muted-foreground/70">
                    <span>
                      {wm.imagePath
                        ? t("watermarkImageScale", { value: wm.imageScale })
                        : t("watermarkFontSize", { value: wm.fontSize })}
                    </span>
                    <span className="text-[10px] text-muted-foreground/50">
                      {wm.imagePath ? "5% — 50%" : "12 — 72"}
                    </span>
                  </label>
                  {wm.imagePath ? (
                    <input
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                      max={50}
                      min={5}
                      onChange={(e) =>
                        setWm((prev) => ({
                          ...prev,
                          imageScale: Number(e.target.value),
                        }))
                      }
                      step={1}
                      type="range"
                      value={wm.imageScale}
                    />
                  ) : (
                    <input
                      className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                      max={72}
                      min={12}
                      onChange={(e) =>
                        setWm((prev) => ({
                          ...prev,
                          fontSize: Number(e.target.value),
                        }))
                      }
                      step={2}
                      type="range"
                      value={wm.fontSize}
                    />
                  )}
                </div>

                {/* Opacity */}
                <div className="border-border border-t pt-3">
                  <label className="mb-1 block text-[11px] text-muted-foreground/70">
                    {t("watermarkOpacity", { value: wm.opacity })}
                  </label>
                  <input
                    className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                    max={100}
                    min={10}
                    onChange={(e) =>
                      setWm((prev) => ({
                        ...prev,
                        opacity: Number(e.target.value),
                      }))
                    }
                    step={5}
                    type="range"
                    value={wm.opacity}
                  />
                </div>
              </div>
            )}
          </section>
        </div>

        {/* ── Divider ── */}
        <div className="w-px self-stretch border-border border-l" />

        {/* ── Right column: GPU, Cloud, Update & About ── */}
        <div
          className="min-w-0 flex-1 space-y-6 overflow-y-auto overflow-x-hidden p-6"
          ref={scrollAiRef}
          style={{ maxWidth: 386, scrollbarGutter: "stable" }}
        >
          <GpuSettingsCard />

          <section className="space-y-3">
            <h2 className="font-[590] text-[14px] text-foreground">
              {t("cloudSync")}
            </h2>
            <CloudConfigPanel />
          </section>

          <UpdateSection appVersion={appVersion} />

          <section className="space-y-3">
            <h2 className="font-[590] text-[14px] text-foreground">
              {t("settingsAbout")}
            </h2>
            <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
              <div className="flex items-center justify-between">
                <span className="text-[13px] text-muted-foreground">
                  {t("settingsVersion")}
                </span>
                <span className="text-[13px] text-foreground">
                  {appVersion || "..."}
                </span>
              </div>
              <div className="flex items-center justify-between border-border border-t pt-3">
                <span className="text-[13px] text-muted-foreground">
                  {t("settingsLicense")}
                </span>
                <span className="text-[13px] text-foreground">MIT</span>
              </div>
              <div className="flex items-center justify-between border-border border-t pt-3">
                <span className="text-[13px] text-muted-foreground">
                  {t("settingsAuthor")}
                </span>
                <span className="text-[13px] text-foreground">Uyoung</span>
              </div>
              {/* GitHub link */}
              <div className="border-border border-t pt-3">
                <button
                  className="flex w-full items-center gap-2 rounded-[6px] border border-input px-3 py-2 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                  onClick={() =>
                    openExternalLink(
                      "https://github.com/Uyoung666/ai-image-manager"
                    )
                  }
                  title={t("settingsOpenGitHub")}
                >
                  <SiGithub className="h-4 w-4" />
                  <span>{t("settingsGitHub")}</span>
                </button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

export const Route = createFileRoute("/settings")({ component: SettingsPage });
