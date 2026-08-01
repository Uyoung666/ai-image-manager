import {
  type EmbeddingModelConfig,
  type EmbeddingModelKind,
  getSemanticPolicyVersion,
} from "./model-config";
import type {
  SemanticEvidenceGroup,
  SemanticQueryIntent,
} from "./semantic-query-plan";

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
  return selectSiglipTags(scores, maxTags, model);
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
  primarySimilarity: number;
  rankScore: number;
  similarity: number;
  supportingGroups: SemanticEvidenceGroup[];
}

export function fuseRankedSearchEvidence(
  resultSets: Array<Array<{ photoId: number; similarity: number }>>,
  limit: number,
  weights: number[] = [1, 0.7, 0.5],
  evidenceGroups: SemanticEvidenceGroup[] = resultSets.map(
    (_, index) => `prompt-${index}` as SemanticEvidenceGroup
  ),
  primaryPromptIndex = 0
): FusedRankedSearchResult[] {
  const reciprocalRankConstant = 60;
  const scores = new Map<
    number,
    {
      bestSimilarity: number;
      groups: Map<
        SemanticEvidenceGroup,
        { rankScore: number; similarity: number }
      >;
      primarySimilarity: number;
    }
  >();

  for (let index = 0; index < resultSets.length; index++) {
    const weight = weights[Math.min(index, weights.length - 1)];
    const evidenceGroup = evidenceGroups[index] ?? evidenceGroups[0];
    for (let rank = 0; rank < resultSets[index].length; rank++) {
      const { photoId, similarity } = resultSets[index][rank];
      const current = scores.get(photoId) ?? {
        bestSimilarity: Number.NEGATIVE_INFINITY,
        groups: new Map(),
        primarySimilarity: Number.NEGATIVE_INFINITY,
      };
      const contribution = weight / (reciprocalRankConstant + rank + 1);
      const existingGroup = current.groups.get(evidenceGroup);
      if (
        !existingGroup ||
        contribution > existingGroup.rankScore ||
        (contribution === existingGroup.rankScore &&
          similarity > existingGroup.similarity)
      ) {
        current.groups.set(evidenceGroup, {
          rankScore: contribution,
          similarity,
        });
      }
      current.bestSimilarity = Math.max(current.bestSimilarity, similarity);
      if (index === primaryPromptIndex) {
        current.primarySimilarity = Math.max(
          current.primarySimilarity,
          similarity
        );
      }
      scores.set(photoId, current);
    }
  }

  return [...scores.entries()]
    .sort(
      (left, right) =>
        [...right[1].groups.values()].reduce(
          (sum, group) => sum + group.rankScore,
          0
        ) -
          [...left[1].groups.values()].reduce(
            (sum, group) => sum + group.rankScore,
            0
          ) ||
        right[1].bestSimilarity - left[1].bestSimilarity ||
        left[0] - right[0]
    )
    .slice(0, limit)
    .map(([photoId, score]) => {
      const primarySimilarity = Number.isFinite(score.primarySimilarity)
        ? score.primarySimilarity
        : score.bestSimilarity;
      return {
        photoId,
        primarySimilarity: Math.round(primarySimilarity * 10_000) / 10_000,
        rankScore: [...score.groups.values()].reduce(
          (sum, group) => sum + group.rankScore,
          0
        ),
        similarity: Math.round(score.bestSimilarity * 10_000) / 10_000,
        supportingGroups: [...score.groups.keys()],
      };
    });
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
  negativeResultSets: Array<Array<{ photoId: number; similarity: number }>>,
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
      primarySimilarity:
        Math.round(
          Math.max(
            0,
            result.primarySimilarity -
              penaltyWeight * (negativeSimilarity.get(result.photoId) ?? 0)
          ) * 10_000
        ) / 10_000,
      rankScore:
        result.rankScore -
        penaltyWeight * (negativeRankScore.get(result.photoId) ?? 0),
      similarity:
        Math.round(
          Math.max(
            0,
            result.similarity -
              penaltyWeight * (negativeSimilarity.get(result.photoId) ?? 0)
          ) * 10_000
        ) / 10_000,
      supportingGroups: result.supportingGroups,
    }))
    .sort(
      (left, right) =>
        right.rankScore - left.rankScore ||
        right.similarity - left.similarity ||
        left.photoId - right.photoId
    )
    .slice(0, limit);
}

