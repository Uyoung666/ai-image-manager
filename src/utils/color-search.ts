export interface ColorSearchRank {
  distance: number;
  photoId: number;
}

export function mergeColorSearchRanks(
  primary: ColorSearchRank[],
  supplemental: ColorSearchRank[],
  limit: number
): ColorSearchRank[] {
  const seen = new Set<number>();
  const merged: ColorSearchRank[] = [];
  for (const rank of [...primary, ...supplemental]) {
    if (seen.has(rank.photoId)) {
      continue;
    }
    seen.add(rank.photoId);
    merged.push(rank);
    if (merged.length >= limit) {
      break;
    }
  }
  return merged;
}

export function hydrateColorSearchResults<T extends { id: number }>(
  ranks: ColorSearchRank[],
  photos: T[]
): Array<T & { similarity: number }> {
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  return ranks.flatMap((rank) => {
    const photo = photoMap.get(rank.photoId);
    if (!photo) {
      return [];
    }
    const similarity =
      Math.round((1 / (1 + Math.sqrt(rank.distance || 0))) * 10_000) / 10_000;
    return [{ ...photo, similarity }];
  });
}
