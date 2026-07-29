export type GallerySequenceMode = "photos" | "sequences";

export function getDisplayedSequenceMode(
  mode: GallerySequenceMode,
  sequenceViewReady: boolean
): GallerySequenceMode {
  return mode === "sequences" && sequenceViewReady ? "sequences" : "photos";
}

export function canPaginateGalleryPhotos(
  mode: GallerySequenceMode,
  hasNextPage: boolean
): boolean {
  return mode === "photos" && hasNextPage;
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
  return !sequenceViewReady || (hasSavedPosition && restoredRouteKey !== routeKey);
}
