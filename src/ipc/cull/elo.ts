/**
 * Pure Elo rating functions and culling mode config.
 * Extracted to avoid transitive imports of electron / database.
 */

export function computeElo(
  ratingA: number,
  ratingB: number,
  scoreA: number,
  comparisonsA: number,
  comparisonsB: number
): { newRatingA: number; newRatingB: number } {
  const expectedA = 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
  const avgComparisons = (comparisonsA + comparisonsB) / 2;
  const k = 32 / (1 + avgComparisons / 10);
  const newRatingA = Math.round(ratingA + k * (scoreA - expectedA));
  const newRatingB = Math.round(ratingB + k * (expectedA - scoreA));
  return { newRatingA, newRatingB };
}

export const PK_MODE_CONFIG: Record<
  string,
  {
    minComparisons: number;
    allowRecompare: boolean;
    recompareFactor: number;
    similarityWeight: number;
    ratingWeight: number;
    swissThreshold: number;
  }
> = {
  quick: {
    minComparisons: 5,
    allowRecompare: false,
    recompareFactor: 0,
    similarityWeight: 0.3,
    ratingWeight: 0.2,
    swissThreshold: 0.6,
  },
  standard: {
    minComparisons: 8,
    allowRecompare: true,
    recompareFactor: 0.15,
    similarityWeight: 0.5,
    ratingWeight: 0.3,
    swissThreshold: 0.55,
  },
  fine: {
    minComparisons: 12,
    allowRecompare: true,
    recompareFactor: 0.3,
    similarityWeight: 0.7,
    ratingWeight: 0.4,
    swissThreshold: 0.4,
  },
};
