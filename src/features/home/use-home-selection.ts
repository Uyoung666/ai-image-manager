import { useMemo } from "react";
import { usePhotoSelection } from "@/hooks/usePhotoSelection";
import { useSequenceSelectionPhotos } from "@/hooks/useSequenceSelectionPhotos";
import type { Photo } from "@/types/photo";
import type { PhotoSequence } from "@/types/photo-sequence";

interface Options {
  actionPhotos: Photo[];
  displayedSequenceMode: "photos" | "sequences";
  photos: Photo[];
  photosIsPlaceholder: boolean;
  routeKey: string;
  sequences: PhotoSequence[];
  sequenceViewReady: boolean;
}
export function useHomeSelection({
  routeKey,
  photos,
  actionPhotos,
  sequences,
  displayedSequenceMode,
  sequenceViewReady,
  photosIsPlaceholder,
}: Options) {
  const sequenceMemberIdSet = useMemo(
    () =>
      new Set(
        sequences.flatMap(
          (sequence) =>
            sequence.matchedPhotoIds ?? sequence.memberPhotoIds ?? []
        )
      ),
    [sequences]
  );

  const selectionPhotos = useMemo(
    () =>
      displayedSequenceMode === "photos"
        ? photos.filter((photo) => !sequenceMemberIdSet.has(photo.id))
        : actionPhotos.filter((photo) => sequenceMemberIdSet.has(photo.id)),
    [actionPhotos, displayedSequenceMode, photos, sequenceMemberIdSet]
  );

  const visibleSelectionIds = useMemo(
    () =>
      displayedSequenceMode === "sequences"
        ? [...sequenceMemberIdSet]
        : selectionPhotos.map((photo) => photo.id),
    [displayedSequenceMode, selectionPhotos, sequenceMemberIdSet]
  );

  const selectionReady =
    sequenceViewReady &&
    (displayedSequenceMode === "sequences" || !photosIsPlaceholder);

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
    selectAllIds,
  } = usePhotoSelection(routeKey, selectionPhotos, {
    validIds: visibleSelectionIds,
    ready: selectionReady,
  });

  const sequenceSelection = useSequenceSelectionPhotos(
    selectedIds,
    selectionPhotos,
    sequences
  );

  const previewPhotos = useMemo(() => {
    if (displayedSequenceMode !== "sequences") {
      return selectionPhotos;
    }
    const byId = new Map(selectionPhotos.map((photo) => [photo.id, photo]));
    for (const photo of sequenceSelection.resolvedPhotos) {
      if (sequenceMemberIdSet.has(photo.id) && !byId.has(photo.id)) {
        byId.set(photo.id, photo);
      }
    }
    return byId.size === selectionPhotos.length
      ? selectionPhotos
      : [...byId.values()];
  }, [
    selectionPhotos,
    displayedSequenceMode,
    sequenceSelection.resolvedPhotos,
    sequenceMemberIdSet,
  ]);
  return {
    sequenceMemberIdSet,
    selectionPhotos,
    visibleSelectionIds,
    selectionReady,
    selectedIds,
    handleSelect,
    handleSelectMany,
    addToSelection,
    handleKeyboardSelect,
    handleMarqueeSelect,
    clearSelection,
    removeFromSelection,
    selectAllIds,
    sequenceSelection,
    previewPhotos,
  };
}
