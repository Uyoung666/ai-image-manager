export type GallerySequenceMode = "photos" | "sequences";

export function getDisplayedSequenceMode(
  mode: GallerySequenceMode,
  sequenceViewReady: boolean
): GallerySequenceMode {
  return mode === "photos" || sequenceViewReady ? mode : "photos";
}

export function canPaginateGalleryPhotos(
  mode: GallerySequenceMode,
  hasNextPage: boolean
): boolean {
  return mode !== "sequences" && hasNextPage;
}

export function getStableSearchAppendIds({
  currentIds,
  currentSearchKey,
  isSearching,
  previousIds,
  previousSearchKey,
  refreshUnchanged,
}: {
  currentIds: number[];
  currentSearchKey: string;
  isSearching: boolean;
  previousIds: number[];
  previousSearchKey: string;
  refreshUnchanged: boolean;
}): number[] | null {
  const prefixIsStable =
    isSearching &&
    refreshUnchanged &&
    currentSearchKey === previousSearchKey &&
    previousIds.length > 0 &&
    currentIds.length >= previousIds.length &&
    previousIds.every((id, index) => currentIds[index] === id);
  return prefixIsStable ? currentIds.slice(previousIds.length) : null;
}

export function isGalleryRevealPending({
  hasSavedPosition,
  restoredRouteKey,
  routeKey,
  sequenceViewReady,
}: {
  hasSavedPosition: boolean;
  restoredRouteKey: string | null;
  routeKey: string;
  sequenceViewReady: boolean;
}): boolean {
  return (
    !sequenceViewReady || (hasSavedPosition && restoredRouteKey !== routeKey)
  );
}
