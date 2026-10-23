import { useRef } from "react";
import { getGalleryGeometryKey } from "@/utils/gallery-data-source";

/** Content hydration changes rich fields, not the resident geometry/order. */
export function useGalleryGeometryPhotos<T extends { id: number }>(
  photos: T[]
): T[] {
  const key = getGalleryGeometryKey(photos);
  const retained = useRef<{ key: string | null; photos: T[] }>({ key, photos });
  if (
    !key ||
    retained.current.key !== key ||
    retained.current.photos.length !== photos.length
  ) {
    retained.current = { key, photos };
  }
  return retained.current.photos;
}
