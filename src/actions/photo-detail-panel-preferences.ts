export const PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY =
  "photo-detail.advanced-metadata";

export const DEFAULT_PHOTO_DETAIL_ADVANCED_METADATA_EXPANDED = false;

function getStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

export function readPhotoDetailAdvancedMetadataExpanded(): boolean {
  const storage = getStorage();
  if (!storage) {
    return DEFAULT_PHOTO_DETAIL_ADVANCED_METADATA_EXPANDED;
  }

  try {
    return (
      storage.getItem(PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY) === "true"
    );
  } catch {
    return DEFAULT_PHOTO_DETAIL_ADVANCED_METADATA_EXPANDED;
  }
}

export function savePhotoDetailAdvancedMetadataExpanded(
  expanded: unknown
): boolean {
  const storage = getStorage();
  if (!storage || typeof expanded !== "boolean") {
    return false;
  }

  try {
    storage.setItem(
      PHOTO_DETAIL_ADVANCED_METADATA_STORAGE_KEY,
      String(expanded)
    );
    return true;
  } catch {
    return false;
  }
}
