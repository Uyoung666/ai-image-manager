import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Check, Copy, Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { DataDirSection } from "@/components/settings/DataDirSection";
import { SettingRow } from "@/components/settings/setting-row";
import { SettingsPageShell } from "@/components/settings/settings-page-shell";
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
  let precision = 2;
  if (value >= 100 || i === 0) {
    precision = 0;
  } else if (value >= 10) {
    precision = 1;
  }
  return `${value.toFixed(precision)} ${units[i]}`;
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
          key={`skeleton-line-${i}`}
          style={{ width: `${[90, 70, 50][i] ?? 40}%` }}
        />
      ))}
    </div>
  );
}

function StorageSettingsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [clearCacheStatus, setClearCacheStatus] = useState("");
  const [clearDialogOpen, setClearDialogOpen] = useState(false);
  const [cleanupStatus, setCleanupStatus] = useState("");
  const [cleanupCount, setCleanupCount] = useState(0);
  const [orphanCleanStatus, setOrphanCleanStatus] = useState("");
  const [orphanDialogOpen, setOrphanDialogOpen] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  useRouteScrollRestoration(scrollRef);

  const handleCopyPath = useCallback(
    (path: string) => {
      if (!path) {
        return;
      }
      navigator.clipboard
        .writeText(path)
        .then(() => toast.success(t("copied")))
        .catch(() => toast.error(t("copyFailed")));
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      setCopiedPath(path);
      copyTimerRef.current = setTimeout(() => setCopiedPath(null), 2000);
    },
    [t]
  );

  const { data: indexStats } = useQuery({
    queryKey: ["indexStats"],
    queryFn: () => ipc.client.photos.getIndexStats({}),
    staleTime: 5 * 60_000, // 5min — backed by 2min server-side cache
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
    staleTime: 300_000,
    refetchOnWindowFocus: false,
  });

  async function handleClearCache() {
    setClearDialogOpen(false);
    setClearCacheStatus(t("settingsClearing"));
    try {
      const result = await ipc.client.photos.clearThumbCache({});
      const data = result as { fileCount?: number; freedMB?: number } | null;
      if (data?.fileCount === undefined) {
        setClearCacheStatus(t("settingsCleared"));
        toast.success(t("settingsCleared"));
      } else {
        const message = t("cacheCleanedDetail", {
          count: data.fileCount,
          size: data.freedMB ?? 0,
        });
        setClearCacheStatus(message);
        toast.success(message);
      }
    } catch {
      setClearCacheStatus(t("clearCacheFailed"));
      toast.error(t("clearCacheFailed"));
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
      toast.success(
        t("orphanThumbnailsCleaned", {
          count: result.removed,
          size: result.freedMB,
        })
      );
      refetchOrphans();
      queryClient.invalidateQueries({ queryKey: ["indexStats"] });
    } catch {
      setOrphanCleanStatus(t("clearCacheFailed"));
      toast.error(t("clearCacheFailed"));
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
      toast.success(t("cleanupOrphansDone", { count: removed }));
      queryClient.invalidateQueries({ queryKey: ["indexStats"] });
    } catch {
      setCleanupStatus(t("cleanupOrphansFailed"));
      toast.error(t("cleanupOrphansFailed"));
    }
    setTimeout(() => setCleanupStatus(""), 4000);
  }, [queryClient, t]);

  return (
    <SettingsPageShell scrollRef={scrollRef} title={t("settingsStorage")}>
      <section className="space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
          {t("settingsIndexing")}
        </h2>
        <div className="rounded-[8px] border border-border bg-secondary p-4">
          <SettingRow
            action={
              <AlertDialog
                onOpenChange={setClearDialogOpen}
                open={clearDialogOpen}
              >
                <AlertDialogTrigger asChild>
                  <button
                    className="max-w-[160px] shrink-0 truncate rounded-[6px] border border-input px-3 py-1.5 text-[12px] text-muted-foreground transition-colors hover:border-muted-foreground/30 hover:text-foreground"
                    title={clearCacheStatus || t("settingsClear")}
                    type="button"
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
            }
            description={t("settingsThumbnailCacheHint")}
            title={t("settingsThumbnailCache")}
          >
            {indexStats ? (
              <div className="space-y-1">
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[11px] text-muted-foreground/60">
                    {t("settingsThumbnailCacheLocation")}
                  </span>
                  <span
                    className="truncate font-mono text-[11px] text-muted-foreground/80"
                    title={indexStats.thumbnailCacheDir || ""}
                  >
                    {indexStats.thumbnailCacheDir || "-"}
                  </span>
                  <button
                    className="shrink-0 rounded-[4px] p-0.5 text-muted-foreground/50 hover:bg-foreground/5 hover:text-foreground"
                    onClick={() => handleCopyPath(indexStats.thumbnailCacheDir)}
                    title={t("copyPath")}
                    type="button"
                  >
                    {copiedPath === indexStats.thumbnailCacheDir ? (
                      <Check className="h-3 w-3 text-green-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>
                <div className="flex items-baseline gap-2">
                  <span className="shrink-0 text-[11px] text-muted-foreground/60">
                    {t("settingsThumbnailCacheSize")}
                  </span>
                  <span className="font-semibold text-[12px] text-foreground">
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
          </SettingRow>

          {/* Orphan thumbnail warning + one-click cleanup */}
          {orphanData && orphanData.orphanCount > 0 && (
            <SettingRow
              action={
                <AlertDialog
                  onOpenChange={setOrphanDialogOpen}
                  open={orphanDialogOpen}
                >
                  <AlertDialogTrigger asChild>
                    <button
                      className="shrink-0 rounded-[6px] border border-amber-500/50 px-3 py-1.5 text-[12px] text-amber-700 transition-colors hover:bg-amber-500/20 dark:text-amber-300"
                      type="button"
                    >
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
              }
              className="mt-3"
              title={
                <span className="text-[12px]">
                  {orphanCleanStatus ||
                    t("orphanThumbnailsDetected", {
                      count: orphanData.orphanCount,
                      size: (
                        orphanData.orphanSizeBytes /
                        (1024 * 1024)
                      ).toFixed(1),
                    })}
                </span>
              }
              tone="warning"
            />
          )}

          <SettingRow
            action={
              <button
                className="flex max-w-[160px] shrink-0 items-center gap-1.5 rounded-[6px] border border-destructive/30 px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive/50 hover:bg-destructive/5"
                onClick={handleCleanupOrphans}
                title={cleanupStatus || t("cleanupInvalidRecords")}
                type="button"
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                <span className="truncate">
                  {cleanupStatus || t("cleanupInvalidRecords")}
                </span>
              </button>
            }
            className="mt-3"
            description={
              <>
                {t("settingsInvalidIndexHint")}
                {cleanupCount > 0 && " "}
                {cleanupCount > 0 &&
                  t("lastCleanupCount", { count: cleanupCount })}
              </>
            }
            title={t("cleanupInvalidIndex")}
            tone={indexStats?.invalidPhotoCount ? "destructive" : "default"}
          >
            {indexStats ? (
              <div className="space-y-1">
                <div className="flex items-baseline gap-3">
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] text-muted-foreground/60">
                      {t("settingsValidIndexCount")}
                    </span>
                    <span className="font-semibold text-[12px] text-foreground">
                      {indexStats.validPhotoCount.toLocaleString()}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1.5">
                    <span className="text-[11px] text-muted-foreground/60">
                      {t("settingsInvalidIndexCount")}
                    </span>
                    <span
                      className={`font-semibold text-[12px] ${
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
                    className="truncate font-mono text-[11px] text-muted-foreground/80"
                    title={indexStats.databasePath || ""}
                  >
                    {indexStats.databasePath || "-"}
                  </span>
                  <button
                    className="shrink-0 rounded-[4px] p-0.5 text-muted-foreground/50 hover:bg-foreground/5 hover:text-foreground"
                    onClick={() => handleCopyPath(indexStats.databasePath)}
                    title={t("copyPath")}
                    type="button"
                  >
                    {copiedPath === indexStats.databasePath ? (
                      <Check className="h-3 w-3 text-green-600" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </button>
                </div>
              </div>
            ) : (
              <SkeletonBlock lines={3} />
            )}
          </SettingRow>
        </div>
      </section>

      <DataDirSection />
    </SettingsPageShell>
  );
}

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettingsPage,
});
