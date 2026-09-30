import { useNavigate } from "@tanstack/react-router";
import { Cloud, CloudUpload } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { AnimatedActionButton } from "@/components/ui/animated-action-button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { ipc } from "@/ipc/manager";

interface CloudConfig {
  id: number;
  name: string;
  provider: string;
}

interface UploadProgress {
  done: number;
  fail: number;
  total: number;
}

interface CloudUploadDialogProps {
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

const PROVIDER_LABELS: Record<string, string> = {
  webdav: "WebDAV",
  s3: "S3",
};

type ConfigLoadState = "loading" | "error" | "loaded";

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: config states and upload progress stay localized to this dialog
export function CloudUploadDialog({
  open,
  onClose,
  photoIds,
}: CloudUploadDialogProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [configs, setConfigs] = useState<CloudConfig[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [configLoadState, setConfigLoadState] =
    useState<ConfigLoadState>("loading");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const [stopped, setStopped] = useState(false);
  const [stopRequested, setStopRequested] = useState(false);
  const abortRef = useRef(false);
  const statusRef = useRef<Map<number, "success" | "failed">>(new Map());
  const configRequestRef = useRef(0);
  const configLoadInFlightRef = useRef(false);

  const loadConfigs = useCallback(async () => {
    if (configLoadInFlightRef.current) {
      return;
    }
    configLoadInFlightRef.current = true;
    const requestId = ++configRequestRef.current;
    setConfigLoadState("loading");
    setConfigs([]);
    setSelectedId(null);
    try {
      const list = (await ipc.client.cloud.listCloudConfigs(
        {}
      )) as CloudConfig[];
      if (requestId !== configRequestRef.current) {
        return;
      }
      setConfigs(list);
      setSelectedId(list.length === 1 ? list[0].id : null);
      setConfigLoadState("loaded");
    } catch {
      if (requestId !== configRequestRef.current) {
        return;
      }
      setConfigs([]);
      setSelectedId(null);
      setConfigLoadState("error");
    } finally {
      if (requestId === configRequestRef.current) {
        configLoadInFlightRef.current = false;
      }
    }
  }, []);

  useEffect(() => {
    if (open) {
      setConfigLoadState("loading");
      setConfigs([]);
      setSelectedId(null);
      setProgress(null);
      setUploading(false);
      setDone(false);
      setStopped(false);
      setStopRequested(false);
      abortRef.current = false;
      statusRef.current.clear();
      loadConfigs();
    } else {
      configRequestRef.current += 1;
      configLoadInFlightRef.current = false;
    }
    return () => {
      abortRef.current = true;
    };
  }, [open, loadConfigs]);

  const handleOpenCloudSettings = useCallback(() => {
    onClose();
    navigate({ to: "/settings/cloud-sync" });
  }, [navigate, onClose]);

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: upload queue state and resumable progress are intentionally localized to this dialog
  async function handleUpload() {
    if (!selectedId || uploading) {
      return;
    }
    abortRef.current = false;
    setStopRequested(false);
    setStopped(false);
    setDone(false);
    setUploading(true);
    const updateProgress = () => {
      let doneCount = 0;
      let failCount = 0;
      for (const photoId of photoIds) {
        const status = statusRef.current.get(photoId);
        if (status === "success") {
          doneCount += 1;
        } else if (status === "failed") {
          failCount += 1;
        }
      }
      setProgress({ done: doneCount, fail: failCount, total: photoIds.length });
    };
    if (!progress) {
      setProgress({ done: 0, fail: 0, total: photoIds.length });
    }

    for (const photoId of photoIds) {
      if (abortRef.current) {
        break;
      }
      if (statusRef.current.get(photoId) === "success") {
        continue;
      }
      // A failed item is retried when the user resumes the stopped queue.
      statusRef.current.delete(photoId);
      updateProgress();
      try {
        const res = (await ipc.client.cloud.uploadPhotoToCloud({
          cloudConfigId: selectedId,
          photoId,
        })) as { success: boolean; error?: string };
        statusRef.current.set(photoId, res.success ? "success" : "failed");
        updateProgress();
      } catch {
        statusRef.current.set(photoId, "failed");
        updateProgress();
      }
    }

    setUploading(false);
    setStopRequested(false);
    const hasRemaining = photoIds.some(
      (photoId) => statusRef.current.get(photoId) !== "success"
    );
    if (abortRef.current && hasRemaining) {
      setStopped(true);
    } else {
      setStopped(false);
      setDone(true);
    }
  }

  function requestStop() {
    abortRef.current = true;
    setStopRequested(true);
  }

  const pct = progress
    ? Math.round(((progress.done + progress.fail) / progress.total) * 100)
    : 0;
  let progressBarClass = "bg-primary";
  let progressLabel = "";
  if (progress) {
    const remaining = Math.max(
      0,
      progress.total - progress.done - progress.fail
    );
    if (stopped) {
      progressBarClass = "bg-warning";
      progressLabel = t("cloudUploadStopped", {
        done: progress.done,
        fail: progress.fail,
        remaining,
      });
    } else if (done && progress.fail === 0) {
      progressBarClass = "bg-success";
      progressLabel = t("cloudUploadDone", { count: progress.done });
    } else if (done) {
      progressBarClass = "bg-warning";
      progressLabel = t("cloudUploadDonePartial", {
        done: progress.done,
        fail: progress.fail,
      });
    } else {
      if (progress.fail > 0) {
        progressBarClass = "bg-warning";
      }
      progressLabel = t("cloudUploadingProgress", {
        done: progress.done + progress.fail,
        total: progress.total,
      });
    }
  }

  let actionLabel = t("cloudUploadAction", { count: photoIds.length });
  if (uploading) {
    actionLabel =
      progressLabel ||
      t("cloudUploadingProgress", {
        done: progress?.done ?? 0,
        total: progress?.total ?? photoIds.length,
      });
  } else if (stopped) {
    actionLabel = t("cloudUploadResume");
  }

  let configContent: ReactNode;
  if (configLoadState === "loading") {
    configContent = (
      <div
        aria-live="polite"
        className="flex items-center justify-center gap-2 px-3 py-6 text-[13px] text-muted-foreground"
        role="status"
      >
        <LoadingSpinner size="sm" />
        <span>{t("loading")}</span>
      </div>
    );
  } else if (configLoadState === "error") {
    configContent = (
      <div
        aria-live="polite"
        className="flex flex-col items-center gap-3 px-3 py-6 text-center text-[13px] text-muted-foreground"
        role="alert"
      >
        <p>{t("cloudLoadFailed")}</p>
        <p className="text-[11px] opacity-70">{t("loadFailedRetry")}</p>
        <button
          className="rounded-[6px] border border-border px-3 py-1.5 text-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
          onClick={loadConfigs}
          type="button"
        >
          {t("retry")}
        </button>
      </div>
    );
  } else if (configs.length === 0) {
    configContent = (
      <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
        <Cloud className="h-10 w-10 opacity-40" />
        <p className="text-[13px]">{t("cloudNoConfig")}</p>
        <p className="text-[11px] opacity-70">{t("cloudNoConfigHint")}</p>
        <button
          className="rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90"
          onClick={handleOpenCloudSettings}
          type="button"
        >
          {t("cloudSync")}
        </button>
      </div>
    );
  } else {
    configContent = (
      <>
        <div>
          <p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
            {t("cloudTargetStorage")}
          </p>
          <div className="max-h-[min(18rem,40dvh)] space-y-1 overflow-y-auto overscroll-contain pr-1">
            {configs.map((cfg) => (
              <button
                aria-pressed={selectedId === cfg.id}
                className={`flex w-full min-w-0 items-start gap-2 rounded-[6px] border px-3 py-2.5 text-left text-[13px] transition-colors ${
                  selectedId === cfg.id
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-input text-muted-foreground hover:border-muted-foreground"
                }`}
                disabled={uploading}
                key={cfg.id}
                onClick={() => setSelectedId(cfg.id)}
                type="button"
              >
                <span className="min-w-0 flex-1 text-foreground [overflow-wrap:anywhere]">
                  {cfg.name}
                </span>
                <span className="shrink-0 text-[11px] opacity-60">
                  {PROVIDER_LABELS[cfg.provider] || cfg.provider}
                </span>
              </button>
            ))}
          </div>
        </div>

        {progress && (
          <div className="space-y-2">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div
                className={`h-full rounded-full transition-all duration-300 ${progressBarClass}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <p className="text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
              {progressLabel}
            </p>
          </div>
        )}

        {uploading && (
          <div className="flex min-w-0 items-start gap-2 text-[11px] text-muted-foreground [overflow-wrap:anywhere]">
            <LoadingSpinner size="xs" />
            {t("cloudUploadingHint")}
          </div>
        )}
      </>
    );
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || uploading)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)]"
        onEscapeKeyDown={(e) => {
          if (uploading) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (uploading) {
            e.preventDefault();
          }
        }}
        showCloseButton={!uploading}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>{t("cloudUploadTitle")}</DialogTitle>
          <p className="text-[11px] text-muted-foreground/70 [overflow-wrap:anywhere]">
            {t("cloudSyncScope")}
          </p>
          <DialogDescription className="sr-only">
            {t("cloudUploadAction", { count: photoIds.length })}
          </DialogDescription>
        </DialogHeader>

        {configContent}

        <DialogFooter>
          <button
            className="max-w-full rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors [overflow-wrap:anywhere] hover:bg-foreground/5 disabled:opacity-40"
            disabled={uploading}
            onClick={onClose}
            type="button"
          >
            {done && progress ? t("close") : t("cancel")}
          </button>
          {uploading && (
            <button
              className="max-w-full rounded-md border border-warning/40 px-4 py-1.5 font-medium text-[13px] text-warning transition-colors [overflow-wrap:anywhere] hover:bg-warning/10 disabled:opacity-40"
              disabled={stopRequested}
              onClick={requestStop}
              type="button"
            >
              {t("cloudUploadStop")}
            </button>
          )}
          {configLoadState === "loaded" && configs.length > 0 && !done && (
            <AnimatedActionButton
              className="py-1.5 [overflow-wrap:anywhere]"
              disabled={!selectedId || uploading}
              icon={
                uploading ? (
                  <LoadingSpinner size="sm" variant="inherit" />
                ) : (
                  <CloudUpload className="h-4 w-4" />
                )
              }
              loading={uploading}
              onClick={handleUpload}
            >
              {actionLabel}
            </AnimatedActionButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
