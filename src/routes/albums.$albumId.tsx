import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";

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
  coverPhotoId: number | null;
  description: string | null;
  id: number;
  isSmart?: boolean;
  matchCount?: number;
  name: string;
  photos: PhotoInfo[];
}

function AlbumDetailPage() {
  const { t } = useTranslation();
  const { albumId } = Route.useParams() as { albumId: string };
  const navigate = useNavigate();
  const [album, setAlbum] = useState<AlbumDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const composingRef = useRef(false);

  const loadAlbum = useCallback(async () => {
    try {
      const result = await ipc.client.albums.getAlbum({
        id: Number(albumId),
      });
      setAlbum(result as unknown as AlbumDetail);
    } catch (err) {
      console.error("[loadAlbum] failed:", err);
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
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const [allFavorite, setAllFavorite] = useState(false);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<number[]>([]);

  async function handleFavoriteSelected() {
    const ids = Array.from(selectedIds);
    const nextFav = !allFavorite;
    try {
      await ipc.client.photos.toggleFavorite({ ids, favorite: nextFav });
    } catch (err) {
      console.error("[handleFavoriteSelected] failed:", err);
    }
    setAllFavorite(nextFav);
    queryClient.invalidateQueries({ queryKey: ["photos"] });
  }

  async function handleDeleteSelected() {
    setConfirmDeleteIds(Array.from(selectedIds));
  }

  async function performDelete() {
    try {
      await ipc.client.photos.deletePhotos({ ids: confirmDeleteIds });
      toast.success(t("deletedPhotosCount", { count: confirmDeleteIds.length }));
      setAlbum((prev) =>
        prev
          ? {
              ...prev,
              photos: prev.photos.filter((p) => !confirmDeleteIds.includes(p.id)),
            }
          : prev
      );
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setConfirmDeleteIds([]);
    }
  }

  async function handleRemoveSelected() {
    if (!album) {
      return;
    }
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
    if (!album) {
      return;
    }
    await ipc.client.albums.deleteAlbum({ id: album.id });
    navigate({ to: "/albums" as const });
  }

  async function handleSaveName() {
    if (!(album && nameInput.trim())) {
      return;
    }
    try {
      await ipc.client.albums.updateAlbum({
        id: album.id,
        name: nameInput.trim(),
      });
      setAlbum((prev) => (prev ? { ...prev, name: nameInput.trim() } : prev));
      setEditingName(false);
    } catch {
      toast.error(t("albumRenameFailed"));
    }
  }

  function handleDoubleClick(id: number) {
    const idx = photos.findIndex((p) => p.id === id);
    if (idx >= 0) {
      setLightboxIndex(idx);
    }
  }

  const photos = album?.photos || [];

  return (
    <div className="flex h-full flex-col bg-background">
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/albums" as const })}
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div>
            <div className="flex items-center gap-2">
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    className="h-8 rounded-[6px] border border-input bg-card px-3 font-[590] text-[16px] text-foreground outline-none focus:border-primary"
                    onChange={(e) => setNameInput(e.target.value)}
                    onCompositionEnd={(e) => {
                      composingRef.current = false;
                      setNameInput((e.target as HTMLInputElement).value);
                    }}
                    onCompositionStart={() => {
                      composingRef.current = true;
                    }}
                    onKeyDown={(e) => {
                      if (composingRef.current) {
                        return;
                      }
                      if (e.key === "Enter") {
                        handleSaveName();
                      }
                      if (e.key === "Escape") {
                        setEditingName(false);
                      }
                    }}
                    value={nameInput}
                  />
                  <button
                    className="rounded-[4px] px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10"
                    onClick={handleSaveName}
                    type="button"
                  >
                    {t("save")}
                  </button>
                </div>
              ) : (
                <h1
                  className="cursor-pointer font-[590] text-[24px] text-foreground tracking-tight hover:text-primary"
                  onClick={() => {
                    setNameInput(album?.name || "");
                    setEditingName(true);
                  }}
                >
                  {album?.name || t("loading")}
                </h1>
              )}
              {album?.isSmart && (
                <span className="flex items-center gap-1 rounded-[4px] bg-secondary px-1.5 py-0.5 text-[10px] text-muted-foreground">
                  <Zap className="h-2.5 w-2.5" />
                  {t("smartAlbumShort")}
                </span>
              )}
            </div>
            {album?.description && (
              <p className="mt-0.5 text-[12px] text-muted-foreground/70">
                {album.description}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {album?.isSmart
                ? t("smartMatchedPhotos", {
                    count: album?.matchCount ?? photos.length,
                  })
                : t("photosCount", { count: photos.length })}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {selectedIds.size > 0 && !album?.isSmart && (
            <button
              className="rounded-[6px] bg-destructive px-4 py-1.5 font-[510] text-[13px] text-white transition-opacity hover:opacity-90"
              onClick={handleRemoveSelected}
            >
              {t("removePhotosCount", { count: selectedIds.size })}
            </button>
          )}
          {album && !confirmDelete && (
            <button
              className="flex items-center gap-1.5 rounded-[6px] border border-destructive/30 px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive hover:bg-destructive/5"
              onClick={() => setConfirmDelete(true)}
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("deleteAlbum")}
            </button>
          )}
          {confirmDelete && (
            <div className="flex items-center gap-2">
              <span className="text-[12px] text-destructive">
                {t("confirmDeleteQuestion")}
              </span>
              <button
                className="rounded-[6px] bg-destructive px-3 py-1 text-[12px] text-white hover:opacity-90"
                onClick={handleDeleteAlbum}
              >
                {t("confirm")}
              </button>
              <button
                className="rounded-[6px] border border-input px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground"
                onClick={() => setConfirmDelete(false)}
              >
                {t("cancel")}
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

      <SelectionActionBar
        allFavorite={allFavorite}
        onClearSelection={() => setSelectedIds(new Set())}
        onDelete={handleDeleteSelected}
        onToggleFavorite={handleFavoriteSelected}
        selectedCount={selectedIds.size}
      />

      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          open={lightboxIndex >= 0}
          photos={photos}
        />
      )}

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("confirmDeleteDescription", { count: confirmDeleteIds.length })}
        destructive
        onCancel={() => setConfirmDeleteIds([])}
        onConfirm={performDelete}
        open={confirmDeleteIds.length > 0}
        title={t("confirmDeleteTitle")}
      />
    </div>
  );
}

export const Route = createFileRoute("/albums/$albumId" as const)({
  component: AlbumDetailPage,
});
