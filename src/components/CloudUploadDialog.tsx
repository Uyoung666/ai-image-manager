import { Cloud, CloudUpload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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

export function CloudUploadDialog({ open, onClose, photoIds }: CloudUploadDialogProps) {
  const [configs, setConfigs] = useState<CloudConfig[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [uploading, setUploading] = useState(false);
  const [done, setDone] = useState(false);
  const overlayRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef(false);

  const loadConfigs = useCallback(async () => {
    try {
      const list = await ipc.client.cloud.listCloudConfigs({}) as CloudConfig[];
      setConfigs(list);
      if (list.length === 1) setSelectedId(list[0].id);
    } catch { /* ignore */ }
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

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape" && !uploading) onClose();
    }
    if (open) {
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open, onClose, uploading]);

  function handleOverlayClick(e: React.MouseEvent) {
    if (e.target === overlayRef.current && !uploading) onClose();
  }

  async function handleUpload() {
    if (!selectedId || uploading) return;
    setUploading(true);
    setProgress({ done: 0, fail: 0, total: photoIds.length });

    for (const photoId of photoIds) {
      if (abortRef.current) break;
      try {
        const res = await ipc.client.cloud.uploadPhotoToCloud({
          cloudConfigId: selectedId,
          photoId,
        }) as { success: boolean; error?: string };
        setProgress((p) => {
          if (!p) return p;
          return res.success
            ? { ...p, done: p.done + 1 }
            : { ...p, fail: p.fail + 1 };
        });
      } catch {
        setProgress((p) => p ? { ...p, fail: p.fail + 1 } : p);
      }
    }

    setUploading(false);
    setDone(true);
  }

  if (!open) return null;

  const pct = progress ? Math.round(((progress.done + progress.fail) / progress.total) * 100) : 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={handleOverlayClick}
      ref={overlayRef}
    >
      <div className="w-[400px] rounded-[12px] border border-border bg-popover ring-1 ring-foreground/5">
        <div className="flex items-center justify-between border-border border-b px-5 py-4">
          <h2 className="font-[590] text-[16px] text-foreground">
            上传到云端
          </h2>
          <button
            className="flex h-6 w-6 items-center justify-center rounded-[4px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
            disabled={uploading}
            onClick={onClose}
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 p-5">
          {configs.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-6 text-muted-foreground">
              <Cloud className="h-10 w-10 opacity-40" />
              <p className="text-[13px]">暂无云同步配置</p>
              <p className="text-[11px] opacity-70">请先在设置页面添加 WebDAV 或 S3 配置</p>
            </div>
          ) : (
            <>
              {/* Config selector */}
              <div>
                <label className="mb-1.5 block font-[510] text-[11px] text-muted-foreground uppercase tracking-wider">
                  目标存储
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
                    >
                      <span className="text-foreground">{cfg.name}</span>
                      <span className="ml-2 text-[11px] opacity-60">
                        {PROVIDER_LABELS[cfg.provider] || cfg.provider}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              {/* Progress */}
              {progress && (
                <div className="space-y-2">
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        done && progress.fail === 0
                          ? "bg-[#46a758]"
                          : progress.fail > 0
                            ? "bg-[#ffb224]"
                            : "bg-primary"
                      }`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    {done
                      ? progress.fail === 0
                        ? `完成 — 成功上传 ${progress.done} 张`
                        : `完成 — ${progress.done} 成功, ${progress.fail} 失败`
                      : `上传中... ${progress.done + progress.fail}/${progress.total}`}
                  </p>
                </div>
              )}

              {/* Uploading indicator */}
              {uploading && (
                <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                  <div className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                  正在上传，请勿关闭窗口
                </div>
              )}
            </>
          )}

          {/* Actions */}
          <div className="flex justify-end gap-2">
            <button
              className="rounded-[6px] border border-input px-4 py-1.5 text-[13px] text-muted-foreground transition-colors hover:border-muted-foreground hover:text-foreground"
              disabled={uploading}
              onClick={onClose}
            >
              {done && progress ? "关闭" : "取消"}
            </button>
            {configs.length > 0 && !done && (
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90 disabled:opacity-40"
                disabled={!selectedId || uploading}
                onClick={handleUpload}
              >
                <CloudUpload className="h-4 w-4" />
                上传 {photoIds.length} 张
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