export interface SemanticRelevanceSelection {
  acceptedCount: number;
  canContinue: boolean;
  candidateMinimum: number;
  consensusCutoff: number;
  cutoffReason: string;
  finalCutoff: number;
  hasMoreCandidates: boolean;
  rejectedWeak: number;
  results: FusedRankedSearchResult[];
  strongAccepted: number;
  strongCutoff: number;
  supportCandidates: FusedRankedSearchResult[];
  supportCutoff: number;
  supportedAccepted: number;
  topSimilarity: number;
}

export interface SemanticRelevanceOptions {
  candidateTails?: Array<{
    evidenceGroup: SemanticEvidenceGroup;
    similarity: number;
  }>;
  intent?: SemanticQueryIntent;
  primaryScores?: number[];
  promptGroupCount?: number;
}

export function calculateScoreGapCutoff(
  primaryScores: number[]
): number | null {
  const scores = primaryScores
    .filter(Number.isFinite)
    .slice(0, 100)
    .sort((left, right) => right - left);
  if (scores.length < 6) {
    return null;
  }
  const span = scores[0] - (scores.at(-1) ?? scores[0]);
  let largestGap = 0;
  let cutoff: number | null = null;
  for (let index = 4; index < scores.length - 1; index++) {
    const gap = scores[index] - scores[index + 1];
    if (gap > largestGap) {
      largestGap = gap;
      cutoff = (scores[index] + scores[index + 1]) / 2;
    }
  }
  return largestGap >= 0.006 && largestGap >= span * 0.12 ? cutoff : null;
}

function selectLegacySemanticResults(
  results: FusedRankedSearchResult[],
  policy: NonNullable<EmbeddingModelConfig["scoring"]["semanticSearch"]>,
  promptGroupCount: number,
  limit: number,
  candidateTails: SemanticRelevanceOptions["candidateTails"]
): SemanticRelevanceSelection {
  const topSimilarity = Math.max(...results.map((result) => result.similarity));
  const strongCutoff = Math.max(
    policy.absoluteMinimumSimilarity,
    topSimilarity * policy.relativeToTopRatio
  );
  const consensusCutoff = Math.max(
    policy.candidateMinimumSimilarity,
    strongCutoff * policy.consensusThresholdRatio
  );
  const relevant = results.filter(
    (result) =>
      result.similarity >= strongCutoff ||
      (promptGroupCount > 1 &&
        result.supportingGroups.length >= 2 &&
        result.similarity >= consensusCutoff)
  );
  const tails = candidateTails ?? [];
  const strongTail = tails.some(({ similarity }) => similarity >= strongCutoff);
  const consensusTailGroups = new Set(
    tails
      .filter(({ similarity }) => similarity >= consensusCutoff)
      .map(({ evidenceGroup }) => evidenceGroup)
  );
  const canContinue =
    strongTail || (promptGroupCount > 1 && consensusTailGroups.size >= 2);
  const strongAccepted = relevant.filter(
    (result) => result.similarity >= strongCutoff
  ).length;
  return {
    acceptedCount: relevant.length,
    candidateMinimum: policy.candidateMinimumSimilarity,
    canContinue,
    consensusCutoff,
    cutoffReason: "legacy",
    finalCutoff: strongCutoff,
    hasMoreCandidates: relevant.length > limit || canContinue,
    rejectedWeak: results.length - relevant.length,
    results: relevant.slice(0, limit),
    supportCandidates: relevant.slice(0, limit),
    supportCutoff: consensusCutoff,
    strongAccepted,
    strongCutoff,
    supportedAccepted: relevant.length - strongAccepted,
    topSimilarity,
  };
}

interface IntentCutoffPolicy {
  base: number;
  ratio: number;
  supportFloor?: number;
  supportRatio?: number;
}

const INTENT_CUTOFF_POLICIES: Record<SemanticQueryIntent, IntentCutoffPolicy> =
  {
    object: { base: 0.055, ratio: 0.6 },
    composed: {
      base: 0.045,
      ratio: 0.5,
      supportFloor: 0.04,
      supportRatio: 0.9,
    },
    scene: {
      base: 0.035,
      ratio: 0.4,
      supportFloor: 0.03,
      supportRatio: 0.85,
    },
    unknown: { base: 0.05, ratio: 0.55 },
  };

function getCutoffReason(
  gapCutoff: number | null,
  base: number,
  relativeCutoff: number
): string {
  if (gapCutoff !== null && gapCutoff >= base && gapCutoff >= relativeCutoff) {
    return "score-gap";
  }
  return relativeCutoff >= base ? "relative-to-top" : "intent-floor";
}

function hasIndependentSupport(result: FusedRankedSearchResult): boolean {
  return (
    result.supportingGroups.includes("whole-query") &&
    new Set(result.supportingGroups).size >= 2
  );
}

