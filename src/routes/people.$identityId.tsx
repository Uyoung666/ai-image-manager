import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { ArrowLeft, UserMinus } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AddToAlbumDialog } from "@/components/AddToAlbumDialog";
import { BatchRenameDialog } from "@/components/BatchRenameDialog";
import { CloudUploadDialog } from "@/components/CloudUploadDialog";
import { ConfirmDeleteDialog } from "@/components/ConfirmDeleteDialog";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { CullStartDialog } from "@/components/CullStartDialog";
import { ExportDialog } from "@/components/ExportDialog";
import { FormatConvertDialog } from "@/components/FormatConvertDialog";
import type { MenuState } from "@/components/PhotoContextMenu";
import { PhotoContextMenu } from "@/components/PhotoContextMenu";
import { PhotoDetailPanel } from "@/components/PhotoDetailPanel";
import type { SortField, SortOrder } from "@/components/PhotoGrid";
import { PhotoGrid } from "@/components/PhotoGrid";
import { PhotoLightbox } from "@/components/PhotoLightbox";
import { QuickPreview } from "@/components/QuickPreview";
import { RouteError } from "@/components/RouteError";
import { SelectionActionBar } from "@/components/SelectionActionBar";
import { SequenceDetailPanel } from "@/components/SequenceDetailPanel";
import { ShareDialog } from "@/components/ShareDialog";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";
import { useCollectionSequences } from "@/hooks/useCollectionSequences";
import { useGlobalDropZone } from "@/hooks/useGlobalDropZone";
import { usePhotoDetailPanel } from "@/hooks/usePhotoDetailPanel";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { ipc } from "@/ipc/manager";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";

interface FaceInfo {
  bboxHeight: number;
  bboxWidth: number;
  bboxX: number;
  bboxY: number;
  id: number;
  photoId: number;
}

interface IdentityDetail {
  faceCount: number;
  faces: FaceInfo[];
  id: number;
  name: string | null;
  photos: Photo[];
}

const GRID_SORT_FIELD_KEY = "person_grid_sort_field";
const GRID_SORT_ORDER_KEY = "person_grid_sort_order";

function loadSortField(): SortField {
  try {
    const raw = localStorage.getItem(GRID_SORT_FIELD_KEY);
    if (raw === "date" || raw === "name" || raw === "size") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "date";
}

function loadSortOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(GRID_SORT_ORDER_KEY);
    if (raw === "asc" || raw === "desc") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "desc";
}

