const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
  ".heic",
  ".heif",
  ".tiff",
  ".tif",
  ".svg",
  ".ico",
  ".raw",
  ".cr2",
  ".cr3",
  ".nef",
  ".arw",
  ".orf",
  ".rw2",
  ".dng",
  ".pef",
  ".raf",
  ".sr2",
]);

export type ExternalDropKind = "image" | "folders" | "invalid";

const INTERNAL_PHOTO_IDS_MIME = "application/x-photo-ids";

interface ExternalDropItem {
  file: File | null;
  isDirectory: boolean;
  mimeType: string;
  name: string;
  path: string;
}

function hasFilesType(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes("Files");
}

function hasInternalPhotoIdsType(dataTransfer: DataTransfer): boolean {
  return Array.from(dataTransfer.types).includes(INTERNAL_PHOTO_IDS_MIME);
}

function getNativePath(file: File | null): string {
  if (!file) {
    return "";
  }
  try {
    return window.electronAPI?.getFilePath?.(file) || "";
  } catch {
    return "";
  }
}

function isNativeDirectoryPath(filePath: string): boolean {
  if (!filePath) {
    return false;
  }
  try {
    return window.electronAPI?.isDirectoryPath?.(filePath) === true;
  } catch {
    return false;
  }
}

function getExternalDropItems(dataTransfer: DataTransfer): ExternalDropItem[] {
  if (hasInternalPhotoIdsType(dataTransfer) || !hasFilesType(dataTransfer)) {
    return [];
  }

  const dataTransferItems = Array.from(dataTransfer.items)
    .filter((item) => item.kind === "file")
    .map((item) => {
      const file = item.getAsFile();
      const entry = item.webkitGetAsEntry?.();
      const path = getNativePath(file);

      return {
        file,
        isDirectory: entry?.isDirectory === true || isNativeDirectoryPath(path),
        mimeType: item.type || file?.type || "",
        name: file?.name || "",
        path,
      };
    });

  if (dataTransferItems.length > 0) {
    return dataTransferItems;
  }

  return Array.from(dataTransfer.files ?? []).map((file) => {
    const path = getNativePath(file);
    return {
      file,
      isDirectory: isNativeDirectoryPath(path),
      mimeType: file.type || "",
      name: file.name || "",
      path,
    };
  });
}

export function isSupportedImagePath(filePath: string): boolean {
  const normalized = filePath.trim().toLowerCase();
  const extensionStart = normalized.lastIndexOf(".");
  return (
    extensionStart >= 0 &&
    IMAGE_EXTENSIONS.has(normalized.slice(extensionStart))
  );
}

export function classifyExternalDrop(
  dataTransfer: DataTransfer
): ExternalDropKind | null {
  if (hasInternalPhotoIdsType(dataTransfer) || !hasFilesType(dataTransfer)) {
    return null;
  }

  const items = getExternalDropItems(dataTransfer);
  if (items.length === 0) {
    return "invalid";
  }

  const folderCount = items.filter((item) => item.isDirectory).length;
  if (folderCount > 0) {
    return folderCount === items.length ? "folders" : "invalid";
  }

  const isSingleImage =
    items.length === 1 &&
    (items[0].mimeType.startsWith("image/") ||
      isSupportedImagePath(items[0].path) ||
      isSupportedImagePath(items[0].name));
  if (isSingleImage) {
    return "image";
  }

  const allProtectedDirectoryCandidates = items.every(
    (item) => !(item.path || item.mimeType || isSupportedImagePath(item.name))
  );
  if (allProtectedDirectoryCandidates) {
    return "folders";
  }

  return "invalid";
}

export function getDroppedImagePath(dataTransfer: DataTransfer): string | null {
  const items = getExternalDropItems(dataTransfer);
  if (items.length !== 1 || items[0].isDirectory) {
    return null;
  }

  const [item] = items;
  if (!(item.path && isSupportedImagePath(item.path))) {
    return null;
  }
  return item.path;
}

export function getDroppedFolderPaths(dataTransfer: DataTransfer): string[] {
  const items = getExternalDropItems(dataTransfer);
  const paths = new Set<string>();

  for (const item of items) {
    if (item.isDirectory && item.path) {
      paths.add(item.path);
    }
  }

  return [...paths];
}
