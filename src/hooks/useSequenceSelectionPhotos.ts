import { useCallback, useEffect, useState } from "react";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
import { resolveSequenceSelection } from "@/utils/sequence-selection";

const loadDetail = async (id: number) =>
  (await photoSequenceActions.get(id)) as PhotoSequenceDetail | null;

export function useSequenceSelectionPhotos(
  selectedIds: Set<number>,
  photos: Photo[],
  sequences: PhotoSequence[]
) {
  const [resolved, setResolved] = useState<Photo[]>([]);
  const resolvePhotos = useCallback(
    () =>
      resolveSequenceSelection([...selectedIds], photos, sequences, loadDetail),
    [selectedIds, photos, sequences]
  );
  useEffect(() => {
    let cancelled = false;
    resolvePhotos()
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
  }, [resolvePhotos]);
  const knownById = new Map(resolved.map((photo) => [photo.id, photo]));
  for (const photo of photos) {
    knownById.set(photo.id, photo);
  }
  const allFavorite =
    selectedIds.size > 0 &&
    [...selectedIds].every((id) => knownById.get(id)?.isFavorite);
  const updateFavorites = useCallback((ids: number[], favorite: boolean) => {
    const targets = new Set(ids);
    setResolved((current) =>
      current.map((photo) =>
        targets.has(photo.id) ? { ...photo, isFavorite: favorite } : photo
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