function selectV2SemanticResults(
  results: FusedRankedSearchResult[],
  policy: NonNullable<EmbeddingModelConfig["scoring"]["semanticSearch"]>,
  limit: number,
  options: SemanticRelevanceOptions
): SemanticRelevanceSelection {
  const intent = options.intent ?? "unknown";
  const cutoffPolicy = INTENT_CUTOFF_POLICIES[intent];
  const primaryScores = options.primaryScores?.length
    ? options.primaryScores
    : results.map((result) => result.primarySimilarity);
  const topSimilarity = Math.max(...primaryScores);
  const gapCutoff =
    intent === "object" || intent === "unknown"
      ? calculateScoreGapCutoff(options.primaryScores ?? [])
      : null;
  const relativeCutoff = topSimilarity * cutoffPolicy.ratio;
  const strongCutoff = Math.max(
    cutoffPolicy.base,
    relativeCutoff,
    gapCutoff ?? 0
  );
  const supportsRelaxation =
    cutoffPolicy.supportFloor !== undefined &&
    cutoffPolicy.supportRatio !== undefined;
  const consensusCutoff = supportsRelaxation
    ? Math.max(
        cutoffPolicy.supportFloor ?? strongCutoff,
        strongCutoff * (cutoffPolicy.supportRatio ?? 1)
      )
    : strongCutoff;
  const supportCutoff =
    intent === "object" || intent === "unknown"
      ? Math.max(0.045, strongCutoff * 0.85)
      : consensusCutoff;
  const relevant = results.filter(
    (result) =>
      result.primarySimilarity >= strongCutoff ||
      (supportsRelaxation &&
        result.primarySimilarity >= consensusCutoff &&
        hasIndependentSupport(result))
  );
  const strongAccepted = relevant.filter(
    (result) => result.primarySimilarity >= strongCutoff
  ).length;
  const tails = options.candidateTails ?? [];
  const primaryTail =
    tails.find(({ evidenceGroup }) => evidenceGroup === "whole-query")
      ?.similarity ?? 0;
  const supportedTailGroups = new Set(
    tails
      .filter(({ similarity }) => similarity >= consensusCutoff)
      .map(({ evidenceGroup }) => evidenceGroup)
  );
  const canContinue =
    primaryTail >= supportCutoff ||
    (supportsRelaxation &&
      primaryTail >= consensusCutoff &&
      supportedTailGroups.size >= 2);

  return {
    acceptedCount: relevant.length,
    candidateMinimum: policy.candidateMinimumSimilarity,
    canContinue,
    consensusCutoff,
    cutoffReason: getCutoffReason(gapCutoff, cutoffPolicy.base, relativeCutoff),
    finalCutoff: strongCutoff,
    hasMoreCandidates: relevant.length > limit || canContinue,
    rejectedWeak: results.length - relevant.length,
    results: relevant.slice(0, limit),
    supportCandidates: results
      .filter((result) => result.primarySimilarity >= supportCutoff)
      .slice(0, limit),
    supportCutoff,
    strongAccepted,
    strongCutoff,
    supportedAccepted: relevant.length - strongAccepted,
    topSimilarity,
  };
}

export function selectRelevantSemanticResults(
  results: FusedRankedSearchResult[],
  model: EmbeddingModelConfig,
  promptGroupCount: number,
  limit: number,
  options: SemanticRelevanceOptions = {}
): SemanticRelevanceSelection {
  const policy = model.scoring.semanticSearch;
  if (!(policy && results.length > 0)) {
    return {
      acceptedCount: results.length,
      candidateMinimum: Number.NEGATIVE_INFINITY,
      canContinue: false,
      cutoffReason: "model-without-policy",
      consensusCutoff: Number.NEGATIVE_INFINITY,
      finalCutoff: Number.NEGATIVE_INFINITY,
      hasMoreCandidates: results.length > limit,
      rejectedWeak: 0,
      results: results.slice(0, limit),
      supportCandidates: results.slice(0, limit),
      supportCutoff: 0,
      strongAccepted: results.length,
      strongCutoff: Number.NEGATIVE_INFINITY,
      supportedAccepted: 0,
      topSimilarity: results[0]?.similarity ?? 0,
    };
  }

  if (getSemanticPolicyVersion() === "legacy") {
    return selectLegacySemanticResults(
      results,
      policy,
      promptGroupCount,
      limit,
      options.candidateTails
    );
  }
  return selectV2SemanticResults(results, policy, limit, options);
}