function PersonDetailPage() {
  const { t } = useTranslation();
  const { identityId } = Route.useParams() as { identityId: string };
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<IdentityDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const { markRouteDirty } = useScrollPosition();
  const { handleGlobalDragOver, handleGlobalDrop } = useGlobalDropZone();
  const routeKey = `person-${identityId}`;
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const composingRef = useRef(false);
  const [lightboxIndex, setLightboxIndex] = useState(-1);
  const [quickPreviewIndex, setQuickPreviewIndex] = useState(-1);
  const [ctxMenu, setCtxMenu] = useState<MenuState>({
    open: false,
    x: 0,
    y: 0,
    photoId: null,
    photoPath: null,
    isBatch: false,
    selectionCount: 0,
  });
  const [sortField, setSortField] = useState<SortField>(loadSortField);
  const [sortOrder, setSortOrder] = useState<SortOrder>(loadSortOrder);
  const [confirmRemovePhotoId, setConfirmRemovePhotoId] = useState<
    number | null
  >(null);
  const [confirmRemoveIds, setConfirmRemoveIds] = useState<number[]>([]);
  const [allFavorite, setAllFavorite] = useState(false);
  const [confirmDeleteIds, setConfirmDeleteIds] = useState<number[]>([]);
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
  const [cullPhotoIds, setCullPhotoIds] = useState<number[]>([]);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<number[]>([]);
  const [pendingDeleteSequenceGroup, setPendingDeleteSequenceGroup] =
    useState(false);

  const cancelledRef = useRef(false);

  const loadIdentity = useCallback(async () => {
    try {
      const result = await ipc.client.faces.getFaceIdentity({
        id: Number(identityId),
      });
      if (!cancelledRef.current) {
        const data = result as unknown as IdentityDetail;
        setIdentity(data);
        setNameInput(data.name || "");
        setLoading(false);
      }
    } catch (err) {
      if (!cancelledRef.current) {
        console.error("[loadIdentity] failed:", err);
        setLoading(false);
      }
    }
  }, [identityId]);

  useEffect(() => {
    cancelledRef.current = false;
    setLoading(true);
    loadIdentity();
    return () => {
      cancelledRef.current = true;
    };
  }, [loadIdentity]);

  const photos = useMemo(() => {
    const raw = identity?.photos || [];
    const sorted = [...raw];
    sorted.sort((a, b) => {
      let cmp = 0;
      if (sortField === "name") {
        cmp = a.filename.localeCompare(b.filename);
      } else if (sortField === "size") {
        cmp = a.fileSize - b.fileSize;
      }
      if (cmp === 0) {
        cmp = (a.id || 0) - (b.id || 0);
      }
      return sortOrder === "asc" ? cmp : -cmp;
    });
    return sorted;
  }, [identity?.photos, sortField, sortOrder]);

  const photosRef = useRef(photos);
  photosRef.current = photos;

  // 共享 Hooks：选中状态、详情面板
  const {
    selectedIds,
    handleSelect,
    handleSelectMany,
    addToSelection,
    handleKeyboardSelect,
    handleMarqueeSelect,
    clearSelection,
    removeFromSelection,
    selectAll: selectAllPhotos,
  } = usePhotoSelection(routeKey, photos);
  const sequenceView = useCollectionSequences({
    onClearSelection: clearSelection,
    onRemoveSelection: removeFromSelection,
    photos,
    storageKey: "person_sequence_view_mode",
  });
  const handleSequenceSelect = useCallback(
    (memberIds: number[], event: React.MouseEvent) => {
      sequenceView.setSelectedSequence(null);
      handleSelectMany(memberIds, event);
    },
    [handleSelectMany, sequenceView.setSelectedSequence]
  );
  const handleSelectSequenceMembers = useCallback(
    (memberIds: number[], selectAll: boolean) => {
      if (selectAll) {
        addToSelection(memberIds);
      } else {
        removeFromSelection(memberIds);
      }
    },
    [addToSelection, removeFromSelection]
  );
  const { detailPhoto, detailDismissed, dismissDetail, navigateDetail, showPhoto } =
    usePhotoDetailPanel(selectedIds, photos, routeKey, handleKeyboardSelect);

  const marqueeJustCompleted = useRef(false);
  const wrappedMarqueeSelect = useCallback(
    (ids: Set<number>) => {
      handleMarqueeSelect(ids);
      if (ids.size > 0) {
        marqueeJustCompleted.current = true;
      }
    },
    [handleMarqueeSelect]
  );

  // --- handlers ---

  // handleSelect, handleKeyboardSelect, handleMarqueeSelect 由 usePhotoSelection hook 提供

  const handleDoubleClick = useCallback((id: number) => {
    const idx = photosRef.current.findIndex((p) => p.id === id);
    if (idx >= 0) {
      clearSelection();
      dismissDetail();
      setLightboxIndex(idx);
    }
  }, [clearSelection, dismissDetail]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent) => {
      const card = (e.target as HTMLElement).closest(
        "[data-photo-id]"
      ) as HTMLElement | null;
      if (!card) {
        return;
      }
      const id = Number.parseInt(card.dataset.photoId || "", 10);
      const path = card.dataset.photoPath || null;
      const sequenceId = Number.parseInt(card.dataset.sequenceId || "", 10);
      if (!id) {
        return;
      }
      e.preventDefault();
      const inSelection = selectedIds.has(id);
      const isBatch = selectedIds.size > 1 && inSelection;
      const sequence = sequenceId
        ? sequenceView.sequences.find((item) => item.id === sequenceId)
        : undefined;
      const sequenceMemberIds =
        sequence?.matchedPhotoIds ?? sequence?.memberPhotoIds;
      setCtxMenu({
        open: true,
        x: e.clientX,
        y: e.clientY,
        photoId: id,
        photoPath: path,
        isBatch,
        selectionCount: isBatch ? selectedIds.size : 1,
        sequenceMemberIds,
      });
    },
    [selectedIds, sequenceView.sequences]
  );

  async function handleOpenExplorer(filePath: string) {
    await ipc.client.shell.openInExplorer({ path: filePath });
  }

  // handleDetailNavigate 由 usePhotoDetailPanel.navigateDetail 提供

  // Single-photo actions (triggered from context menu)
  const handleToggleFavorite = useCallback(
    async (id: number, requestedValue?: boolean) => {
      const photo = photosRef.current.find((p) => p.id === id);
      if (!photo) {
        return;
      }
      const prevVal = !!photo.isFavorite;
      const newVal = requestedValue ?? !prevVal;
      await ipc.client.photos.toggleFavorite({ ids: [id], favorite: newVal });
      setIdentity((prev) => {
        if (!prev) {
          return prev;
        }
        return {
          ...prev,
          photos: prev.photos.map((p) =>
            p.id === id ? { ...p, isFavorite: newVal } : p
          ),
        };
      });
      sequenceView.updateMemberFavorite(id, newVal);
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      toast.success(
        newVal ? t("toastFavoriteAdded") : t("toastFavoriteRemoved"),
        {
          action: {
            label: t("toastUndo"),
            onClick: async () => {
              await ipc.client.photos.toggleFavorite({
                ids: [id],
                favorite: prevVal,
              });
              setIdentity((prev) => {
                if (!prev) {
                  return prev;
                }
                return {
                  ...prev,
                  photos: prev.photos.map((p) =>
                    p.id === id ? { ...p, isFavorite: prevVal } : p
                  ),
                };
              });
              sequenceView.updateMemberFavorite(id, prevVal);
              queryClient.invalidateQueries({
                queryKey: ["photos"],
                refetchType: "active",
              });
            },
          },
        }
      );
    },
    []
  );

  function handleDeletePhoto(id: number) {
    setPendingDeleteSequenceGroup(false);
    setPendingDeleteIds([id]);
    setDeleteConfirmOpen(true);
  }

  function handleAddToAlbum(id: number) {
    setAddToAlbumIds([id]);
    setAddToAlbumOpen(true);
  }

  function handleExportPhoto(id: number) {
    setExportIds([id]);
    setExportDialogOpen(true);
  }

  function handleUploadToCloud(id: number) {
    setCloudUploadIds([id]);
    setCloudUploadOpen(true);
  }

  function handleShare(id: number) {
    setShareIds([id]);
    setShareDialogOpen(true);
  }

  async function handleSetAsPersonCover(id: number) {
    if (!identity) {
      return;
    }
    try {
      await ipc.client.faces.updateFaceIdentity({
        id: identity.id,
        representativePhotoId: id,
      });
      toast.success(t("setAsPersonCover"));
      queryClient.invalidateQueries({ queryKey: ["faces", "identities"] });
    } catch {
      // ignore
    }
  }

  // Batch actions
  function handleExportSelected() {
    setExportIds(Array.from(selectedIds));
    setExportDialogOpen(true);
  }

  function handleUploadSelectedToCloud() {
    setCloudUploadIds(Array.from(selectedIds));
    setCloudUploadOpen(true);
  }

  function handleShareSelected() {
    setShareIds(Array.from(selectedIds));
    setShareDialogOpen(true);
  }

  // Remove photo(s) from person identity
  function handleRemoveFace(photoId: number) {
    if (!identity) {
      return;
    }
    const face = identity.faces.find((f) => f.photoId === photoId);
    if (!face) {
      return;
    }
    setConfirmRemovePhotoId(photoId);
  }

  function handleRemoveSelected() {
    setConfirmRemoveIds(Array.from(selectedIds));
  }

  async function performRemoveSelected() {
    if (!(identity && confirmRemoveIds.length > 0)) {
      return;
    }
    const ids = confirmRemoveIds;
    setConfirmRemoveIds([]);
    try {
      for (const photoId of ids) {
        const face = identity.faces.find((f) => f.photoId === photoId);
        if (face) {
          const result = (await ipc.client.faces.removeFaceFromIdentity({
            identityId: identity.id,
            faceVectorId: face.id,
          })) as { ok: boolean; remainingCount: number };
          if (result.remainingCount === 0) {
            navigate({ to: "/people" as const });
            return;
          }
        }
      }
      clearSelection();
      loadIdentity();
    } catch {
      toast.error(t("removeFaceFailed"));
    }
  }

  async function performRemoveFace() {
    if (!(identity && confirmRemovePhotoId !== null)) {
      return;
    }
    const face = identity.faces.find((f) => f.photoId === confirmRemovePhotoId);
    setConfirmRemovePhotoId(null);
    if (!face) {
      return;
    }
    try {
      const result = (await ipc.client.faces.removeFaceFromIdentity({
        identityId: identity.id,
        faceVectorId: face.id,
      })) as { ok: boolean; remainingCount: number };
      if (result.remainingCount === 0) {
        navigate({ to: "/people" as const });
      } else {
        loadIdentity();
      }
    } catch {
      toast.error(t("removeFaceFailed"));
    }
  }

  async function handleFavoriteSelected() {
    const ids = Array.from(selectedIds);
    const nextFav = !allFavorite;
    try {
      await ipc.client.photos.toggleFavorite({ ids, favorite: nextFav });
    } catch (err) {
      console.error("[handleFavoriteSelected] failed:", err);
    }
    setAllFavorite(nextFav);
    queryClient.invalidateQueries({
      queryKey: ["photos"],
      refetchType: "active",
    });
  }

  function handleDeleteSelected() {
    setConfirmDeleteIds(Array.from(selectedIds));
  }

  async function performDelete() {
    try {
      await ipc.client.photos.deletePhotos({ ids: confirmDeleteIds });
      markRouteDirty(routeKey);
      removeFromSelection(confirmDeleteIds);
      toast.success(
        t("deletedPhotosCount", { count: confirmDeleteIds.length })
      );
      setIdentity((prev) =>
        prev
          ? {
              ...prev,
              photos: prev.photos.filter(
                (p) => !confirmDeleteIds.includes(p.id)
              ),
            }
          : prev
      );
      clearSelection();
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    } catch {
      toast.error(t("deleteFailed"));
    } finally {
      setConfirmDeleteIds([]);
    }
  }

  async function executeDelete() {
    const ids = pendingDeleteIds;
    setDeleteConfirmOpen(false);
    setPendingDeleteIds([]);
    setPendingDeleteSequenceGroup(false);
    try {
      await ipc.client.photos.deletePhotos({ ids });
      markRouteDirty(routeKey);
      removeFromSelection(ids);
      setIdentity((prev) =>
        prev
          ? { ...prev, photos: prev.photos.filter((p) => !ids.includes(p.id)) }
          : prev
      );
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      toast.success(t("toastDeletedCount", { count: ids.length }));
    } catch {
      toast.error(t("toastDeleteFailed"));
    }
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.renamePhotos({ ids, pattern });
      queryClient.invalidateQueries({
        queryKey: ["photos"],
        refetchType: "active",
      });
      const r = result as {
        renamed: number;
        errors: number;
        results: Array<{
          id: number;
          oldName: string;
          newName: string;
          error?: string;
        }>;
      };
      toast.success(
        r.errors > 0
          ? t("toastRenamePartial", { count: r.renamed, errors: r.errors })
          : t("toastRenameCount", { count: r.renamed })
      );
      loadIdentity();
      return r;
    } catch {
      toast.error(t("toastRenameFailed"));
      return { renamed: 0, errors: ids.length, results: [] };
    }
  }

  async function handleConvertSelected(options: {
    format: "jpg" | "png" | "webp" | "avif";
    quality: number;
    maxWidth: number;
    outputDir: string;
  }) {
    const ids = Array.from(selectedIds);
    try {
      const result = await ipc.client.photos.convertPhotos({
        ids,
        format: options.format,
        quality: options.quality,
        maxWidth: options.maxWidth || undefined,
        outputDir: options.outputDir,
      });
      const r = result as { converted: number; outputDir: string };
      toast.success(t("toastConvertedCount", { count: r.converted }));
      return r;
    } catch {
      toast.error(t("toastConvertFailed"));
      return { converted: 0, outputDir: options.outputDir };
    }
  }

  async function handleSaveName() {
    if (!(identity && nameInput.trim())) {
      return;
    }
    try {
      await ipc.client.faces.updateFaceIdentity({
        id: identity.id,
        name: nameInput.trim(),
      });
      setIdentity((prev) =>
        prev ? { ...prev, name: nameInput.trim() } : prev
      );
      setEditingName(false);
    } catch {
      toast.error(t("personRenameFailed"));
    }
  }

  // Keyboard shortcuts
  // biome-ignore lint/correctness/useExhaustiveDependencies: handler functions are intentionally excluded
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === "a") {
        e.preventDefault();
        selectAllPhotos();
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
        if (selectedIds.size > 0) {
          handleExportSelected();
        }
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === "C") {
        e.preventDefault();
        if (selectedIds.size > 0) {
          setConvertDialogOpen(true);
        }
        return;
      }

      if (e.key === "Escape") {
        if (quickPreviewIndex >= 0) {
          setQuickPreviewIndex(-1);
          return;
        }
        if (renameDialogOpen) {
          setRenameDialogOpen(false);
          return;
        }
        if (convertDialogOpen) {
          setConvertDialogOpen(false);
          return;
        }
        if (selectedIds.size > 0) {
          clearSelection();
          return;
        }
      }

      if (e.key === " " && selectedIds.size > 0 && quickPreviewIndex < 0) {
        e.preventDefault();
        const firstId = selectedIds.values().next().value as number;
        const idx = photos.findIndex((p) => p.id === firstId);
        if (idx >= 0) {
          setQuickPreviewIndex(idx);
        }
        return;
      }

      if (e.key === "f" && selectedIds.size > 0 && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const ids = [...selectedIds];
        const allFav = ids.every(
          (id) => photos.find((p) => p.id === id)?.isFavorite
        );
        const newVal = !allFav;
        ipc.client.photos.toggleFavorite({ ids, favorite: newVal }).then(() => {
          setIdentity((prev) => {
            if (!prev) {
              return prev;
            }
            const idSet = new Set(ids);
            return {
              ...prev,
              photos: prev.photos.map((p) =>
                idSet.has(p.id) ? { ...p, isFavorite: newVal } : p
              ),
            };
          });
          for (const favId of ids) {
            sequenceView.updateMemberFavorite(favId, newVal);
          }
          queryClient.invalidateQueries({
            queryKey: ["photos"],
            refetchType: "active",
          });
          toast.success(
            newVal
              ? t("toastFavoriteAddedCount", { count: ids.length })
              : t("toastFavoriteRemoved"),
            {
              action: {
                label: t("toastUndo"),
                onClick: async () => {
                  await ipc.client.photos.toggleFavorite({
                    ids,
                    favorite: allFav,
                  });
                  queryClient.invalidateQueries({
                    queryKey: ["photos"],
                    refetchType: "active",
                  });
                },
              },
            }
          );
        });
        return;
      }

      if (e.key === "i" && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (detailPhoto) {
          dismissDetail();
          clearSelection();
        } else if (selectedIds.size === 1) {
          const id = selectedIds.values().next().value as number;
          handleKeyboardSelect(id);
        }
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [
    photos,
    selectedIds,
    renameDialogOpen,
    convertDialogOpen,
    quickPreviewIndex,
    detailPhoto,
  ]);

  // handleKeyboardSelect, handleMarqueeSelect 由 usePhotoSelection hook 提供

  const handleSortChange = useCallback((s: SortField, o: SortOrder) => {
    setSortField(s);
    setSortOrder(o);
    try {
      localStorage.setItem(GRID_SORT_FIELD_KEY, s);
      localStorage.setItem(GRID_SORT_ORDER_KEY, o);
    } catch {
      /* ignore */
    }
  }, []);

  return (
    <div
      className="flex h-full flex-col bg-background"
      onDragOver={handleGlobalDragOver}
      onDrop={handleGlobalDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-border border-b px-6 py-4">
        <div className="flex items-center gap-3">
          <button
            className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
            onClick={() => navigate({ to: "/people" as const })}
            type="button"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
            <span className="font-semibold text-[18px] text-muted-foreground">
              {(identity?.name || "?")[0]}
            </span>
          </div>
          <div>
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  autoFocus
                  className="h-8 rounded-[6px] border border-input bg-card px-3 font-semibold text-[16px] text-foreground outline-none focus:border-primary"
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
                className="cursor-pointer font-semibold text-[20px] text-foreground tracking-tight hover:text-primary"
                onClick={() => setEditingName(true)}
              >
                {identity?.name || t("unnamedPerson")}
              </h1>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground/70">
              {t("detectedPersonPhotos", { count: photos.length })}
            </p>
          </div>
        </div>
        {/* Batch remove from person button */}
        {selectedIds.size > 0 && (
          <button
            className="flex items-center gap-1.5 rounded-[6px] border border-destructive/30 px-3 py-1.5 text-[12px] text-destructive transition-colors hover:border-destructive hover:bg-destructive/5"
            onClick={handleRemoveSelected}
          >
            <UserMinus className="h-3.5 w-3.5" />
            {t("removeFromPerson")} ({selectedIds.size})
          </button>
        )}
      </div>

      {/* Content area */}
      <div className="flex min-h-0 flex-1">
        <div className="relative flex min-w-0 flex-1">
          <PhotoGrid
            expandedSequence={sequenceView.expandedSequence}
            expandedSequenceComplete={sequenceView.expandedSequenceComplete}
            expandingSequenceId={sequenceView.expandingSequenceId}
            isPlaceholderData={loading}
            loading={loading}
            onBackgroundClick={() => {
              if (marqueeJustCompleted.current) {
                marqueeJustCompleted.current = false;
                return;
              }
              clearSelection();
            }}
            onContextMenu={handleContextMenu}
            onDoubleClick={handleDoubleClick}
            onKeyboardSelect={handleKeyboardSelect}
            onMarqueeSelect={wrappedMarqueeSelect}
            onOpenSequence={sequenceView.openPlayback}
            onOpenSequenceDetails={sequenceView.openDetails}
            onSelect={handleSelect}
            onSelectSequence={handleSequenceSelect}
            onSelectSequenceMembers={handleSelectSequenceMembers}
            onSequenceMutationComplete={sequenceView.refreshSequences}
            onSequenceModeChange={sequenceView.setMode}
            onSortChange={handleSortChange}
            onToggleFavorite={handleToggleFavorite}
            onToggleSequenceExpand={sequenceView.toggleExpand}
            photos={photos as any}
            routeKey={routeKey}
            selectedIds={selectedIds}
            sequenceMode={sequenceView.mode}
            sequences={sequenceView.sequences}
            sort={sortField}
            sortOrder={sortOrder}
          />
          <SelectionActionBar
            allFavorite={
              selectedIds.size > 0 &&
              [...selectedIds].every(
                (id) => photos.find((p) => p.id === id)?.isFavorite
              )
            }
            onAddToAlbum={() => {
              setAddToAlbumIds(Array.from(selectedIds));
              setAddToAlbumOpen(true);
            }}
            onClearSelection={clearSelection}
            onConvert={() => setConvertDialogOpen(true)}
            onDelete={handleDeleteSelected}
            onExport={handleExportSelected}
            onRename={() => setRenameDialogOpen(true)}
            onShare={handleShareSelected}
            onStartCull={() => {
              const ids = Array.from(selectedIds);
              if (ids.length < 2) {
                return;
              }
              setCullPhotoIds(ids);
            }}
            onToggleFavorite={() => {
              const ids = [...selectedIds];
              const allFav = ids.every(
                (id) => photos.find((p) => p.id === id)?.isFavorite
              );
              const newVal = !allFav;
              ipc.client.photos
                .toggleFavorite({ ids, favorite: newVal })
                .then(() => {
                  setIdentity((prev) => {
                    if (!prev) {
                      return prev;
                    }
                    const idSet = new Set(ids);
                    return {
                      ...prev,
                      photos: prev.photos.map((p) =>
                        idSet.has(p.id) ? { ...p, isFavorite: newVal } : p
                      ),
                    };
                  });
                  for (const favId of ids) {
                    sequenceView.updateMemberFavorite(favId, newVal);
                  }
                  queryClient.invalidateQueries({
                    queryKey: ["photos"],
                    refetchType: "active",
                  });
                  toast.success(
                    newVal
                      ? t("toastFavoriteAddedCount", { count: ids.length })
                      : t("toastFavoriteRemoved"),
                    {
                      action: {
                        label: t("toastUndo"),
                        onClick: async () => {
                          await ipc.client.photos.toggleFavorite({
                            ids,
                            favorite: allFav,
                          });
                          queryClient.invalidateQueries({
                            queryKey: ["photos"],
                          });
                        },
                      },
                    }
                  );
                });
            }}
            onUploadToCloud={handleUploadSelectedToCloud}
            selectedCount={selectedIds.size}
          />
        </div>
        {sequenceView.selectedSequence ? (
          <SequenceDetailPanel
            onClose={() => sequenceView.setSelectedSequence(null)}
            onOpenPhoto={(photoId) => {
              const member = sequenceView.selectedSequence?.members.find(
                (m) => m.id === photoId
              );
              sequenceView.setSelectedSequence(null);
              handleKeyboardSelect(photoId);
              if (member) {
                showPhoto(member);
              }
            }}
            onPlay={() => {
              if (sequenceView.selectedSequence) {
                sequenceView.setOpenSequence(sequenceView.selectedSequence);
              }
            }}
            onSetRepresentative={(sequenceId, photoId) => {
              ipc.client.photos
                .setSequenceRepresentative({ id: sequenceId, photoId })
                .then(() => {
                  sequenceView.setSelectedSequence((current) =>
                    current?.id === sequenceId
                      ? {
                          ...current,
                          representativePhotoId: photoId,
                          source: "manual",
                          userLocked: true,
                        }
                      : current
                  );
                  toast.success("已设为手动代表帧");
                })
                .catch(() => toast.error("设置代表帧失败"));
            }}
            sequence={sequenceView.selectedSequence}
            width={360}
          />
        ) : (
          <PhotoDetailPanel
            onClose={() => {
              dismissDetail();
              clearSelection();
            }}
            onNavigate={navigateDetail}
            onOpenExplorer={handleOpenExplorer}
            photo={detailPhoto as any}
          />
        )}
      </div>

      {lightboxIndex >= 0 && (
        <PhotoLightbox
          initialIndex={lightboxIndex}
          modalOpen={addToAlbumOpen}
          onAddToAlbum={handleAddToAlbum}
          onClose={() => setLightboxIndex(-1)}
          onToggleFavorite={handleToggleFavorite}
          open={lightboxIndex >= 0}
          photos={photos as any}
        />
      )}
      {sequenceView.openSequence && (
        <PhotoLightbox
          initialIndex={0}
          onClose={() => sequenceView.setOpenSequence(null)}
          onToggleFavorite={handleToggleFavorite}
          open={true}
          photos={sequenceView.openSequence.members}
          sequencePlayback={true}
          showThumbnailsInitially={true}
        />
      )}
      {quickPreviewIndex >= 0 && photos[quickPreviewIndex] && (
        <QuickPreview
          onClose={() => setQuickPreviewIndex(-1)}
          onNavigate={(dir) => {
            setQuickPreviewIndex((prev) => {
              const next = prev + dir;
              if (next < 0 || next >= photos.length) {
                return prev;
              }
              handleKeyboardSelect(photos[next].id);
              return next;
            });
          }}
          onOpenLightbox={() => {
            setLightboxIndex(quickPreviewIndex);
            setQuickPreviewIndex(-1);
          }}
          photo={photos[quickPreviewIndex] as any}
        />
      )}

      <PhotoContextMenu
        menu={ctxMenu}
        onAddToAlbum={handleAddToAlbum}
        onBatchAddToAlbum={() => {
          setAddToAlbumIds(Array.from(selectedIds));
          setAddToAlbumOpen(true);
          setCtxMenu((prev) => ({ ...prev, open: false }));
        }}
        onBatchDelete={handleDeleteSelected}
        onBatchExport={handleExportSelected}
        onBatchShare={handleShareSelected}
        onBatchToggleFavorite={() => {
          const ids = [...selectedIds];
          const allFav = ids.every(
            (id) => photos.find((p) => p.id === id)?.isFavorite
          );
          const newVal = !allFav;
          ipc.client.photos
            .toggleFavorite({ ids, favorite: newVal })
            .then(() => {
              for (const favId of ids) {
                sequenceView.updateMemberFavorite(favId, newVal);
              }
              queryClient.invalidateQueries({
                queryKey: ["photos"],
                refetchType: "active",
              });
              toast.success(
                newVal
                  ? t("toastFavoriteAddedCount", { count: ids.length })
                  : t("toastFavoriteRemoved"),
                {
                  action: {
                    label: t("toastUndo"),
                    onClick: async () => {
                      await ipc.client.photos.toggleFavorite({
                        ids,
                        favorite: allFav,
                      });
                      queryClient.invalidateQueries({
                        queryKey: ["photos"],
                        refetchType: "active",
                      });
                    },
                  },
                }
              );
            });
        }}
        onBatchUploadToCloud={handleUploadSelectedToCloud}
        onClose={() => setCtxMenu((prev) => ({ ...prev, open: false }))}
        onDelete={handleDeletePhoto}
        onDeleteSequenceGroup={(ids) => {
          setPendingDeleteSequenceGroup(true);
          setPendingDeleteIds(ids);
          setDeleteConfirmOpen(true);
        }}
        onExport={handleExportPhoto}
        onOpenExplorer={handleOpenExplorer}
        onSetAsPersonCover={handleSetAsPersonCover}
        onShare={handleShare}
        onToggleFavorite={handleToggleFavorite}
        onUploadToCloud={handleUploadToCloud}
      />

      <AddToAlbumDialog
        elevated={lightboxIndex >= 0}
        onClose={() => {
          setAddToAlbumOpen(false);
          setAddToAlbumIds([]);
        }}
        open={addToAlbumOpen}
        photoIds={addToAlbumIds}
      />

      <ExportDialog
        onClose={() => {
          setExportDialogOpen(false);
          setExportIds([]);
        }}
        open={exportDialogOpen}
        photoIds={exportIds}
      />

      <BatchRenameDialog
        onClose={() => {
          setRenameDialogOpen(false);
          clearSelection();
        }}
        onRename={handleRenameSelected}
        open={renameDialogOpen}
        photoCount={selectedIds.size}
        sampleFilename={photos[0]?.filename || ""}
      />

      <FormatConvertDialog
        onClose={() => setConvertDialogOpen(false)}
        onConvert={handleConvertSelected}
        open={convertDialogOpen}
        photoCount={selectedIds.size}
      />

      <CloudUploadDialog
        onClose={() => {
          setCloudUploadOpen(false);
          setCloudUploadIds([]);
        }}
        open={cloudUploadOpen}
        photoIds={cloudUploadIds}
      />

      <ShareDialog
        onClose={() => {
          setShareDialogOpen(false);
          setShareIds([]);
        }}
        open={shareDialogOpen}
        photoIds={shareIds}
      />

      {/* Confirm dialogs */}
      <ConfirmDialog
        confirmText={t("remove")}
        description={t("removeFromPersonDescription")}
        destructive
        onCancel={() => setConfirmRemovePhotoId(null)}
        onConfirm={performRemoveFace}
        open={confirmRemovePhotoId !== null}
        title={t("confirmRemove")}
      />

      <ConfirmDialog
        confirmText={t("remove")}
        description={t("removeFromPersonDescription")}
        destructive
        onCancel={() => setConfirmRemoveIds([])}
        onConfirm={performRemoveSelected}
        open={confirmRemoveIds.length > 0}
        title={t("confirmRemove")}
      />

      <ConfirmDialog
        confirmText={t("delete")}
        description={t("confirmDeleteDescription", {
          count: confirmDeleteIds.length,
        })}
        destructive
        onCancel={() => setConfirmDeleteIds([])}
        onConfirm={performDelete}
        open={confirmDeleteIds.length > 0}
        title={t("confirmDeleteTitle")}
      />

      <ConfirmDeleteDialog
        count={pendingDeleteIds.length}
        onCancel={() => {
          setDeleteConfirmOpen(false);
          setPendingDeleteIds([]);
          setPendingDeleteSequenceGroup(false);
        }}
        onConfirm={executeDelete}
        open={deleteConfirmOpen}
        sequenceGroup={pendingDeleteSequenceGroup}
      />
      <CullStartDialog
        defaultName={`${t("cullTitle")} · ${cullPhotoIds.length} ${t("photos")}`}
        onClose={() => setCullPhotoIds([])}
        onCreated={(sessionId) => {
          setCullPhotoIds([]);
          clearSelection();
          navigate({
            to: "/cull/$sessionId",
            params: { sessionId: String(sessionId) },
          });
        }}
        open={cullPhotoIds.length >= 2}
        photoIds={cullPhotoIds}
      />
    </div>
  );
}

export const Route = createFileRoute("/people/$identityId" as const)({
  component: PersonDetailPage,
  errorComponent: RouteError,
});
