export type SearchEvidenceSource = "person" | "tag" | "filename" | "ai";

export interface ExactSearchEvidence {
  exact: boolean;
  photoId: number;
  source: Exclude<SearchEvidenceSource, "ai">;
}

export interface HybridSearchResult {
  _source: SearchEvidenceSource;
  evidence: SearchEvidenceSource[];
  exact: boolean;
  photoId: number;
  rankScore: number;
  similarity: number;
}

interface RankedSemanticResult {
  photoId: number;
  rankScore?: number;
  similarity: number;
}

interface MutableEvidence {
  bestSemanticSimilarity: number;
  exact: boolean;
  rankScore: number;
  sources: Set<SearchEvidenceSource>;
}

const RRF_K = 60;
const SOURCE_WEIGHTS = {
  filename: 0.8,
  personExact: 1.5,
  personPartial: 1.2,
  semantic: 1,
  tagExact: 1.25,
  tagPartial: 1,
} as const;

function sourcePriority(source: SearchEvidenceSource): number {
  switch (source) {
    case "person":
      return 4;
    case "tag":
      return 3;
    case "filename":
      return 2;
    default:
      return 1;
  }
}

function bestSource(sources: Set<SearchEvidenceSource>): SearchEvidenceSource {
  return [...sources].sort(
    (left, right) => sourcePriority(right) - sourcePriority(left)
  )[0];
}

function mutableEvidence(
  evidence: Map<number, MutableEvidence>,
  photoId: number
): MutableEvidence {
  const existing = evidence.get(photoId);
  if (existing) {
    return existing;
  }
  const created: MutableEvidence = {
    bestSemanticSimilarity: 0,
    exact: false,
    rankScore: 0,
    sources: new Set(),
  };
  evidence.set(photoId, created);
  return created;
}

function addRrf(target: MutableEvidence, weight: number, rank = 0): void {
  target.rankScore += weight / (RRF_K + rank + 1);
}

function exactEvidenceWeight(result: ExactSearchEvidence): number {
  if (result.source === "person") {
    return result.exact
      ? SOURCE_WEIGHTS.personExact
      : SOURCE_WEIGHTS.personPartial;
  }
  if (result.source === "tag") {
    return result.exact ? SOURCE_WEIGHTS.tagExact : SOURCE_WEIGHTS.tagPartial;
  }
  return SOURCE_WEIGHTS.filename;
}

/**
 * Fuse semantic and exact retrieval evidence without mixing incomparable raw
 * scores. Exact rows receive a source weight; semantic rows retain their rank
 * and raw cosine only as a deterministic tie-break/display value.
 */
export function fuseHybridSearchEvidence(
  semanticResults: RankedSemanticResult[],
  exactResults: ExactSearchEvidence[],
  topK: number
): HybridSearchResult[] {
  const evidence = new Map<number, MutableEvidence>();

  for (let rank = 0; rank < semanticResults.length; rank++) {
    const result = semanticResults[rank];
    const target = mutableEvidence(evidence, result.photoId);
    target.sources.add("ai");
    target.bestSemanticSimilarity = Math.max(
      target.bestSemanticSimilarity,
      result.similarity
    );
    if (result.rankScore === undefined) {
      addRrf(target, SOURCE_WEIGHTS.semantic, rank);
    } else {
      target.rankScore += result.rankScore;
    }
  }

  const seenExact = new Set<string>();
  for (const result of exactResults) {
    const key = `${result.source}:${result.photoId}:${result.exact}`;
    if (seenExact.has(key)) {
      continue;
    }
    seenExact.add(key);
    const target = mutableEvidence(evidence, result.photoId);
    target.sources.add(result.source);
    target.exact ||= result.exact;
    addRrf(target, exactEvidenceWeight(result));
  }

  const ranked = [...evidence.entries()].sort(
    (left, right) =>
      right[1].rankScore - left[1].rankScore ||
      Number(right[1].exact) - Number(left[1].exact) ||
      right[1].bestSemanticSimilarity - left[1].bestSemanticSimilarity ||
      left[0] - right[0]
  );
  const maxRankScore = ranked[0]?.[1].rankScore || 1;

  return ranked.slice(0, topK).map(([photoId, score]) => ({
    _source: bestSource(score.sources),
    evidence: [...score.sources].sort(
      (left, right) => sourcePriority(right) - sourcePriority(left)
    ),
    exact: score.exact,
    photoId,
    rankScore: score.rankScore,
    similarity:
      Math.round(
        (score.bestSemanticSimilarity ||
          (score.exact ? 1 : score.rankScore / maxRankScore)) * 10_000
      ) / 10_000,
  }));
}

/**
 * Compatibility wrapper for older callers. It intentionally performs no text
 * embedding; candidates are treated as the already-ranked semantic list.
 */
export function rerankWithCLIPScore(
  _query: string,
  candidates: Array<{
    _source?: SearchEvidenceSource;
    photoId: number;
    similarity: number;
  }>,
  topK = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  const semantic = candidates.filter(
    (candidate) => !candidate._source || candidate._source === "ai"
  );
  const exact: ExactSearchEvidence[] = candidates
    .filter(
      (
        candidate
      ): candidate is typeof candidate & {
        _source: Exclude<SearchEvidenceSource, "ai">;
      } => Boolean(candidate._source && candidate._source !== "ai")
    )
    .map((candidate) => ({
      exact: true,
      photoId: candidate.photoId,
      source: candidate._source,
    }));
  return Promise.resolve(
    fuseHybridSearchEvidence(semantic, exact, topK).map(
      ({ photoId, similarity }) => ({ photoId, similarity })
    )
  );
}
