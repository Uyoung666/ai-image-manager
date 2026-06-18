import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ipc } from "@/ipc/manager";
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
      setResult(null);
      setExporting(false);
    }
  }, [open]);

  async function handleExport() {
    setExporting(true);
    try {
      const defaultName = `gallery-${new Date().toISOString().slice(0, 10)}.zip`;
      const dialogResult = await ipc.client.shell.saveFileDialog({
        defaultName,
        title: t("exportGalleryTitle"),
      });
      const savePath = (dialogResult as any)?.path;
      if (!savePath) {
        setExporting(false);
        return;
      }
      const res = await ipc.client.photos.exportPhotos({
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
        setResult({
          path: data.path ?? "",
          filename: data.filename ?? "",
          photoCount: data.photoCount ?? 0,
          sizeMB: data.sizeMB ?? 0,
        });
        if (data.path) {
          await ipc.client.shell.openInExplorer({ path: data.path });
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
        onEscapeKeyDown={(e) => {
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
          <label className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
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
              <label className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("exportQuality", { quality })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
                max={100}
                min={10}
                onChange={(e) => setQuality(Number(e.target.value))}
                step={5}
                type="range"
                value={quality}
              />
            </div>
            <div>
              <label className="mb-1.5 block font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                {t("exportMaxWidth", { width: maxWidth })}
              </label>
              <input
                className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-muted accent-primary"
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

        {result && (
          <div
            className={`rounded-[6px] px-3 py-2 text-[12px] ${
              result.error
                ? "bg-destructive/10 text-destructive"
                : "bg-success/10 text-success"
            }`}
          >
            {result.error
              ? result.error
              : t("exportComplete", {
                  filename: result.filename,
                  count: result.photoCount,
                  size: result.sizeMB,
                })}
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

        <DialogFooter>
          <button
            className="rounded-md border border-border px-4 py-1.5 font-medium text-[13px] text-muted-foreground transition-colors hover:bg-foreground/5 disabled:opacity-40"
            disabled={exporting}
            onClick={onClose}
            type="button"
          >
            {t("cancel")}
          </button>
          <button
            className="flex items-center gap-1.5 rounded-md bg-primary px-4 py-1.5 font-medium text-[13px] text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-40"
            disabled={exporting}
            onClick={handleExport}
            type="button"
          >
            {exporting && (
              <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" />
            )}
            {t("exportAction")}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
