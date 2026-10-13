import { useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { setPhotoFavorites } from "@/actions/photo-favorites";
import type { useSequenceSelectionPhotos } from "@/hooks/useSequenceSelectionPhotos";

interface Options {
  applyFavoriteState: (ids: number[], favorite: boolean) => void;
  displayedSequenceMode: "photos" | "sequences";
  selectedIds: Set<number>;
  selectionReady: boolean;
  sequenceQuerySourceKey: string;
  sequenceSelection: ReturnType<typeof useSequenceSelectionPhotos>;
  visibleSelectionIds: number[];
}
export function useHomeBatchFavorite({
  sequenceQuerySourceKey,
  displayedSequenceMode,
  selectionReady,
  selectedIds,
  sequenceSelection,
  visibleSelectionIds,
  applyFavoriteState,
}: Options) {
  const { t } = useTranslation();

  const selectionOperationKey = `${sequenceQuerySourceKey}:${displayedSequenceMode}:${[...selectedIds].join(",")}`;

  const selectionOperationRef = useRef(selectionOperationKey);

  selectionOperationRef.current = selectionOperationKey;

  const favoriteOperationPendingRef = useRef(false);

  const handleBatchToggleFavorite = useCallback(async () => {
    if (
      !selectionReady ||
      favoriteOperationPendingRef.current ||
      selectedIds.size === 0
    ) {
      return;
    }
    favoriteOperationPendingRef.current = true;
    const operationKey = selectionOperationKey;
    try {
      const targets = await sequenceSelection.resolvePhotos();
      if (selectionOperationRef.current !== operationKey) {
        return;
      }
      const allowed = new Set(visibleSelectionIds);
      if (targets.some((photo) => !allowed.has(photo.id))) {
        return;
      }
      const ids = targets.map((photo) => photo.id);
      const favorite = !targets.every((photo) => photo.isFavorite);
      await setPhotoFavorites(ids, favorite);
      applyFavoriteState(ids, favorite);
      toast.success(
        favorite
          ? t("toastFavoriteAddedCount", { count: ids.length })
          : t("toastFavoriteRemoved"),
        {
          action: {
            label: t("toastUndo"),
            onClick: async () => {
              try {
                for (const previous of [true, false]) {
                  const originalIds = targets
                    .filter((photo) => photo.isFavorite === previous)
                    .map((photo) => photo.id);
                  if (originalIds.length > 0) {
                    await setPhotoFavorites(originalIds, previous);
                    applyFavoriteState(originalIds, previous);
                  }
                }
              } catch {
                toast.error(t("favoriteUpdateFailed"));
              }
            },
          },
        }
      );
    } catch {
      toast.error(t("favoriteUpdateFailed"));
    } finally {
      favoriteOperationPendingRef.current = false;
    }
  }, [
    selectionReady,
    selectedIds,
    selectionOperationKey,
    sequenceSelection.resolvePhotos,
    visibleSelectionIds,
    applyFavoriteState,
    t,
  ]);
  return handleBatchToggleFavorite;
}
