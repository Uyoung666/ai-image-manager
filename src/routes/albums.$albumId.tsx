import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { PhotoGrid } from "@/components/PhotoGrid";
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
  photos: PhotoInfo[];
}

function AlbumDetailPage() {
  const { albumId } = Route.useParams() as any as { albumId: string };
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

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

  const photos = album?.photos || [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div>
          <h1 className="font-[590] text-[24px] text-foreground tracking-tight">
            {album?.name || "加载中..."}
          </h1>
          {album?.description && (
            <p className="mt-0.5 text-[#6b6b75] text-[12px]">
              {album.description}
            </p>
          )}
          <p className="mt-0.5 text-[#6b6b75] text-[11px]">
            {photos.length} 张照片
          </p>
        </div>
        {selectedIds.size > 0 && (
          <button
            className="rounded-[6px] bg-[#e5484d] px-4 py-1.5 text-[13px] font-[510] text-white transition-opacity hover:opacity-90"
            onClick={handleRemoveSelected}
          >
            移除 {selectedIds.size} 张
          </button>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <PhotoGrid
          loading={loading}
          onContextMenu={() => {}}
          onDoubleClick={() => {}}
          onSelect={handleSelect}
          photos={photos}
          selectedIds={selectedIds}
        />
      </div>
    </div>
  );
}

export const Route = createFileRoute("/albums/$albumId" as any)({
  component: AlbumDetailPage,
});
