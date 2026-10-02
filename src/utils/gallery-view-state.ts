export type GallerySequenceMode = "photos" | "sequences";

export function createSearchResultSourceKey(
  generation: number,
  photoIds: number[]
): string {
  return `${generation}:${photoIds.join(",")}`;
}

export function getDisplayedSequenceMode(
  mode: GallerySequenceMode,
  sequenceViewReady: boolean,
  currentMode: GallerySequenceMode = "photos"
): GallerySequenceMode {
  return sequenceViewReady ? mode : currentMode;
}

/** Do not expose appended search photos until their ownership is confirmed. */
export function getSequenceResolvedPhotos<T extends { id: number }>({
  photos,
  generation,
  resolvedGeneration,
  resolvedIds,
}: {
  photos: T[];
  generation: number | null;
  resolvedGeneration: number | null;
  resolvedIds: number[];
}): T[] {
  if (generation === null || generation !== resolvedGeneration) {
    return photos;
  }
  const isAppend =
    photos.length > resolvedIds.length &&
    resolvedIds.every((id, index) => photos[index]?.id === id);
  return isAppend ? photos.slice(0, resolvedIds.length) : photos;
}

export function canPaginateGalleryPhotos(
  mode: GallerySequenceMode,
  hasNextPage: boolean,
  isSearching = false
): boolean {
  return hasNextPage && (mode !== "sequences" || isSearching);
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
