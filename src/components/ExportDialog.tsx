import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  readExportPreferences,
  saveExportPreferences,
} from "@/actions/export-preferences";
import { photoExportActions } from "@/actions/photo-export";
import { AnimatedActionButton } from "@/components/ui/animated-action-button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { Switch } from "@/components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { getDateLocale } from "@/utils/date-locale";

interface ExportDialogProps {
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

export function ExportDialog({ open, onClose, photoIds }: ExportDialogProps) {
  const { t, i18n } = useTranslation();
  const [format, setFormat] = useState<"original" | "compressed">("original");
  const [quality, setQuality] = useState(85);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [openAfterExport, setOpenAfterExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [result, setResult] = useState<{
    path?: string;
    filename?: string;
    photoCount?: number;
    sizeMB?: number;
    error?: string;
  } | null>(null);

  useEffect(() => {
    if (open) {
      const preferences = readExportPreferences();
      setFormat(preferences.format);
      setQuality(preferences.quality);
      setMaxWidth(preferences.maxWidth);
      setOpenAfterExport(preferences.openAfterExport);
      setResult(null);
      setExporting(false);
    }
  }, [open]);

  async function openFolder(path: string) {
    try {
      await photoExportActions.openFolder(path);
    } catch {
      toast.error(t("exportOpenFolderFailed"));
    }
  }

  async function handleExport() {
    setExporting(true);
    try {
      const defaultName = `gallery-${new Date().toISOString().slice(0, 10)}.zip`;
      const dialogResult = await photoExportActions.choosePath({
        defaultName,
        title: t("exportGalleryTitle"),
      });
      const savePath = (dialogResult as { path?: string } | null)?.path;
      if (!savePath) {
        setExporting(false);
        return;
      }
      const res = await photoExportActions.export({
        ids: photoIds,
        format,
        maxWidth: format === "compressed" ? maxWidth : undefined,
        quality: format === "compressed" ? quality : undefined,
        outputPath: savePath,
        locale: getDateLocale(i18n.language),
      });
      const data = res as {
        success: boolean;
        path?: string;
        filename?: string;
        photoCount?: number;
        sizeMB?: number;
        error?: string;
      };
      if (data.success) {
        saveExportPreferences({ format, quality, maxWidth, openAfterExport });
        setResult({
          path: data.path ?? "",
          filename: data.filename ?? "",
          photoCount: data.photoCount ?? 0,
          sizeMB: data.sizeMB ?? 0,
        });
        if (data.path && openAfterExport) {
          await openFolder(data.path);
        }
      } else {
        setResult({ error: data.error || t("exportFailed") });
      }
    } catch {
      setResult({ error: t("exportException") });
    }
    setExporting(false);
  }

  return (
    <Dialog
      onOpenChange={(next) => {
        if (!(next || exporting)) {
          onClose();
        }
      }}
      open={open}
    >
      <DialogContent
        className="max-h-[calc(100dvh-1rem)] overflow-y-auto overflow-x-hidden overscroll-contain"
        onEscapeKeyDown={(e) => {
          e.stopPropagation();
          if (exporting) {
            e.preventDefault();
          }
        }}
        onPointerDownOutside={(e) => {
          if (exporting) {
            e.preventDefault();
          }
        }}
        showCloseButton={!exporting}
        size="lg"
      >
        <DialogHeader>
          <DialogTitle>
            {t("exportPhotosTitle", { count: photoIds.length })}
          </DialogTitle>
        </DialogHeader>

        <div>
          <label
            className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider"
            htmlFor="export-format"
          >
            {t("exportFormat")}
          </label>
          <div className="flex gap-2">
            {(["original", "compressed"] as const).map((f) => (
              <button
                className={`flex-1 rounded-[6px] border px-3 py-2 text-[13px] transition-colors ${
                  format === f
                    ? "border-primary/50 bg-primary/10 text-primary"
                    : "border-input text-muted-foreground hover:border-muted-foreground"
                }`}
                disabled={exporting}
                key={f}
                onClick={() => setFormat(f)}
                type="button"
              >
                {f === "original" ? t("exportOriginal") : t("exportCompressed")}
              </button>
            ))}
          </div>
        </div>

        {format === "compressed" && (
          <>
            <div>
              <label
                className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider"
                htmlFor="export-quality"
              >
                {t("exportQuality", { quality })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                disabled={exporting}
                id="export-quality"
                max={100}
                min={10}
                onChange={(e) => setQuality(Number(e.target.value))}
                step={5}
                type="range"
                value={quality}
              />
            </div>
            <div>
              <label
                className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider"
                htmlFor="export-max-width"
              >
                {t("exportMaxWidth", { width: maxWidth })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                disabled={exporting}
                id="export-max-width"
                max={3840}
                min={640}
                onChange={(e) => setMaxWidth(Number(e.target.value))}
                step={160}
                type="range"
                value={maxWidth}
              />
            </div>
          </>
        )}

        <div className="flex min-w-0 items-center justify-between gap-3 text-[12px]">
          <span className="min-w-0">{t("exportOpenAfterExport")}</span>
          <Switch
            ariaLabel={t("exportOpenAfterExport")}
            checked={openAfterExport}
            disabled={exporting}
            onCheckedChange={setOpenAfterExport}
          />
        </div>

        {result && (
          <div
            className={`min-w-0 rounded-[6px] px-3 py-2 text-[12px] ${
              result.error
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success"
            }`}
          >
            {result.error ? (
              <span className="block [overflow-wrap:anywhere]">
                {result.error}
              </span>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span
                    className="block truncate"
                    // biome-ignore lint/a11y/noNoninteractiveTabindex: allow keyboard users to read the truncated export summary through Tooltip.
                    tabIndex={0}
                  >
                    {t("exportComplete", {
                      filename: result.filename,
                      count: result.photoCount,
                      size: result.sizeMB,
                    })}
                  </span>
                </TooltipTrigger>
                <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                  {t("exportComplete", {
                    filename: result.filename,
                    count: result.photoCount,
                    size: result.sizeMB,
                  })}
                </TooltipContent>
              </Tooltip>
            )}
          </div>
        )}

        {exporting && (
          <div>
            <div className="mb-1.5 text-[11px] text-muted-foreground">
              {t("exportProgress", { count: photoIds.length })}
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
              <div className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
            </div>
          </div>
        )}

        <DialogFooter className="flex-wrap">
          {result?.path && !result.error && (
            <button
              className="rounded-md border border-border px-4 py-1.5 text-[13px] hover:bg-muted"
              disabled={exporting}
              onClick={() => {
                if (result.path) {
                  openFolder(result.path);
                }
              }}
              type="button"
            >
              {t("exportOpenFolder")}
            </button>
          )}
          <button
            className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
            disabled={exporting}
            onClick={onClose}
            type="button"
          >
            {t("cancel")}
          </button>
          <AnimatedActionButton
            className="py-1.5"
            disabled={exporting}
            icon={
              exporting ? <LoadingSpinner size="sm" variant="inherit" /> : null
            }
            loading={exporting}
            onClick={handleExport}
          >
            {exporting
              ? t("exportProgress", { count: photoIds.length })
              : t("exportAction")}
          </AnimatedActionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
