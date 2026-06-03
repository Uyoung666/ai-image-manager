import { SiGithub } from "@icons-pack/react-simple-icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Loader2, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
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
import { openExternalLink } from "@/actions/shell";
import { getCurrentTheme, type ThemeMode } from "@/actions/theme";
import { CloudConfigPanel } from "@/components/CloudConfigPanel";
import LangToggle from "@/components/lang-toggle";
import ToggleTheme from "@/components/toggle-theme";
import {
  WatermarkPreview,
  type WatermarkPreviewSettings,
} from "@/components/WatermarkPreview";
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

function MirrorSettingsSection() {
  const { t } = useTranslation();
  const [mirror, setMirror] = useState<string>("auto");
  const [customMirror, setCustomMirror] = useState<string>("");
  const [saveStatus, setSaveStatus] = useState<string>("");

  useEffect(() => {
    ipc.client.settings.getMirrorSettings({}).then((r: any) => {
      setMirror(r.mirror || "auto");
      setCustomMirror(r.customUrl || "");
    });
  }, []);

  const mirrorOptions = [
    { value: "auto", label: t("aiMirrorAuto"), url: null },
    {
      value: "hf-mirror",
      label: t("aiMirrorHfMirror"),
      url: "https://hf-mirror.com",
    },
    {
      value: "modelscope",
      label: t("aiMirrorModelScope"),
      url: "https://modelscope.cn",
    },
    {
      value: "official",
      label: t("aiMirrorOfficial"),
      url: "https://huggingface.co",
    },
    { value: "custom", label: t("aiMirrorCustom"), url: customMirror },
  ];

  async function handleSave() {
    setSaveStatus(t("saving"));
    try {
      await ipc.client.settings.setMirrorSettings({
        mirror,
        customUrl: customMirror,
      });
      setSaveStatus(t("aiMirrorSaved"));
      setTimeout(() => setSaveStatus(""), 3000);
    } catch {
      setSaveStatus(t("saveFailed"));
      setTimeout(() => setSaveStatus(""), 3000);
    }
  }

  return (
    <section className="space-y-3">
      <h2 className="font-[590] text-[14px] text-foreground">
        {t("aiMirrorSettings")}
      </h2>
      <div className="space-y-3 rounded-[8px] border border-border bg-secondary p-4">
        <div>
          <label className="mb-1 block text-[13px] text-muted-foreground">
            {t("aiMirrorSource")}
          </label>
          <select
            className="w-full rounded-[6px] border border-input bg-background px-3 py-2 text-[12px] outline-none transition-colors focus:border-primary"
            onChange={(e) => setMirror(e.target.value)}
            value={mirror}
          >
            {mirrorOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-muted-foreground/70">
            {t("aiMirrorSourceHint")}
          </p>
        </div>

        {mirror === "custom" && (
          <div className="border-border border-t pt-3">
            <label className="mb-1 block text-[11px] text-muted-foreground/70">
              {t("aiMirrorCustomUrl")}
            </label>
            <input
              className="w-full rounded-[6px] border border-input bg-background px-3 py-2 text-[12px] outline-none transition-colors focus:border-primary"
              onChange={(e) => setCustomMirror(e.target.value)}
              placeholder="https://your-mirror.com"
              type="text"
              value={customMirror}
            />
          </div>
        )}

        <div className="border-border border-t pt-3">
          <button
            className="rounded-[6px] bg-primary px-3 py-1.5 text-[12px] text-primary-foreground transition-colors hover:bg-primary/90"
            onClick={handleSave}
          >
            {saveStatus || t("save")}
          </button>
          <p className="mt-2 text-[11px] text-muted-foreground/70">
            {t("aiMirrorRestartHint")}
          </p>
        </div>
      </div>
    </section>
  );
}

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

function UpdateSection() {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [updateVersion, setUpdateVersion] = useState("");
  const [errorMsg, setErrorMsg] = useState("");
  const [lastCheckTime, setLastCheckTime] = useState<string>("");
  const [appVersion, setAppVersion] = useState("");

  // Load app version on mount
  useEffect(() => {
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

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
      if (status.message && status.message !== "DEV_MODE") {
        setErrorMsg(status.message);
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
          break;
        case "downloading":
          setPhase("downloading");
          if (data.version) {
            setUpdateVersion(data.version);
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
          break;
        case "error":
          setPhase("error");
          setErrorMsg(
            data.message === "DEV_MODE"
              ? t("updateDevMode")
              : data.message || t("updateError")
          );
          break;
      }
    }
    // Also listen for update:available to sync state
    function onUpdateAvailable(event: MessageEvent) {
      if (event.data?.channel === "update:available") {
        setPhase("downloaded");
        setUpdateVersion(event.data.version || "");
      }
    }
    window.addEventListener("message", onMessage);
    window.addEventListener("message", onUpdateAvailable);
    return () => {
      window.removeEventListener("message", onMessage);
      window.removeEventListener("message", onUpdateAvailable);
    };
  }, [t]);

  async function handleCheck() {
    setPhase("checking");
    setErrorMsg("");
    try {
      const result = await ipc.client.app.checkForUpdates({});
      const data = result as { ok?: boolean; error?: string } | undefined;
      if (!data?.ok) {
        setPhase("error");
        setErrorMsg(
          data?.error === "DEV_MODE"
            ? t("updateDevMode")
            : data?.error || t("updateError")
        );
      }
    } catch (err: any) {
      setPhase("error");
      setErrorMsg(err?.message || t("updateError"));
    }
  }

  function handleRestart() {
    window.electronAPI?.restartApp?.();
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

          {/* Downloading (indeterminate progress bar with stripe animation) */}
          {phase === "downloading" && (
            <div>
              <p className="text-[13px] text-muted-foreground">
                {updateVersion
                  ? t("updateFound", { version: updateVersion })
                  : t("updateDownloading")}
              </p>
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full animate-pulse rounded-full bg-primary"
                  style={{
                    width: "60%",
                    backgroundImage:
                      "linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.3) 50%, transparent 100%)",
                    backgroundSize: "200% 100%",
                    animation: "pulse 1.5s ease-in-out infinite",
                  }}
                />
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground/60">
                {t("updateDownloading")}
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
      </div>
    </section>
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
  const [wm, setWm] = useState<WatermarkSettings>(DEFAULT_WM);
  const [wmLoaded, setWmLoaded] = useState(false);
  const [themeMode, setThemeMode] = useState<ThemeMode>("dark");
  const [appVersion, setAppVersion] = useState("");
  const [samplePhoto, setSamplePhoto] = useState("");
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleCopyPath = useCallback((path: string) => {
    if (!path) return;
    navigator.clipboard.writeText(path).catch(() => {});
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopiedPath(path);
    copyTimerRef.current = setTimeout(() => setCopiedPath(null), 2000);
  }, []);

  const { data: indexStats } = useQuery({
    queryKey: ["indexStats"],
    queryFn: () => ipc.client.photos.getIndexStats({}),
    staleTime: 0, // thumbnail/file counts change externally, always fetch fresh
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    getCurrentTheme().then(setThemeMode);
    ipc.client.app.appVersion({}).then((v) => setAppVersion(v as string));
  }, []);

  // Load watermark settings + sample photo
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
        }
        setWmLoaded(true);
      })
      .catch(() => setWmLoaded(true));

    // Fetch a sample horizontal photo for watermark preview
    ipc.client.photos
      .listPhotos({ sort: "date", order: "desc", limit: 30 })
      .then((r: any) => {
        const photos = r?.pages?.[0]?.items || r?.items || [];
        const horizontal = photos.find(
          (p: any) => p.width && p.height && p.width >= p.height
        );
        if (horizontal?.path) {
          setSamplePhoto(horizontal.path);
        }
      })
      .catch(() => {});
  }, []);

  // Persist watermark settings to database via IPC on change
  useEffect(() => {
    if (!wmLoaded) {
      return;
    }
    ipc.client.photos.setWatermarkSettings(wm).catch(() => {
      /* ignore */
    });
  }, [wm, wmLoaded]);

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
          className="flex-1 min-w-0 space-y-6 overflow-y-auto overflow-x-hidden p-6"
          style={{ maxWidth: 440 }}
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
                  {indexStats && (
                    <div className="mt-2 space-y-1">
                      <div className="flex items-baseline gap-2">
                        <span className="shrink-0 text-[11px] text-muted-foreground/60">
                          {t("settingsThumbnailCacheLocation")}
                        </span>
                        <span
                          className={`cursor-pointer truncate font-mono text-[11px] hover:text-foreground ${
                            copiedPath === indexStats.thumbnailCacheDir ? "text-green-600" : "text-muted-foreground/80"
                          }`}
                          title={indexStats.thumbnailCacheDir || ""}
                          onClick={() => handleCopyPath(indexStats.thumbnailCacheDir)}
                        >
                          {copiedPath === indexStats.thumbnailCacheDir ? "✓ 已复制" : (indexStats.thumbnailCacheDir || "-")}
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
                  )}
                </div>
                <AlertDialog open={clearDialogOpen} onOpenChange={setClearDialogOpen}>
                  <AlertDialogTrigger asChild>
                    <button
                      className="shrink-0 max-w-[140px] truncate rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
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
                  {indexStats && (
                    <div className="mt-2 space-y-1">
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
                            copiedPath === indexStats.databasePath ? "text-green-600" : "text-muted-foreground/80"
                          }`}
                          title={indexStats.databasePath || ""}
                          onClick={() => handleCopyPath(indexStats.databasePath)}
                        >
                          {copiedPath === indexStats.databasePath ? "✓ 已复制" : (indexStats.databasePath || "-")}
                        </span>
                      </div>
                    </div>
                  )}
                </div>
                <button
                  className="flex shrink-0 items-center gap-1.5 max-w-[140px] rounded-[6px] border border-destructive/30 px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive/50 hover:bg-destructive/5"
                  onClick={handleCleanupOrphans}
                  title={cleanupStatus || t("cleanupInvalidRecords")}
                >
                  <Trash2 className="h-3.5 w-3.5 shrink-0" />
                  <span className="truncate">{cleanupStatus || t("cleanupInvalidRecords")}</span>
                </button>
              </div>
            </div>
          </section>

          <DataDirSection />

          <MirrorSettingsSection />

          <section className="space-y-3">
            <h2 className="font-[590] text-[14px] text-foreground">
              {t("cloudSync")}
            </h2>
            <CloudConfigPanel />
          </section>
        </div>

        {/* ── Divider ── */}
        <div className="w-px self-stretch border-border border-l" />

        {/* ── Right column: Watermark ── */}
        <div
          className="min-w-0 flex-1 space-y-4 overflow-y-auto p-6"
          style={{ maxWidth: 560 }}
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

        {/* ── Right column: Update & About ── */}
        <div
          className="flex-1 min-w-0 space-y-6 overflow-y-auto overflow-x-hidden p-6"
          style={{ maxWidth: 380 }}
        >
          <UpdateSection />

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
