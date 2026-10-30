import { toLocalMediaUrl } from "./local-media-url";
import { toShootingProjectPreviewUrl } from "./shooting-project-media-url";

/** Shared media identity. Project IDs must never be sent to gallery APIs. */
export interface CullMediaPhoto {
  id: number;
  originalUrl?: string | null;
  path: string;
  previewHeight?: number | null;
  previewUrl?: string;
  previewWidth?: number | null;
  projectPhotoId?: string;
  source?:
    | { kind: "library"; photoId: number }
    | { kind: "project"; projectId: string; photoId: string };
  thumbnailPath: string | null;
}

export function getCullProjectPreview(
  photo: CullMediaPhoto
): string | undefined {
  if (photo.source?.kind !== "project") {
    return undefined;
  }
  return (
    photo.previewUrl ||
    toShootingProjectPreviewUrl(photo.source.projectId, photo.source.photoId)
  );
}

export function getCullThumbnail(photo: CullMediaPhoto): string {
  return (
    getCullProjectPreview(photo) ??
    toLocalMediaUrl(photo.thumbnailPath ?? photo.path)
  );
}
