import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { ipc } from "@/ipc/manager";

interface PhotoInfo {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isIndexed: boolean;
  path: string;
  thumbnailPath: string | null;
  width: number;
}

interface AlbumDetail {
  id: number;
  name: string;
  description: string | null;
  coverPhotoId: number | null;
  isSmart?: boolean;
  matchCount?: number;
  photos: PhotoInfo[];
}

function AlbumDetailPage() {
  const { albumId } = Route.useParams() as { albumId: string };
  const navigate = useNavigate();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);

  const loadAlbum = useCallback(async () => {
    try {
      const result = await ipc.client.albums.getAlbum({
        id: Number(albumId),
      });
      setAlbum(result as unknown as AlbumDetail);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, [albumId]);

  useEffect(() => {
    loadAlbum();
  }, [loadAlbum]);

  function handleSelect(id: number, _event: React.MouseEvent) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRemoveSelected() {
    if (!album) return;
    const ids = Array.from(selectedIds);
    await ipc.client.albums.removePhotosFromAlbum({
      albumId: album.id,
      photoIds: ids,
    });
    setAlbum((prev) =>
      prev
        ? { ...prev, photos: prev.photos.filter((p) => !selectedIds.has(p.id)) }
        : prev
    );
    setSelectedIds(new Set());
  }

  async function handleDeleteAlbum() {
    if (!album) return;
    await ipc.client.albums.deleteAlbum({ id: album.id });
    navigate({ to: "/albums" as "/albums" });
  }

  function handleDoubleClick(id: number) {
    const idx = photos.findIndex((p) => p.id === id);
    if (idx >= 0) setLightboxIndex(idx);
  }

  const photos = album?.photos || [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/albums" as "/albums" })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="font-[590] text-[24px] text-foreground tracking-tight">
                {album?.name || "加载中..."}
              </h1>
              {album?.isSmart && (
                <span className="flex items-center gap-1 rounded-[4px] bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  智能
                </span>
              )}
            </div>
            {album?.description && (
              <p className="mt-0.5 text-[#6b6b75] text-[12px]">
                {album.description}
              </p>
            )}
            <p className="mt-0.5 text-[#6b6b75] text-[11px]">
              {album?.isSmart
                ? `智能匹配 ${album?.matchCount ?? photos.length} 张照片`
                : `${photos.length} 张照片`}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && !album?.isSmart && (
            <button
              className="rounded-[6px] bg-[#e5484d] px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90"
              onClick={handleRemoveSelected}
            >
              移除 {selectedIds.size} 张
            </button>
          )}
          {album && !confirmDelete && (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-[#e5484d]/30 px-3 py-1.5 text-[12px] text-[#e5484d] transition-colors hover:border-[#e5484d] hover:bg-[#e5484d]/5"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              删除相册
            </button>
          )}
          {confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-[#e5484d]">确认删除？</span>
              <button
                className="rounded-[6px] bg-[#e5484d] px-3 py-1 text-[12px] text-white hover:opacity-90"
                onClick={handleDeleteAlbum}
              >
                确认
              </button>
              <button
                className="rounded-[6px] border border-input px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setConfirmDelete(false)}
              >
                取消
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <PhotoGrid
          loading={loading}
          onContextMenu={() => {}}
          onDoubleClick={handleDoubleClick}
          onSelect={handleSelect}
          photos={photos}
          selectedIds={selectedIds}
        />
      </div>
      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          open={lightboxIndex >= 0}
          photos={photos}
        />
      )}
    </div>
  );
}

export const Route = createFileRoute("/albums/$albumId" as "/albums/$albumId")({
  component: AlbumDetailPage,
});
