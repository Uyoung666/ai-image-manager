interface HomeGalleryVisibilityInput {
  activeFolderId: number | null;
  activeTagCount: number;
  favoriteOnly: boolean;
  initialQueryError?: boolean;
  isSearching: boolean;
  loading: boolean;
  photoCount: number;
}

export function shouldShowHomeGallery({
  activeFolderId,
  activeTagCount,
  favoriteOnly,
  initialQueryError = false,
  isSearching,
  loading,
  photoCount,
}: HomeGalleryVisibilityInput): boolean {
  return (
    photoCount > 0 ||
    initialQueryError ||
    loading ||
    isSearching ||
    favoriteOnly ||
    activeFolderId !== null ||
    activeTagCount > 0
  );
}
