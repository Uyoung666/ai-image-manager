import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Trash2 } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataDirSection } from "@/components/settings/DataDirSection";
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
  const precision = value >= 100 || i === 0 ? 0 : value >= 10 ? 1 : 2;
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
          key={i}
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
    <div className="h-full space-y-6 overflow-y-auto p-6" ref={scrollRef}>
      <section className="space-y-3">
        <h2 className="font-semibold text-[14px] text-foreground">
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
                        className={`cursor-pointer truncate font-mono text-[11px] hover:text-foreground ${
                          copiedPath === indexStats.databasePath
                            ? "text-green-600"
                            : "text-muted-foreground/80"
                        }`}
                        onClick={() => handleCopyPath(indexStats.databasePath)}
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
  );
}

export const Route = createFileRoute("/settings/storage")({
  component: StorageSettingsPage,
});
