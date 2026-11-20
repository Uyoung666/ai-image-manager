import { isLibrarySourceUnavailable } from "@/components/LibraryPhotoStatus";
import type { LibraryPhotoStatus } from "@/types/library-reliability";
import { BROWSE_PREVIEW_EDGES } from "./gallery-config";
import { toBrowsePreviewUrl, toLocalMediaUrl } from "./local-media-url";

export interface BrowsePhoto extends LibraryPhotoStatus {
  height: number;
  id: number;
  path: string;
  thumbnailPath?: string | null;
  thumbnailVersion?: string;
  width: number;
}

export interface ImageArea {
  height: number;
  width: number;
}

const SHOW_NATIVE = /\.(?:gif|svg|ico)$/i;
const NATIVE_IMAGE = /\.(?:jpe?g|bmp|png|webp|avif)$/i;
const JPEG = /\.jpe?g$/i;
const DIRECT_JPEG_PIXELS = 16_000_000;

export function fitImage(photo: ImageArea, area: ImageArea): ImageArea {
  if (!(photo.width > 0 && photo.height > 0)) {
    return area;
  }
  const fit = Math.min(area.width / photo.width, area.height / photo.height, 1);
  return { width: photo.width * fit, height: photo.height * fit };
}

export function browseMedia(
  photo: BrowsePhoto,
  area: ImageArea,
  dpr: number,
  repair = false
) {
  const size = fitImage(photo, area);
  const required = Math.max(size.width, size.height) * dpr;
  const edge = BROWSE_PREVIEW_EDGES.find((value) => value >= required) ?? 4096;
  const sourceEdge = Math.max(photo.width, photo.height);
  const nativeJpeg =
    JPEG.test(photo.path) &&
    photo.width > 0 &&
    photo.height > 0 &&
    photo.width * photo.height <= DIRECT_JPEG_PIXELS;
  const unavailable = isLibrarySourceUnavailable(photo.sourceStatus);
  const animated = SHOW_NATIVE.test(photo.path);
  const original = unavailable
    ? ""
    : toLocalMediaUrl(
        photo.path,
        photo.thumbnailPath && photo.thumbnailVersion
          ? JSON.stringify([photo.thumbnailPath, photo.thumbnailVersion])
          : (photo.thumbnailPath ?? photo.thumbnailVersion ?? undefined)
      );
  const direct =
    Boolean(original) &&
    (animated ||
      nativeJpeg ||
      (NATIVE_IMAGE.test(photo.path) && sourceEdge > 0 && sourceEdge <= edge));
  return {
    original,
    direct,
    edge: direct ? sourceEdge : Math.min(edge, sourceEdge || edge),
    fit: direct
      ? original
      : toBrowsePreviewUrl(
          photo.id,
          edge,
          photo.thumbnailVersion,
          repair,
          photo.thumbnailPath ?? undefined
        ),
    // Native JPEGs already load quickly. Reading them through a no-store fetch
    // would compete with the viewer without preparing a reusable preview.
    prefetch: !(unavailable || animated || nativeJpeg),
    unavailable,
  };
}

export function browsePhotoKey(photo: BrowsePhoto): string {
  return JSON.stringify([
    photo.id,
    photo.path,
    photo.thumbnailVersion,
    photo.thumbnailPath,
    photo.sourceStatus,
  ]);
}

export function browsePlaceholder(photo: BrowsePhoto): string | null {
  for (const tile of document.querySelectorAll<HTMLElement>(
    `[data-photo-id="${photo.id}"][data-browse-source]`
  )) {
    if (tile.dataset.browseSource !== browsePhotoKey(photo)) {
      continue;
    }
    const image = tile.querySelector("img");
    if (image?.complete && image.naturalWidth > 0) {
      return image.currentSrc || image.src;
    }
  }
  return photo.thumbnailPath ? toLocalMediaUrl(photo.thumbnailPath) : null;
}

export function browseNeighborIndices(
  count: number,
  index: number,
  direction: number,
  wrap: boolean
): number[] {
  if (count < 2) {
    return [];
  }
  const offsets = direction ? [direction, direction * 2, -direction] : [1, -1];
  const result = new Set<number>();
  for (const offset of offsets) {
    const target = wrap ? (index + offset + count) % count : index + offset;
    if (target >= 0 && target < count && target !== index) {
      result.add(target);
    }
  }
  return [...result];
}
