import { Cloud, Copy, ExternalLink, Share2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { openExternalLink } from "@/actions/shell";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc/manager";
import { getDateLocale } from "@/utils/date-locale";

interface CloudConfig {
  id: number;
  name: string;
  provider: string;
}

interface ShareDialogProps {
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

const PROVIDER_LABELS: Record<string, string> = {
  webdav: "WebDAV",
  s3: "S3",
};

export function ShareDialog({ open, onClose, photoIds }: ShareDialogProps) {
  const { t, i18n } = useTranslation();
  const [configs, setConfigs] = useState<CloudConfig[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{
    url: string;
    filename: string;
    provider?: string;
  } | null>(null);

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
      setResult(null);
      setLoading(false);
    }
  }, [open, loadConfigs]);

  async function handleGenerate() {
    if (!selectedId || loading) {
      return;
    }
    setLoading(true);
    try {
      const res = (await ipc.client.photos.generateAndUploadShare({
        photoIds,
        cloudConfigId: selectedId,
        locale: getDateLocale(i18n.language),
      })) as {
        success: boolean;
        url?: string;
        filename?: string;
        error?: string;
      };
      if (res.success && res.url) {
        setResult({ url: res.url, filename: res.filename || "" });
        toast.success(t("sharePublished"));
      } else {
        toast.error(res.error || t("shareFailed"));
      }
    } catch (err: any) {
      toast.error(err?.message || t("shareException"));
    }
    setLoading(false);
  }

  async function handleCopyUrl() {
    if (!result) {
      return;
    }
    try {
      await navigator.clipboard.writeText(result.url);
      toast.success(t("linkCopied"));
    } catch {
      toast(t("copyManually"), { description: result.url });
    }
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || loading)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        onEscapeKeyDown={(e) => {
          if (loading) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (loading) {
            e.preventDefault();
          }
        }}
        showCloseButton={!loading}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>{t("sharePageTitle")}</DialogTitle>
        </DialogHeader>

        {result ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-[6px] bg-success/10 px-3 py-2 text-[12px] text-success">
              <Share2 className="h-4 w-4 flex-shrink-0" />
              {t("sharePublishedCloud")}
            </div>
            {result.provider === "webdav" && (
              <div className="rounded-[6px] bg-warning/10 px-3 py-2 text-[11px] text-warning/80">
                {t("webdavPrivateNote")}
              </div>
            )}
            <div>
              <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("shareLink")}
              </label>
              <div className="flex items-center gap-2">
                <input
                  className="h-8 flex-1 rounded-[4px] border border-input bg-card px-3 font-mono text-[12px] text-foreground outline-none"
                  readOnly
                  value={result.url}
                />
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-input text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  onClick={handleCopyUrl}
                  title={t("copyLink")}
                  type="button"
                >
                  <Copy className="h-3.5 w-3.5" />
                </button>
                <button
                  className="flex h-8 w-8 items-center justify-center rounded-[4px] border border-input text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                  onClick={() => openExternalLink(result.url)}
                  title={t("openInBrowser")}
                  type="button"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
            <DialogFooter>
              <button
                className="rounded-md border border-border px-4 py-1.5 font-[510] text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5"
                onClick={onClose}
                type="button"
              >
                {t("close")}
              </button>
            </DialogFooter>
          </div>
        ) : configs.length === 0 ? (
          <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
            <Cloud className="h-10 w-10 opacity-40" />
            <p className="text-[13px]">{t("noCloudConfig")}</p>
            <p className="text-center text-[11px] opacity-70">
              {t("shareNeedsCloud")}
              <br />
              {t("shareAddCloudHint")}
            </p>
          </div>
        ) : (
          <>
            <div>
              <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("uploadTo")}
              </label>
              <div className="space-y-1">
                {configs.map((cfg) => (
                  <button
                    className={`w-full rounded-[6px] border px-3 py-2.5 text-left text-[13px] transition-colors ${
                      selectedId === cfg.id
                        ? "border-primary/50 bg-primary/10 text-primary"
                        : "border-input text-muted-foreground hover:border-muted-foreground"
                    }`}
                    disabled={loading}
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

            <p className="text-[11px] text-muted-foreground/70">
              {t("shareDescription", { count: photoIds.length })}
            </p>

            <DialogFooter>
              <button
                className="rounded-md border border-border px-4 py-1.5 font-[510] text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
                disabled={loading}
                onClick={onClose}
                type="button"
              >
                {t("cancel")}
              </button>
              <button
                className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 font-[510] text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={!selectedId || loading}
                onClick={handleGenerate}
                type="button"
              >
                {loading ? (
                  <>
                    <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
                    {t("generating")}
                  </>
                ) : (
                  <>
                    <Share2 className="h-4 w-4" />
                    {t("generateAndPublish")}
                  </>
                )}
              </button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
