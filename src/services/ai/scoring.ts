import type { EmbeddingModelConfig, EmbeddingModelKind } from "./model-config";

export interface TagScore<TCategory extends string = string> {
  category: TCategory;
  displayName: string;
  similarity: number;
}

export interface SelectedTag<TCategory extends string = string> {
  category: TCategory;
  confidence: number;
  tag: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle];
  }
  return (sorted[middle - 1] + sorted[middle]) / 2;
}

function selectClipTags<TCategory extends string>(
  scores: TagScore<TCategory>[],
  maxTags: number
): SelectedTag<TCategory>[] {
  const absoluteMinimum = 0.15;
  const categoryMultipliers: Record<string, number> = {
    scene: 1.2,
    lighting: 1.1,
    color: 1.1,
    weather: 1.1,
  };
  const candidates = [...scores]
    .sort((left, right) => right.similarity - left.similarity)
    .filter((score) => score.similarity >= absoluteMinimum);
  if (candidates.length === 0) {
    return [];
  }

  const selected: TagScore<TCategory>[] = [];
  for (const current of candidates.slice(0, maxTags * 2)) {
    const multiplier = categoryMultipliers[current.category] ?? 1;
    if (current.similarity < absoluteMinimum * multiplier) {
      continue;
    }
    if (current.similarity < candidates[0].similarity * 0.6) {
      break;
    }
    const previous = selected.at(-1);
    if (
      selected.length >= 3 &&
      previous &&
      previous.similarity - current.similarity > 0.08
    ) {
      break;
    }
    selected.push(current);
    if (selected.length >= maxTags) {
      break;
    }
  }

  return selected.map((score) => ({
    tag: score.displayName,
    confidence: Math.round(score.similarity * 100) / 100,
    category: score.category,
  }));
}

function selectSiglipTags<TCategory extends string>(
  scores: TagScore<TCategory>[],
  maxTags: number,
  model: EmbeddingModelConfig
): SelectedTag<TCategory>[] {
  const policy = model.scoring.tag;
  if (!(policy && scores.length > 0)) {
    return [];
  }

  const sorted = [...scores]
    .filter((score) => Number.isFinite(score.similarity))
    .sort((left, right) => right.similarity - left.similarity);
  if (sorted.length === 0) {
    return [];
  }

  const top = sorted[0].similarity;
  const scoreMedian = median(sorted.map((score) => score.similarity));
  if (top < policy.topMinimum || top - scoreMedian < policy.topFromMedian) {
    return [];
  }

  const cutoff = Math.max(
    top - policy.candidateFromTop,
    scoreMedian + policy.candidateFromMedian
  );
  const confidenceRange = policy.confidenceMax - policy.confidenceMin;
  const denominator = Math.max(top - cutoff, Number.EPSILON);
  const selected: SelectedTag<TCategory>[] = [];
  const usedCategories = new Set<TCategory>();

  for (const score of sorted) {
    if (score.similarity < cutoff || usedCategories.has(score.category)) {
      continue;
    }
    const relative = clamp((score.similarity - cutoff) / denominator, 0, 1);
    selected.push({
      tag: score.displayName,
      confidence:
        Math.round((policy.confidenceMin + relative * confidenceRange) * 100) /
        100,
      category: score.category,
    });
    usedCategories.add(score.category);
    if (selected.length >= maxTags) {
      break;
    }
  }

  return selected;
}

export function selectTagScores<TCategory extends string>(
  scores: TagScore<TCategory>[],
  maxTags: number,
  model: EmbeddingModelConfig
): SelectedTag<TCategory>[] {
  return model.kind === "siglip"
    ? selectSiglipTags(scores, maxTags, model)
    : selectClipTags(scores, maxTags);
}

export function isValidEmbeddingVector(
  vector: number[],
  model: Pick<EmbeddingModelConfig, "vectorDimensions">
): boolean {
  return (
    vector.length === model.vectorDimensions &&
    vector.every((value) => Number.isFinite(value))
  );
}

