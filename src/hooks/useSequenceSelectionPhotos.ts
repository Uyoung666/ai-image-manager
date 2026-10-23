import { useCallback, useEffect, useMemo, useState } from "react";
import { withPhotoFavorite } from "@/actions/photo-favorites";
import { photoSequenceActions } from "@/actions/photo-sequences";
import { useGalleryGeometryPhotos } from "@/hooks/useGalleryGeometryPhotos";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
import { readGalleryPhotoRecords } from "@/utils/gallery-data-source";
import { resolveSequenceSelection } from "@/utils/sequence-selection";

const loadDetail = async (id: number) =>
  (await photoSequenceActions.get(id)) as PhotoSequenceDetail | null;

export function useSequenceSelectionPhotos(
  selectedIds: Set<number>,
  photos: Photo[],
  sequences: PhotoSequence[]
) {
  const geometryPhotos = useGalleryGeometryPhotos(photos);
  const [resolved, setResolved] = useState<Photo[]>([]);
  const resolveSelection = useCallback(
    () =>
      resolveSequenceSelection(
        [...selectedIds],
        geometryPhotos,
        sequences,
        loadDetail
      ),
    [selectedIds, geometryPhotos, sequences]
  );
  const resolvePhotos = useCallback(
    async () => readGalleryPhotoRecords(await resolveSelection()),
    [resolveSelection]
  );
  useEffect(() => {
    let cancelled = false;
    resolveSelection()
      .then((result) => {
        if (!cancelled) {
          setResolved(result);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setResolved([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [resolveSelection]);
  const knownById = useMemo(() => {
    if (selectedIds.size === 0) {
      return new Map<number, Photo>();
    }
    const known = new Map(resolved.map((photo) => [photo.id, photo]));
    for (const photo of geometryPhotos) {
      known.set(photo.id, photo);
    }
    return known;
  }, [resolved, geometryPhotos, selectedIds]);
  const allFavorite =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) => knownById.get(id)?.isFavorite);
  const updateFavorites = useCallback((ids: number[], favorite: boolean) => {
    const targets = new Set(ids);
    setResolved((current) =>
      current.map((photo) =>
        targets.has(photo.id) ? withPhotoFavorite(photo, favorite) : photo
      )
    );
  }, []);
  return {
    allFavorite,
    resolvePhotos,
    updateFavorites,
    resolvedPhotos: resolved,
  };
}
