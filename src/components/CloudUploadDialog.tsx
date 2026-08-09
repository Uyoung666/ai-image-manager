import { Cloud, CloudUpload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
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

export function CloudUploadDialog({
  open,
  onClose,
  photoIds,
}: CloudUploadDialogProps) {
  const { t } = useTranslation();
  const [configs, setConfigs] = useState<CloudConfig[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const abortRef = useRef(false);

  const loadConfigs = useCallback(async () => {
    try {
      const list = (await ipc.client.cloud.listCloudConfigs(
        {}
      )) as CloudConfig[];
      setConfigs(list);
      if (list.length === 1) {
        setSelectedId(list[0].id);
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    if (open) {
      loadConfigs();
      setProgress(null);
      setUploading(false);
      setDone(false);
      abortRef.current = false;
    }
  }, [open, loadConfigs]);

  async function handleUpload() {
    if (!selectedId || uploading) {
      return;
    }
    setUploading(true);
    setProgress({ done: 0, fail: 0, total: photoIds.length });

    for (const photoId of photoIds) {
      if (abortRef.current) {
        break;
      }
      try {
        const res = (await ipc.client.cloud.uploadPhotoToCloud({
          cloudConfigId: selectedId,
          photoId,
        })) as { success: boolean; error?: string };
        setProgress((p) => {
          if (!p) {
            return p;
          }
          return res.success
            ? { ...p, done: p.done + 1 }
            : { ...p, fail: p.fail + 1 };
        });
      } catch {
        setProgress((p) => (p ? { ...p, fail: p.fail + 1 } : p));
      }
    }

    setUploading(false);
    setDone(true);
  }

  const pct = progress
    ? Math.round(((progress.done + progress.fail) / progress.total) * 100)
    : 0;
  let progressBarClass = "bg-primary";
  let progressLabel = "";
  if (progress) {
    if (done && progress.fail === 0) {
      progressBarClass = "bg-success";
    } else if (progress.fail > 0) {
      progressBarClass = "bg-warning";
    }
    if (done && progress.fail === 0) {
      progressLabel = t("cloudUploadDone", { count: progress.done });
    } else if (done) {
      progressLabel = t("cloudUploadDonePartial", {
        done: progress.done,
        fail: progress.fail,
      });
    } else {
      progressLabel = t("cloudUploadingProgress", {
        done: progress.done + progress.fail,
        total: progress.total,
      });
    }
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
        </DialogHeader>

        {configs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
            <Cloud className="h-10 w-10 opacity-40" />
            <p className="text-[13px]">{t("cloudNoConfig")}</p>
            <p className="text-[11px] opacity-70">{t("cloudNoConfigHint")}</p>
          </div>
        ) : (
          <>
            <div>
              <p className="mb-1.5 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("cloudTargetStorage")}
              </p>
              <div className="max-h-[min(18rem,40dvh)] space-y-1 overflow-y-auto overscroll-contain pr-1">
                {configs.map((cfg) => (
                  <button
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
        )}

        <DialogFooter>
          <button
            className="max-w-full rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors [overflow-wrap:anywhere] hover:bg-foreground/5 disabled:opacity-40"
            disabled={uploading}
            onClick={onClose}
            type="button"
          >
            {done && progress ? t("close") : t("cancel")}
          </button>
          {configs.length > 0 && !done && (
            <button
              className="flex max-w-full items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity [overflow-wrap:anywhere] hover:opacity-90 disabled:opacity-40"
              disabled={!selectedId || uploading}
              onClick={handleUpload}
              type="button"
            >
              <CloudUpload className="h-4 w-4" />
              {t("cloudUploadAction", { count: photoIds.length })}
            </button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
