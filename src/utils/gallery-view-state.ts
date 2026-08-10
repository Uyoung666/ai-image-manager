export type GallerySequenceMode = "photos" | "sequences";

export function createSearchResultSourceKey(
  generation: number,
  photoIds: number[]
): string {
  return `${generation}:${photoIds.join(",")}`;
}

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

export function shouldUseImmediateGalleryPhotos<T>({
  deferredPhotos,
  isSearching,
  lastSearchPhotos,
  rawPhotos,
}: {
  deferredPhotos: T[];
  isSearching: boolean;
  lastSearchPhotos: T[] | null;
  rawPhotos: T[];
}): boolean {
  return (
    isSearching ||
    (deferredPhotos === lastSearchPhotos && deferredPhotos !== rawPhotos)
  );
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

export function isSequenceSourceReady({
  currentGeneration,
  currentIds,
  currentSourceKey,
  isSearching,
  previousGeneration,
  previousIds,
  previousSourceKey,
  refreshUnchanged,
}: {
  currentGeneration: number | null;
  currentIds: number[];
  currentSourceKey: string;
  isSearching: boolean;
  previousGeneration: number | null;
  previousIds: number[];
  previousSourceKey: string;
  refreshUnchanged: boolean;
}): boolean {
  if (currentSourceKey === previousSourceKey) {
    return true;
  }
  if (
    !isSearching ||
    currentGeneration === null ||
    previousGeneration === null ||
    currentGeneration !== previousGeneration
  ) {
    return false;
  }
  return (
    getStableSearchAppendIds({
      currentIds,
      currentSearchKey: String(currentGeneration),
      isSearching: true,
      previousIds,
      previousSearchKey: String(previousGeneration),
      refreshUnchanged,
    }) !== null
  );
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
