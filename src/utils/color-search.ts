import type { SearchMatch } from "@/types/photo";

/** Maximum accepted RGB Euclidean distance for color search. */
export const COLOR_MATCH_MAX_DISTANCE = 100;
export const COLOR_MATCH_MAX_DISTANCE_SQUARED =
  COLOR_MATCH_MAX_DISTANCE * COLOR_MATCH_MAX_DISTANCE;

export interface ColorSearchRank {
  /** Squared RGB Euclidean distance, matching SQLite closest_color_dist. */
  distanceSquared: number;
  photoId: number;
}

/** Converts squared RGB distance to a user-facing color closeness score. */
export function colorDistanceToMatchScore(distanceSquared: number): number {
  const distance = Math.sqrt(Math.max(0, distanceSquared));
  return Math.max(0, Math.min(1, 1 - distance / COLOR_MATCH_MAX_DISTANCE));
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
): Array<T & { match: SearchMatch }> {
  const photoMap = new Map(photos.map((photo) => [photo.id, photo]));
  return ranks.flatMap((rank) => {
    const photo = photoMap.get(rank.photoId);
    if (!photo) {
      return [];
    }
    const match: SearchMatch = {
      kind: "color",
      score: colorDistanceToMatchScore(rank.distanceSquared),
    };
    return [{ ...photo, match }];
  });
}
