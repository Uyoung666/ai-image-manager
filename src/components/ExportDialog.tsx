import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/ipc/manager";

interface ExportDialogProps {
  onClose: () => void;
  open: boolean;
  photoIds: number[];
}

export function ExportDialog({ open, onClose, photoIds }: ExportDialogProps) {
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
  const overlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setResult(null);
      setExporting(false);
    }
  }, [open]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open, onClose]);

  async function handleExport() {
    setExporting(true);
    try {
      const defaultName = `gallery-${new Date().toISOString().slice(0, 10)}.zip`;
      const dialogResult = await ipc.client.shell.saveFileDialog({
        defaultName,
        title: "导出照片画廊",
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
      });
      const data = res as { success: boolean; path?: string; filename?: string; photoCount?: number; sizeMB?: number; error?: string };
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
        setResult({ error: data.error || "导出失败" });
      }
    } catch {
      setResult({ error: "导出过程发生异常" });
    }
    setExporting(false);
  }

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current) onClose();
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      ref={overlayRef}
    >
      <div className="w-[400px] rounded-[12px] border border-border bg-popover ring-1 ring-white/5">
        <div className="flex items-center justify-between border-border border-b px-5 py-4">
          <h2 className="font-[590] text-[16px] text-foreground">
            导出 {photoIds.length} 张照片
          </h2>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {/* Format */}
          <div>
            <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
              导出格式
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
                >
                  {f === "original" ? "原图" : "压缩"}
                </button>
              ))}
            </div>
          </div>

          {/* Compressed options */}
          {format === "compressed" && (
            <>
              <div>
                <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                  图片质量: {quality}%
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
                <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                  最大宽度: {maxWidth}px
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

          {/* Result */}
          {result && (
            <div
              className={`rounded-[6px] px-3 py-2 text-[12px] ${
                result.error
                  ? "bg-[#e5484d]/10 text-[#e5484d]"
                  : "bg-[#46a758]/10 text-[#46a758]"
              }`}
            >
              {result.error
                ? result.error
                : `导出完成: ${result.filename} (${result.photoCount} 张, ${result.sizeMB}MB)`}
            </div>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              onClick={onClose}
            >
              取消
            </button>
            <button
              className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
              disabled={exporting}
              onClick={handleExport}
            >
              {exporting && (
                <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}
              导出
            </button>
          </div>
          {exporting && (
            <div className="mt-4">
              <div className="mb-1.5 text-[11px] text-muted-foreground">
                正在导出 {photoIds.length} 张照片...
              </div>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full w-1/3 animate-[indeterminate_1.5s_ease-in-out_infinite] rounded-full bg-primary" />
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
