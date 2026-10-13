import type { Dispatch, SetStateAction } from "react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { photoOperationActions } from "@/actions/photo-operations";
import { openInExplorer } from "@/actions/shell";
import { queryClient } from "@/providers/QueryProvider";
import type { Photo } from "@/types/photo";

interface Options {
  isSearching: boolean;
  markRouteDirty: (key: string) => void;
  removeFromSelection: (ids: number[]) => void;
  routeKey: string;
  selectedIds: Set<number>;
  setSearchResults: Dispatch<SetStateAction<Photo[] | null>>;
}
export function useHomePhotoActions({
  selectedIds,
  routeKey,
  isSearching,
  markRouteDirty,
  removeFromSelection,
  setSearchResults,
}: Options) {
  const { t } = useTranslation();

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

  const [deletingIds, setDeletingIds] = useState<Set<number>>(new Set());

  async function handleOpenExplorer(filePath: string) {
    try {
      await openInExplorer(filePath);
    } catch {
      // Ignore shell failures; the caller has no recovery action to present.
    }
  }

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

  function handleDeleteSelected() {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) {
      return;
    }
    setPendingDeleteSequenceGroup(false);
    setPendingDeleteIds(ids);
    setDeleteConfirmOpen(true);
  }

  async function executeDelete() {
    const ids = pendingDeleteIds;
    const count = ids.length;
    setDeleteConfirmOpen(false);
    setPendingDeleteIds([]);
    setPendingDeleteSequenceGroup(false);
    // Trigger exit animation
    setDeletingIds(new Set(ids));
    await new Promise((r) => setTimeout(r, 180));
    setDeletingIds(new Set());
    try {
      if (ids.length === 1) {
        await photoOperationActions.deletePhoto({ id: ids[0] });
      } else {
        await photoOperationActions.deletePhotos({ ids });
      }
      // 标记滚动位置为脏：已删除照片的锚点已失效
      markRouteDirty(routeKey);
      // 从选中集合中移除已删除的照片
      removeFromSelection(ids);
      if (isSearching) {
        setSearchResults(
          (prev) => prev?.filter((p) => !ids.includes(p.id)) ?? null
        );
      } else {
        queryClient.invalidateQueries({
          queryKey: ["photos"],
          refetchType: "active",
        });
      }
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["albums"] });
      toast.success(t("toastDeletedCount", { count }));
    } catch {
      toast.error(t("toastDeleteFailed"));
    }
  }

  async function handleRenameSelected(pattern: string) {
    const ids = Array.from(selectedIds);
    try {
      const result = await photoOperationActions.renamePhotos({ ids, pattern });
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
      const result = await photoOperationActions.convertPhotos({
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
  return {
    renameDialogOpen,
    setRenameDialogOpen,
    convertDialogOpen,
    setConvertDialogOpen,
    addToAlbumOpen,
    setAddToAlbumOpen,
    addToAlbumIds,
    setAddToAlbumIds,
    exportDialogOpen,
    setExportDialogOpen,
    exportIds,
    setExportIds,
    cloudUploadOpen,
    setCloudUploadOpen,
    cloudUploadIds,
    setCloudUploadIds,
    shareDialogOpen,
    setShareDialogOpen,
    shareIds,
    setShareIds,
    deleteConfirmOpen,
    setDeleteConfirmOpen,
    cullPhotoIds,
    setCullPhotoIds,
    pendingDeleteIds,
    setPendingDeleteIds,
    pendingDeleteSequenceGroup,
    setPendingDeleteSequenceGroup,
    deletingIds,
    setDeletingIds,
    handleOpenExplorer,
    handleDeletePhoto,
    handleAddToAlbum,
    handleExportPhoto,
    handleExportSelected,
    handleUploadToCloud,
    handleUploadSelectedToCloud,
    handleShare,
    handleShareSelected,
    handleDeleteSelected,
    executeDelete,
    handleRenameSelected,
    handleConvertSelected,
  };
}
