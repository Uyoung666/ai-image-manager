import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, Trash2, Zap } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { CloudUploadDialog } from "@/components/CloudUploadDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import type { SortField, SortOrder } from "@/components/PhotoGrid";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { QuickPreview } from "@/components/QuickPreview";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { ShareDialog } from "@/components/ShareDialog";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";

interface PhotoInfo {
  filename: string;
  fileSize: number;
  height: number;
  id: number;
  isFavorite?: boolean;
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

const GRID_SORT_FIELD_KEY = "album_grid_sort_field";
const GRID_SORT_ORDER_KEY = "album_grid_sort_order";

function loadSortField(): SortField {
  try {
    const raw = localStorage.getItem(GRID_SORT_FIELD_KEY);
    if (raw === "date" || raw === "name" || raw === "size") return raw;
  } catch { /* ignore */ }
  return "date";
}

function loadSortOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(GRID_SORT_ORDER_KEY);
    if (raw === "asc" || raw === "desc") return raw;
  } catch { /* ignore */ }
  return "desc";
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
  const [lastClickedIdx, setLastClickedIdx] = useState(-1);
  const [detailPhoto, setDetailPhoto] = useState<Photo | null>(null);
  const [detailDismissed, setDetailDismissed] = useState(false);
  const [quickPreviewIndex, setQuickPreviewIndex] = useState(-1);
  const [ctxMenu, setCtxMenu] = useState<MenuState>({
    open: false, x: 0, y: 0, photoId: null, photoPath: null,
  });
  const [sortField, setSortField] = useState<SortField>(loadSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(loadSortOrder);
  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [addToAlbumOpen, setAddToAlbumOpen] = useState(false);
  const [addToAlbumIds, setAddToAlbumIds] = useState<number[]>([]);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [exportIds, setExportIds] = useState<number[]>([]);
  const [cloudUploadOpen, setCloudUploadOpen] = useState(false);
  const [cloudUploadIds, setCloudUploadIds] = useState<number[]>([]);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [shareIds, setShareIds] = useState<number[]>([]);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);

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

  const photos = useMemo(() => {
    const raw = album?.photos || [];
    const sorted = [...raw];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.filename.localeCompare(b.filename);
      } else if (sortField === "size") {
        cmp = a.fileSize - b.fileSize;
      }
      if (cmp === 0) cmp = (a.id || 0) - (b.id || 0);
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [album?.photos, sortField, sortOrder]);

  const photosRef = useRef(photos);
  photosRef.current = photos;

  // Sync detailPhoto when single photo selected
  useEffect(() => {
    if (detailDismissed) return;
    if (selectedIds.size === 1) {
      const id = selectedIds.values().next().value as number;
      const p = photos.find((ph) => ph.id === id);
      if (p) setDetailPhoto(p as unknown as Photo);
    } else if (selectedIds.size === 0 && detailPhoto) {
      setDetailPhoto(null);
    }
  }, [selectedIds, photos, detailDismissed, detailPhoto]);

  const handleSelect = useCallback((id: number, event: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const idx = photosRef.current.findIndex((p) => p.id === id);
      if (event.shiftKey && lastClickedIdx >= 0 && idx >= 0) {
        const [from, to] = lastClickedIdx < idx ? [lastClickedIdx, idx] : [idx, lastClickedIdx];
        for (let i = from; i <= to; i++) next.add(photosRef.current[i].id);
      } else if (event.ctrlKey || event.metaKey) {
        next.has(id) ? next.delete(id) : next.add(id);
        if (idx >= 0) setLastClickedIdx(idx);
      } else {
        next.clear();
        next.add(id);
        if (idx >= 0) setLastClickedIdx(idx);
      }
      return next;
    });
  }, [lastClickedIdx]);

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

  const handleToggleFavorite = useCallback((id: number) => {
    const photo = photosRef.current.find((p) => p.id === id);
    if (!photo) return;
    const prevVal = !!photo.isFavorite;
    const newVal = !prevVal;
    ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal }).then(() => {
      setAlbum((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          photos: prev.photos.map((p) =>
            p.id === id ? { ...p, isFavorite: newVal } : p
          ),
        };
      });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      toast.success(newVal ? t("toastFavoriteAdded") : t("toastFavoriteRemoved"), {
        action: {
          label: t("toastUndo"),
          onClick: async () => {
            await ipc.client.photos.toggleFavorite({ ids: [id], favorite: prevVal });
            setAlbum((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                photos: prev.photos.map((p) =>
                  p.id === id ? { ...p, isFavorite: prevVal } : p
                ),
              };
            });
            queryClient.invalidateQueries({ queryKey: ["photos"] });
          },
        },
      });
    });
  }, []);

  async function handleDeleteSelected() {
    setConfirmDeleteIds(Array.from(selectedIds));
  }

  async function performDelete() {
    try {
      await ipc.client.photos.deletePhotos({ ids: confirmDeleteIds });
      toast.success(t("deletedPhotosCount", { count: confirmDeleteIds.length }));
      setAlbum((prev) =>
        prev
          ? { ...prev, photos: prev.photos.filter((p) => !confirmDeleteIds.includes(p.id)) }
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

  function handleDeletePhoto(id: number) {
    setPendingDeleteIds([id]);
    setDeleteConfirmOpen(true);
  }

  async function executeDelete() {
    const ids = pendingDeleteIds;
    setDeleteConfirmOpen(false);
    setPendingDeleteIds([]);
    try {
      await ipc.client.photos.deletePhotos({ ids });
      setAlbum((prev) =>
        prev ? { ...prev, photos: prev.photos.filter((p) => !ids.includes(p.id)) } : prev
      );
      setSelectedIds((prev) => {
        const n = new Set(prev);
        for (const id of ids) n.delete(id);
        return n;
      });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      toast.success(t("toastDeletedCount", { count: ids.length }));
    } catch {
      toast.error(t("toastDeleteFailed"));
    }
  }

  async function handleRemoveSelected() {
    if (!album) return;
    const ids = Array.from(selectedIds);
    await ipc.client.albums.removePhotosFromAlbum({
      albumId: album.id, photoIds: ids,
    });
    setAlbum((prev) =>
      prev ? { ...prev, photos: prev.photos.filter((p) => !selectedIds.has(p.id)) } : prev
    );
    setSelectedIds(new Set());
  }

  async function handleRemoveFromAlbum(id: number) {
    if (!album) return;
    await ipc.client.albums.removePhotosFromAlbum({
      albumId: album.id, photoIds: [id],
    });
    setAlbum((prev) =>
      prev ? { ...prev, photos: prev.photos.filter((p) => p.id !== id) } : prev
    );
    setSelectedIds((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
    toast.success(t("toastRemovedFromAlbum"));
  }

  async function handleDeleteAlbum() {
    if (!album) return;
    await ipc.client.albums.deleteAlbum({ id: album.id });
    navigate({ to: "/albums" as const });
  }

  async function handleSaveName() {
    if (!(album && nameInput.trim())) return;
    try {
      await ipc.client.albums.updateAlbum({ id: album.id, name: nameInput.trim() });
      setAlbum((prev) => (prev ? { ...prev, name: nameInput.trim() } : prev));
      setEditingName(false);
    } catch {
      toast.error(t("albumRenameFailed"));
    }
  }

  const handleDoubleClick = useCallback((id: number) => {
    const idx = photosRef.current.findIndex((p) => p.id === id);
    if (idx >= 0) setLightboxIndex(idx);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const card = (e.target as HTMLElement).closest("[data-photo-id]") as HTMLElement | null;
    if (!card) return;
    const id = Number.parseInt(card.dataset.photoId || "", 10);
    const path = card.dataset.photoPath || null;
    if (!id) return;
    e.preventDefault();
    setCtxMenu({ open: true, x: e.clientX, y: e.clientY, photoId: id, photoPath: path });
  }, []);

  async function handleOpenExplorer(filePath: string) {
    await ipc.client.shell.openInExplorer({ path: filePath });
  }

  function handleDetailNavigate(direction: "prev" | "next") {
    if (!detailPhoto) return;
    const currentIdx = photos.findIndex((p) => p.id === detailPhoto.id);
    if (currentIdx < 0) return;
    const nextIdx = direction === "prev" ? currentIdx - 1 : currentIdx + 1;
    if (nextIdx < 0 || nextIdx >= photos.length) return;
    const nextPhoto = photos[nextIdx];
    setSelectedIds(new Set([nextPhoto.id]));
    setLastClickedIdx(nextIdx);
    setDetailDismissed(false);
    setDetailPhoto(nextPhoto as unknown as Photo);
  }

  function handleAddToAlbum(id: number) {
    setAddToAlbumIds([id]);
    setAddToAlbumOpen(true);
  }

  function handleExportPhoto(id: number) {
    setExportIds([id]);
    setExportDialogOpen(true);
  }

  function handleExportSelected() {
    setExportIds(Array.from(selectedIds));
    setExportDialogOpen(true);
  }

  function handleUploadToCloud(id: number) {
    setCloudUploadIds([id]);
    setCloudUploadOpen(true);
  }

  function handleUploadSelectedToCloud() {
    setCloudUploadIds(Array.from(selectedIds));
    setCloudUploadOpen(true);
  }

  function handleShare(id: number) {
    setShareIds([id]);
    setShareDialogOpen(true);
  }

  function handleShareSelected() {
    setShareIds(Array.from(selectedIds));
    setShareDialogOpen(true);
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.renamePhotos({ ids, pattern });
      queryClient.invalidateQueries({ queryKey: ["photos"] });
      const r = result as { renamed: number; errors: number; results: Array<{ id: number; oldName: string; newName: string; error?: string }> };
      toast.success(r.errors > 0 ? t("toastRenamePartial", { count: r.renamed, errors: r.errors }) : t("toastRenameCount", { count: r.renamed }));
      loadAlbum();
      return r;
    } catch {
      toast.error(t("toastRenameFailed"));
      return { renamed: 0, errors: ids.length, results: [] };
    }
  }

  async function handleConvertSelected(options: { format: "jpg" | "png" | "webp" | "avif"; quality: number; maxWidth: number; outputDir: string }) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.convertPhotos({ ids, format: options.format, quality: options.quality, maxWidth: options.maxWidth || undefined, outputDir: options.outputDir });
      const r = result as { converted: number; outputDir: string };
      toast.success(t("toastConvertedCount", { count: r.converted }));
      return r;
    } catch {
      toast.error(t("toastConvertFailed"));
      return { converted: 0, outputDir: options.outputDir };
    }
  }

  // Keyboard shortcuts
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler functions are intentionally excluded
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        setSelectedIds(new Set(photos.map((p) => p.id)));
        return;
      }

      if (e.key === "Delete" && selectedIds.size > 0) {
        e.preventDefault();
        handleDeleteSelected();
        return;
      }

      if (e.key === "F2" && selectedIds.size > 0) {
        e.preventDefault();
        setRenameDialogOpen(true);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "E") {
        e.preventDefault();
        if (selectedIds.size > 0) handleExportSelected();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (selectedIds.size > 0) setConvertDialogOpen(true);
        return;
      }

      if (e.key === "Escape") {
        if (quickPreviewIndex >= 0) { setQuickPreviewIndex(-1); return; }
        if (renameDialogOpen) { setRenameDialogOpen(false); return; }
        if (convertDialogOpen) { setConvertDialogOpen(false); return; }
        if (selectedIds.size > 0) { setSelectedIds(new Set()); return; }
      }

      if (e.key === " " && selectedIds.size > 0 && quickPreviewIndex < 0) {
        e.preventDefault();
        const firstId = selectedIds.values().next().value as number;
        const idx = photos.findIndex((p) => p.id === firstId);
        if (idx >= 0) setQuickPreviewIndex(idx);
        return;
      }

      if (e.key === "f" && selectedIds.size > 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const ids = [...selectedIds];
        const allFav = ids.every((id) => photos.find((p) => p.id === id)?.isFavorite);
        const newVal = !allFav;
        ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
          setAlbum((prev) => {
            if (!prev) return prev;
            const idSet = new Set(ids);
            return {
              ...prev,
              photos: prev.photos.map((p) =>
                idSet.has(p.id) ? { ...p, isFavorite: newVal } : p
              ),
            };
          });
          queryClient.invalidateQueries({ queryKey: ["photos"] });
          toast.success(newVal ? t("toastFavoriteAddedCount", { count: ids.length }) : t("toastFavoriteRemoved"), {
            action: { label: t("toastUndo"), onClick: async () => { await ipc.client.photos.toggleFavorite({ ids, favorite: allFav }); queryClient.invalidateQueries({ queryKey: ["photos"] }); } },
          });
        });
        return;
      }

      if (e.key === "i" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (detailPhoto) {
          setDetailDismissed(true);
          setDetailPhoto(null);
          setSelectedIds(new Set());
        } else if (selectedIds.size === 1) {
          setDetailDismissed(false);
          const id = selectedIds.values().next().value as number;
          const p = photos.find((ph) => ph.id === id);
          if (p) setDetailPhoto(p as unknown as Photo);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [photos, selectedIds, renameDialogOpen, convertDialogOpen, quickPreviewIndex, detailPhoto]);

  const handleKeyboardSelect = useCallback(
    (id: number) => {
      setSelectedIds(new Set([id]));
      const idx = photosRef.current.findIndex((p) => p.id === id);
      if (idx >= 0) setLastClickedIdx(idx);
    },
    []
  );

  const marqueeJustCompleted = useRef(false);

  const handleMarqueeSelect = useCallback(
    (ids: Set<number>) => {
      if (ids.size > 0) {
        setSelectedIds(ids);
        marqueeJustCompleted.current = true;
      }
    },
    []
  );

  const handleSortChange = useCallback(
    (s: SortField, o: SortOrder) => {
      setSortField(s);
      setSortOrder(o);
      try { localStorage.setItem(GRID_SORT_FIELD_KEY, s); localStorage.setItem(GRID_SORT_ORDER_KEY, o); } catch { /* ignore */ }
    },
    []
  );

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
                    onCompositionEnd={(e) => { composingRef.current = false; setNameInput((e.target as HTMLInputElement).value); }}
                    onCompositionStart={() => { composingRef.current = true; }}
                    onKeyDown={(e) => {
                      if (composingRef.current) return;
                      if (e.key === "Enter") handleSaveName();
                      if (e.key === "Escape") setEditingName(false);
                    }}
                    value={nameInput}
                  />
                  <button className="rounded-[4px] px-2 py-0.5 text-[11px] text-primary hover:bg-primary/10" onClick={handleSaveName} type="button">
                    {t("save")}
                  </button>
                </div>
              ) : (
                <h1
                  className="cursor-pointer font-[590] text-[24px] text-foreground tracking-tight hover:text-primary"
                  onClick={() => { setNameInput(album?.name || ""); setEditingName(true); }}
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
              <p className="mt-0.5 text-[12px] text-muted-foreground/70">{album.description}</p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {album?.isSmart
                ? t("smartMatchedPhotos", { count: album?.matchCount ?? photos.length })
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
              <span className="text-[12px] text-destructive">{t("confirmDeleteQuestion")}</span>
              <button className="rounded-[6px] bg-destructive px-3 py-1 text-[12px] text-white hover:opacity-90" onClick={handleDeleteAlbum}>
                {t("confirm")}
              </button>
              <button className="rounded-[6px] border border-input px-3 py-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => setConfirmDelete(false)}>
                {t("cancel")}
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div
          className="relative flex min-w-0 flex-1"
          onClick={(e) => {
            const target = e.target as HTMLElement;
            if (target.closest("[data-masonry-scroll]") && !target.closest("[data-photo-id]")) {
              if (marqueeJustCompleted.current) {
                marqueeJustCompleted.current = false;
                return;
              }
              setSelectedIds(new Set());
            }
          }}
        >
          <PhotoGrid
            loading={loading}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
            onKeyboardSelect={handleKeyboardSelect}
            onMarqueeSelect={handleMarqueeSelect}
            onSelect={handleSelect}
            onSortChange={handleSortChange}
            onToggleFavorite={handleToggleFavorite}
            photos={photos as any}
            selectedIds={selectedIds}
            sort={sortField}
            sortOrder={sortOrder}
          />
          <SelectionActionBar
            allFavorite={
              selectedIds.size > 0 && [...selectedIds].every((id) => (photos as any[]).find((p) => p.id === id)?.isFavorite)
            }
            onAddToAlbum={() => { setAddToAlbumIds(Array.from(selectedIds)); setAddToAlbumOpen(true); }}
            onClearSelection={() => setSelectedIds(new Set())}
            onConvert={() => setConvertDialogOpen(true)}
            onDelete={handleDeleteSelected}
            onExport={handleExportSelected}
            onRename={() => setRenameDialogOpen(true)}
            onShare={handleShareSelected}
            onToggleFavorite={() => {
              const ids = [...selectedIds];
              const allFav = ids.every((id) => photos.find((p) => p.id === id)?.isFavorite);
              const newVal = !allFav;
              ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
                setAlbum((prev) => {
                  if (!prev) return prev;
                  const idSet = new Set(ids);
                  return {
                    ...prev,
                    photos: prev.photos.map((p) =>
                      idSet.has(p.id) ? { ...p, isFavorite: newVal } : p
                    ),
                  };
                });
                queryClient.invalidateQueries({ queryKey: ["photos"] });
                toast.success(newVal ? t("toastFavoriteAddedCount", { count: ids.length }) : t("toastFavoriteRemoved"), {
                  action: { label: t("toastUndo"), onClick: async () => { await ipc.client.photos.toggleFavorite({ ids, favorite: allFav }); queryClient.invalidateQueries({ queryKey: ["photos"] }); } },
                });
              });
            }}
            onUploadToCloud={handleUploadSelectedToCloud}
            onStartCull={async () => {
              const ids = Array.from(selectedIds);
              if (ids.length < 2) return;
              try {
                const session = (await ipc.client.cull.createSession({
                  name: `${t("cullTitle")} · ${ids.length} ${t("photos")}`,
                  mode: "duel", photoIds: ids,
                })) as { id: number };
                setSelectedIds(new Set());
                navigate({ to: "/cull/$sessionId", params: { sessionId: String(session.id) } });
              } catch { toast.error("Failed to create cull session"); }
            }}
            selectedCount={selectedIds.size}
          />
        </div>
        <PhotoDetailPanel
          onClose={() => { setDetailDismissed(true); setDetailPhoto(null); setSelectedIds(new Set()); }}
          onNavigate={handleDetailNavigate}
          onOpenExplorer={handleOpenExplorer}
          photo={detailPhoto}
        />
      </div>

      {lightboxIndex >= 0 && (
        <PhotoLightbox
          index={lightboxIndex}
          onClose={() => setLightboxIndex(-1)}
          open={lightboxIndex >= 0}
          photos={photos as any}
        />
      )}

      {quickPreviewIndex >= 0 && photos[quickPreviewIndex] && (
        <QuickPreview
          onClose={() => setQuickPreviewIndex(-1)}
          onNavigate={(dir) => {
            setQuickPreviewIndex((prev) => {
              const next = prev + dir;
              if (next < 0 || next >= photos.length) return prev;
              setSelectedIds(new Set([photos[next].id]));
              return next;
            });
          }}
          photo={photos[quickPreviewIndex] as any}
        />
      )}

      <PhotoContextMenu
        menu={ctxMenu}
        onAddToAlbum={handleAddToAlbum}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
        onRemoveFromAlbum={album?.isSmart ? undefined : handleRemoveFromAlbum}
        onShare={handleShare}
        onToggleFavorite={handleToggleFavorite}
        onUploadToCloud={handleUploadToCloud}
      />

      <AddToAlbumDialog
        open={addToAlbumOpen}
        onClose={() => { setAddToAlbumOpen(false); setAddToAlbumIds([]); }}
        photoIds={addToAlbumIds}
      />

      <ExportDialog
        open={exportDialogOpen}
        onClose={() => { setExportDialogOpen(false); setExportIds([]); }}
        photoIds={exportIds}
      />

      <BatchRenameDialog
        open={renameDialogOpen}
        onClose={() => { setRenameDialogOpen(false); setSelectedIds(new Set()); }}
        onRename={handleRenameSelected}
        photoCount={selectedIds.size}
        sampleFilename={photos[0]?.filename || ""}
      />

      <FormatConvertDialog
        open={convertDialogOpen}
        onClose={() => setConvertDialogOpen(false)}
        onConvert={handleConvertSelected}
        photoCount={selectedIds.size}
      />

      <CloudUploadDialog
        open={cloudUploadOpen}
        onClose={() => { setCloudUploadOpen(false); setCloudUploadIds([]); }}
        photoIds={cloudUploadIds}
      />

      <ShareDialog
        open={shareDialogOpen}
        onClose={() => { setShareDialogOpen(false); setShareIds([]); }}
        photoIds={shareIds}
      />

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("confirmDeleteDescription", { count: confirmDeleteIds.length })}
        destructive
        onCancel={() => setConfirmDeleteIds([])}
        onConfirm={performDelete}
        open={confirmDeleteIds.length > 0}
        title={t("confirmDeleteTitle")}
      />

      <ConfirmDeleteDialog
        open={deleteConfirmOpen}
        onCancel={() => { setDeleteConfirmOpen(false); setPendingDeleteIds([]); }}
        onConfirm={executeDelete}
        count={pendingDeleteIds.length}
      />
    </div>
  );
}

export const Route = createFileRoute("/albums/$albumId" as const)({
  component: AlbumDetailPage,
});
