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
              <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("cloudTargetStorage")}
              </label>
              <div className="space-y-1">
                {configs.map((cfg) => (
                  <button
                    className={`w-full rounded-[6px] border px-3 py-2.5 text-left text-[13px] transition-colors ${
                      selectedId === cfg.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-input text-muted-foreground hover:border-muted-foreground"
                    }`}
                    disabled={uploading}
                    key={cfg.id}
                    onClick={() => setSelectedId(cfg.id)}
                    type="button"
                  >
                    <span className="text-foreground">{cfg.name}</span>
                    <span className="ml-2 text-[11px] opacity-60">
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
                    className={`h-full rounded-full transition-all duration-300 ${
                      done && progress.fail === 0
                        ? "bg-success"
                        : progress.fail > 0
                          ? "bg-warning"
                          : "bg-primary"
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {done
                    ? progress.fail === 0
                      ? t("cloudUploadDone", { count: progress.done })
                      : t("cloudUploadDonePartial", {
                          done: progress.done,
                          fail: progress.fail,
                        })
                    : t("cloudUploadingProgress", {
                        done: progress.done + progress.fail,
                        total: progress.total,
                      })}
                </p>
              </div>
            )}

            {uploading && (
              <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                {t("cloudUploadingHint")}
              </div>
            )}
          </>
        )}

        <DialogFooter>
          <button
            className="rounded-md border border-border px-4 py-1.5 font-[510] text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
            disabled={uploading}
            onClick={onClose}
            type="button"
          >
            {done && progress ? t("close") : t("cancel")}
          </button>
          {configs.length > 0 && !done && (
            <button
              className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 font-[510] text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
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
