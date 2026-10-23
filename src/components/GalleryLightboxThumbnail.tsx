import { useGalleryThumbnail } from "@/hooks/useGalleryThumbnail";
import {
  toGalleryThumbnailUrl,
  toLocalMediaUrl,
} from "@/utils/local-media-url";

export function GalleryLightboxThumbnail({
  photo,
}: {
  photo: {
    id: number;
    width: number;
    height: number;
    path: string;
    thumbnailPath?: string | null;
    thumbnailVersion?: string;
  };
}) {
  const managed = Boolean(toGalleryThumbnailUrl(photo.id, 256));
  const image = useGalleryThumbnail({
    id: photo.id,
    version: `${photo.thumbnailPath ?? photo.path}:${photo.width}:${photo.height}:0`,
    sourceVersion: photo.thumbnailVersion,
    width: 96,
    height: 72,
    enabled: managed,
    priority: 1,
  });
  const src = managed
    ? image.url
    : toLocalMediaUrl(photo.thumbnailPath ?? photo.path);
  return (
    <div className="h-full w-full bg-white/5" ref={image.ref}>
      {src && (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: load acknowledgement releases the shared native image request slot.
        <img
          alt=""
          className="h-full w-full object-cover"
          decoding="async"
          draggable={false}
          height={photo.height || undefined}
          onLoad={() => image.onDisplayed(src)}
          src={src}
          width={photo.width || undefined}
        />
      )}
    </div>
  );
}