export function getTagEmbeddingCacheKey(
  modelKind: EmbeddingModelKind,
  promptVersion: number
): string {
  return `${modelKind}:tags-v${promptVersion}`;
}

export function filterCosineSearchResults(
  results: Array<{ distance: number; photoId: number }>,
  maxDistance: number,
  limit: number
): Array<{ photoId: number; similarity: number }> {
  return results
    .filter(
      ({ distance, photoId }) =>
        Number.isFinite(distance) &&
        Number.isFinite(photoId) &&
        distance <= maxDistance
    )
    .slice(0, limit)
    .map(({ distance, photoId }) => ({
      photoId,
      similarity: Math.round((1 - distance) * 10_000) / 10_000,
    }));
}

export interface FusedRankedSearchResult {
  photoId: number;
  rankScore: number;
  similarity: number;
}

export function fuseRankedSearchEvidence(
  resultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  weights: number[] = [1, 0.7, 0.5]
): FusedRankedSearchResult[] {
  const reciprocalRankConstant = 60;
  const scores = new Map<
    number,
    { bestSimilarity: number; rankScore: number }
  >();

  for (let index = 0; index < resultSets.length; index++) {
    const weight = weights[Math.min(index, weights.length - 1)];
    for (let rank = 0; rank < resultSets[index].length; rank++) {
      const { photoId, similarity } = resultSets[index][rank];
      const current = scores.get(photoId) ?? {
        bestSimilarity: Number.NEGATIVE_INFINITY,
        rankScore: 0,
      };
      current.rankScore += weight / (reciprocalRankConstant + rank + 1);
      current.bestSimilarity = Math.max(current.bestSimilarity, similarity);
      scores.set(photoId, current);
    }
  }

  return [...scores.entries()]
    .sort(
      (left, right) =>
        right[1].rankScore - left[1].rankScore ||
        right[1].bestSimilarity - left[1].bestSimilarity ||
        left[0] - right[0]
    )
    .slice(0, limit)
    .map(([photoId, score]) => ({
      photoId,
      rankScore: score.rankScore,
      similarity: Math.round(score.bestSimilarity * 10_000) / 10_000,
    }));
}

export function fuseRankedSearchResults(
  resultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  weights: number[] = [1, 0.7, 0.5]
): Array<{ photoId: number; similarity: number }> {
  return fuseRankedSearchEvidence(resultSets, limit, weights).map(
    ({ photoId, similarity }) => ({ photoId, similarity })
  );
}

export function applyNegativeSemanticPenalty(
  positiveResults: FusedRankedSearchResult[],
  negativeResultSets: Array<
    Array<{ photoId: number; similarity: number }>
  >,
  limit: number,
  penaltyWeight = 0.25
): FusedRankedSearchResult[] {
  if (negativeResultSets.length === 0) {
    return positiveResults.slice(0, limit);
  }

  const reciprocalRankConstant = 60;
  const negativeSimilarity = new Map<number, number>();
  const negativeRankScore = new Map<number, number>();
  for (const resultSet of negativeResultSets) {
    for (let rank = 0; rank < resultSet.length; rank++) {
      const result = resultSet[rank];
      negativeSimilarity.set(
        result.photoId,
        Math.max(negativeSimilarity.get(result.photoId) ?? 0, result.similarity)
      );
      negativeRankScore.set(
        result.photoId,
        Math.max(
          negativeRankScore.get(result.photoId) ?? 0,
          1 / (reciprocalRankConstant + rank + 1)
        )
      );
    }
  }

  return positiveResults
    .map((result) => ({
      photoId: result.photoId,
      rankScore:
        result.rankScore -
        penaltyWeight * (negativeRankScore.get(result.photoId) ?? 0),
      similarity:
        Math.round(
          Math.max(
            0,
            result.similarity -
              penaltyWeight *
                (negativeSimilarity.get(result.photoId) ?? 0)
          ) * 10_000
        ) / 10_000,
    }))
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        right.similarity - left.similarity ||
        left.photoId - right.photoId
    )
    .slice(0, limit);
}
