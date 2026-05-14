import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, RotateCcw, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { ipc } from "@/ipc/manager";

function toLocalMediaUrl(filePath: string | null | undefined): string {
  if (!filePath) return "";
  const encoded = filePath
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `local-media://${encoded}`;
}

interface DeletedPhoto {
  id: number;
  filename: string;
  path: string;
  thumbnailPath: string | null;
  deletedAt: number | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
}

function TrashPage() {
  const navigate = useNavigate();
  const [photos, setPhotos] = useState<DeletedPhoto[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [restoring, setRestoring] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const loadPhotos = useCallback(async () => {
    try {
      const result = await ipc.client.photos.listDeletedPhotos();
      setPhotos(result as DeletedPhoto[]);
    } catch {
      toast.error("加载已删除照片失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPhotos();
  }, [loadPhotos]);

  function toggleSelect(id: number, e: React.MouseEvent) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && prev.size > 0) {
        const ids = photos.map((p) => p.id);
        const lastSelected = [...prev].pop()!;
        const lastIdx = ids.indexOf(lastSelected);
        const curIdx = ids.indexOf(id);
        const [start, end] = lastIdx < curIdx ? [lastIdx, curIdx] : [curIdx, lastIdx];
        for (let i = start; i <= end; i++) {
          next.add(ids[i]);
        }
      } else if (e.ctrlKey || e.metaKey) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      } else {
        next.clear();
        next.add(id);
      }
      return next;
    });
  }

  function selectAll() {
    if (selectedIds.size === photos.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(photos.map((p) => p.id)));
    }
  }

  async function handleRestore() {
    if (selectedIds.size === 0) return;
    setRestoring(true);
    try {
      await ipc.client.photos.restorePhotos({ ids: [...selectedIds] });
      toast.success(`已恢复 ${selectedIds.size} 张照片`);
      setSelectedIds(new Set());
      loadPhotos();
    } catch {
      toast.error("恢复失败");
    } finally {
      setRestoring(false);
    }
  }

  async function handlePermanentDelete() {
    if (selectedIds.size === 0) return;
    if (!confirm(`确定永久删除 ${selectedIds.size} 张照片？此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      await ipc.client.photos.permanentlyDeletePhotos({ ids: [...selectedIds] });
      toast.success(`已永久删除 ${selectedIds.size} 张照片`);
      setSelectedIds(new Set());
      loadPhotos();
    } catch {
      toast.error("删除失败");
    } finally {
      setDeleting(false);
    }
  }

  async function handleEmptyTrash() {
    if (photos.length === 0) return;
    if (!confirm(`确定清空回收站？将永久删除 ${photos.length} 张照片，此操作不可恢复。`)) return;
    setDeleting(true);
    try {
      await ipc.client.photos.emptyTrash();
      toast.success("回收站已清空");
      setSelectedIds(new Set());
      setPhotos([]);
    } catch {
      toast.error("清空失败");
    } finally {
      setDeleting(false);
    }
  }

  function formatTimeAgo(ts: number | null): string {
    if (!ts) return "";
    const diff = Date.now() - ts;
    const days = Math.floor(diff / (1000 * 60 * 60 * 24));
    if (days === 0) return "今天";
    if (days === 1) return "昨天";
    if (days < 7) return `${days} 天前`;
    if (days < 30) return `${Math.floor(days / 7)} 周前`;
    return `${Math.floor(days / 30)} 个月前`;
  }

  function daysRemaining(ts: number | null): number {
    if (!ts) return 0;
    return Math.max(0, 30 - Math.floor((Date.now() - ts) / (1000 * 60 * 60 * 24)));
  }

  return (
    <div className="flex h-full flex-col bg-background">
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/" })}
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <div>
            <h1 className="font-[590] text-[16px] text-foreground">最近删除</h1>
            <p className="text-[12px] text-muted-foreground">
              {photos.length > 0
                ? `${photos.length} 张照片 · 30 天后自动永久删除`
                : "没有已删除的照片"}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && (
            <>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-primary/10 px-3 py-1.5 text-[13px] text-primary transition-colors hover:bg-primary/20 disabled:opacity-50"
                disabled={restoring}
                onClick={handleRestore}
              >
                <RotateCcw className="h-3.5 w-3.5" />
                恢复 ({selectedIds.size})
              </button>
              <button
                className="flex items-center gap-1.5 rounded-[6px] bg-[#e5484d]/10 px-3 py-1.5 text-[13px] text-[#e5484d] transition-colors hover:bg-[#e5484d]/20 disabled:opacity-50"
                disabled={deleting}
                onClick={handlePermanentDelete}
              >
                <Trash2 className="h-3.5 w-3.5" />
                永久删除
              </button>
            </>
          )}
          {photos.length > 0 && (
            <button
              className="rounded-[6px] px-3 py-1.5 text-[13px] text-[#e5484d] transition-colors hover:bg-[#e5484d]/10 disabled:opacity-50"
              disabled={deleting}
              onClick={handleEmptyTrash}
            >
              清空回收站
            </button>
          )}
        </div>
      </div>

      {/* Selection bar */}
      {photos.length > 0 && (
        <div className="flex items-center gap-3 border-border border-b px-6 py-2">
          <button
            className="text-[12px] text-muted-foreground hover:text-foreground"
            onClick={selectAll}
          >
            {selectedIds.size === photos.length ? "取消全选" : "全选"}
          </button>
          {selectedIds.size > 0 && (
            <span className="text-[12px] text-muted-foreground">
              已选择 {selectedIds.size} 张
            </span>
          )}
        </div>
      )}

      {/* Photo grid */}
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <p className="text-[14px] text-muted-foreground">加载中...</p>
          </div>
        ) : photos.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3">
            <Trash2 className="h-12 w-12 text-muted-foreground/30" />
            <p className="text-[14px] text-muted-foreground">回收站为空</p>
            <p className="text-[12px] text-muted-foreground/60">
              删除的照片会在这里保留 30 天
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3">
            {photos.map((photo) => (
              <div
                className={`group relative cursor-pointer overflow-hidden rounded-[8px] border transition-all ${
                  selectedIds.has(photo.id)
                    ? "border-primary ring-2 ring-primary/30"
                    : "border-border hover:border-foreground/20"
                }`}
                key={photo.id}
                onClick={(e) => toggleSelect(photo.id, e)}
              >
                <div className="aspect-square bg-card">
                  {photo.thumbnailPath ? (
                    <img
                      alt={photo.filename}
                      className="h-full w-full object-cover opacity-60"
                      loading="lazy"
                      src={toLocalMediaUrl(photo.thumbnailPath)}
                    />
                  ) : (
                    <div className="flex h-full w-full items-center justify-center text-muted-foreground/30">
                      <Trash2 className="h-8 w-8" />
                    </div>
                  )}
                </div>
                <div className="p-2">
                  <p className="truncate text-[11px] text-foreground">
                    {photo.filename}
                  </p>
                  <div className="mt-0.5 flex items-center justify-between">
                    <span className="text-[10px] text-muted-foreground">
                      {formatTimeAgo(photo.deletedAt)}
                    </span>
                    <span className="text-[10px] text-[#e5484d]/70">
                      {daysRemaining(photo.deletedAt)} 天后删除
                    </span>
                  </div>
                </div>
                {/* Selection indicator */}
                <div
                  className={`absolute top-2 left-2 flex h-5 w-5 items-center justify-center rounded-full border-2 transition-all ${
                    selectedIds.has(photo.id)
                      ? "border-primary bg-primary text-white"
                      : "border-white/60 bg-black/30 opacity-0 group-hover:opacity-100"
                  }`}
                >
                  {selectedIds.has(photo.id) && (
                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path d="M5 13l4 4L19 7" strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} />
                    </svg>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/trash")({
  component: TrashPage,
});
