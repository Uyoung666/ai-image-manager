export type SearchEvidenceSource =
  | "person"
  | "tag"
  | "filename"
  | "autoTag"
  | "ai";

export interface ExactSearchEvidence {
  exact: boolean;
  photoId: number;
  source: Exclude<SearchEvidenceSource, "ai">;
}

export interface TagSearchEvidenceRow {
  confidence?: number | null;
  id: number;
  name: string;
  origin: "manual" | "auto";
  userConfirmed: boolean;
}

export type HybridEvidenceKind = "semantic" | "tag";

export interface GatedHybridOptions {
  acceptedSemanticPhotoIds: ReadonlySet<number>;
  intent: "object" | "scene" | "composed" | "unknown";
  promptGroupCount: number;
  strongCutoff: number;
  supportCutoff: number;
  topSimilarity: number;
}

export interface GatedHybridDiagnostics {
  autoTagRescued: number;
  ignoredLowConfidenceTags: number;
  manualExactAccepted: number;
  semanticOnlyAccepted: number;
  tagSupportedAccepted: number;
}

export interface GatedHybridResult extends HybridSearchResult {
  hybridEvidence: HybridEvidenceKind[];
  primarySimilarity: number;
  supportingGroups: string[];
  tagNames: string[];
  tagSupport: number;
}

export interface GatedHybridSearchResult {
  diagnostics: GatedHybridDiagnostics;
  results: GatedHybridResult[];
}

export function buildTagSearchEvidence(
  rows: TagSearchEvidenceRow[],
  semanticPhotoIds: ReadonlySet<number>,
  isFullMatch: (name: string) => boolean
): ExactSearchEvidence[] {
  return rows.flatMap<ExactSearchEvidence>((row): ExactSearchEvidence[] => {
    if (row.origin === "manual" || row.userConfirmed) {
      return [
        {
          exact: isFullMatch(row.name),
          photoId: row.id,
          source: "tag" as const,
        },
      ];
    }
    if (semanticPhotoIds.has(row.id)) {
      return [
        {
          exact: false,
          photoId: row.id,
          source: "autoTag" as const,
        },
      ];
    }
    return [];
  });
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
  primarySimilarity?: number;
  rankScore?: number;
  similarity: number;
  supportingGroups?: string[];
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
  autoTag: 0.25,
  personExact: 1.5,
  personPartial: 1.2,
  semantic: 1,
  tagExact: 1.25,
  tagPartial: 1,
} as const;

const AUTO_TAG_MINIMUM = 0.55;
const AUTO_TAG_RESCUE_MINIMUM = 0.75;
const SEMANTIC_WEIGHT = 0.7;
const TAG_WEIGHT = 0.3;

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function normalizeAutoTagStrength(confidence: number): number {
  return (
    Math.round(
      (0.5 + 0.5 * clamp01((confidence - AUTO_TAG_MINIMUM) / 0.4)) * 10_000
    ) / 10_000
  );
}

function hasRequiredComposedCoverage(
  supportingGroups: string[],
  promptGroupCount: number
): boolean {
  const groups = new Set(supportingGroups);
  return (
    groups.has("whole-query") && groups.size >= Math.max(2, promptGroupCount)
  );
}

/**
 * hybrid-v3 admission and calibration. Raw SigLIP cosine values are only
 * normalized within this query; trusted exact labels form a separate tier.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: admission intentionally centralizes the hybrid policy so thresholds cannot diverge across branches
export function fuseGatedHybridSearchEvidence(
  semanticCandidates: RankedSemanticResult[],
  exactResults: ExactSearchEvidence[],
  tagRows: TagSearchEvidenceRow[],
  options: GatedHybridOptions
): GatedHybridSearchResult {
  const tagEvidence = new Map<
    number,
    {
      autoConfidence: number;
      names: Set<string>;
      strength: number;
      trusted: boolean;
      trustedExact: boolean;
    }
  >();
  let ignoredLowConfidenceTags = 0;

  for (const row of tagRows) {
    const current = tagEvidence.get(row.id) ?? {
      autoConfidence: 0,
      names: new Set<string>(),
      strength: 0,
      trusted: false,
      trustedExact: false,
    };
    current.names.add(row.name);
    if (row.origin === "manual" || row.userConfirmed) {
      current.trusted = true;
      current.strength = 1;
    } else {
      const confidence = row.confidence ?? 0;
      if (confidence < AUTO_TAG_MINIMUM) {
        ignoredLowConfidenceTags++;
      } else {
        current.autoConfidence = Math.max(current.autoConfidence, confidence);
        current.strength = Math.max(
          current.strength,
          normalizeAutoTagStrength(confidence)
        );
      }
    }
    tagEvidence.set(row.id, current);
  }

  for (const exact of exactResults) {
    if (exact.source !== "tag") {
      continue;
    }
    const current = tagEvidence.get(exact.photoId);
    if (current?.trusted && exact.exact) {
      current.trustedExact = true;
    }
  }

  const exactByPhoto = new Map<number, ExactSearchEvidence[]>();
  for (const exact of exactResults) {
    const rows = exactByPhoto.get(exact.photoId) ?? [];
    if (
      !rows.some(
        (row) => row.source === exact.source && row.exact === exact.exact
      )
    ) {
      rows.push(exact);
      exactByPhoto.set(exact.photoId, rows);
    }
  }

  const candidatesByPhoto = new Map<number, RankedSemanticResult>();
  for (const candidate of semanticCandidates) {
    const previous = candidatesByPhoto.get(candidate.photoId);
    if (
      !previous ||
      (candidate.primarySimilarity ?? candidate.similarity) >
        (previous.primarySimilarity ?? previous.similarity)
    ) {
      candidatesByPhoto.set(candidate.photoId, candidate);
    }
  }

  const photoIds = new Set([
    ...candidatesByPhoto.keys(),
    ...exactByPhoto.keys(),
  ]);
  const results: GatedHybridResult[] = [];
  const diagnostics: GatedHybridDiagnostics = {
    autoTagRescued: 0,
    ignoredLowConfidenceTags,
    manualExactAccepted: 0,
    semanticOnlyAccepted: 0,
    tagSupportedAccepted: 0,
  };
  const semanticRange = Math.max(
    0.0001,
    options.topSimilarity - options.supportCutoff
  );

  for (const photoId of photoIds) {
    const semantic = candidatesByPhoto.get(photoId);
    const exact = exactByPhoto.get(photoId) ?? [];
    const tagsForPhoto = tagEvidence.get(photoId);
    const trustedTagExact =
      tagsForPhoto?.trustedExact ||
      exact.some((row) => row.source === "tag" && row.exact);
    const independentExact = exact.some(
      (row) =>
        row.source !== "autoTag" &&
        (row.source !== "tag" || (row.exact && tagsForPhoto?.trusted))
    );
    const primarySimilarity =
      semantic?.primarySimilarity ?? semantic?.similarity ?? 0;
    const isStrong =
      Boolean(semantic) &&
      (options.acceptedSemanticPhotoIds.has(photoId) ||
        primarySimilarity >= options.strongCutoff);
    const composedCoverage =
      options.intent !== "composed" ||
      hasRequiredComposedCoverage(
        semantic?.supportingGroups ?? [],
        options.promptGroupCount
      );
    const reliableTagSupport = Boolean(
      tagsForPhoto?.trusted ||
        (tagsForPhoto?.autoConfidence ?? 0) >= AUTO_TAG_RESCUE_MINIMUM
    );
    const isTagRescued =
      Boolean(semantic) &&
      !isStrong &&
      primarySimilarity >= options.supportCutoff &&
      reliableTagSupport &&
      composedCoverage;

    if (!(independentExact || isStrong || isTagRescued)) {
      continue;
    }

    const hasUsableTag =
      Boolean(tagsForPhoto?.trusted) ||
      (tagsForPhoto?.autoConfidence ?? 0) >= AUTO_TAG_MINIMUM;
    const tagSupport = hasUsableTag ? (tagsForPhoto?.strength ?? 0) : 0;
    const normalizedSemantic = semantic
      ? clamp01((primarySimilarity - options.supportCutoff) / semanticRange)
      : 0;
    const exactBonus = exact.reduce(
      (best, row) => Math.max(best, exactEvidenceWeight(row)),
      0
    );
    const hybridScore =
      SEMANTIC_WEIGHT * normalizedSemantic +
      TAG_WEIGHT * tagSupport +
      exactBonus;
    const sources = new Set<SearchEvidenceSource>(
      exact.map((row) => row.source)
    );
    if (semantic) {
      sources.add("ai");
    }
    if (hasUsableTag && !tagsForPhoto?.trusted) {
      sources.add("autoTag");
    }

    if (trustedTagExact) {
      diagnostics.manualExactAccepted++;
    } else if (isTagRescued) {
      diagnostics.tagSupportedAccepted++;
      if (!tagsForPhoto?.trusted) {
        diagnostics.autoTagRescued++;
      }
    } else if (semantic && hasUsableTag) {
      diagnostics.tagSupportedAccepted++;
    } else if (semantic) {
      diagnostics.semanticOnlyAccepted++;
    }

    const hybridEvidence: HybridEvidenceKind[] = [];
    if (semantic) {
      hybridEvidence.push("semantic");
    }
    if (hasUsableTag || trustedTagExact) {
      hybridEvidence.push("tag");
    }
    results.push({
      _source: bestSource(sources),
      evidence: [...sources].sort(
        (left, right) => sourcePriority(right) - sourcePriority(left)
      ),
      exact: trustedTagExact || exact.some((row) => row.exact),
      hybridEvidence,
      photoId,
      primarySimilarity,
      rankScore: hybridScore,
      similarity: semantic?.similarity ?? (independentExact ? 1 : 0),
      supportingGroups: semantic?.supportingGroups ?? [],
      tagNames: [...(tagsForPhoto?.names ?? [])],
      tagSupport,
    });
  }

  results.sort(
    (left, right) =>
      Number(
        right.exact &&
          (right.evidence.includes("tag") || right.evidence.includes("person"))
      ) -
        Number(
          left.exact &&
            (left.evidence.includes("tag") || left.evidence.includes("person"))
        ) ||
      right.rankScore - left.rankScore ||
      Number(right.supportingGroups.includes("whole-query")) -
        Number(left.supportingGroups.includes("whole-query")) ||
      right.supportingGroups.length - left.supportingGroups.length ||
      right.primarySimilarity - left.primarySimilarity ||
      left.photoId - right.photoId
  );

  return { diagnostics, results };
}

function sourcePriority(source: SearchEvidenceSource): number {
  switch (source) {
    case "person":
      return 4;
    case "tag":
      return 3;
    case "filename":
      return 2;
    case "autoTag":
      return 0;
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
  if (result.source === "autoTag") {
    return SOURCE_WEIGHTS.autoTag;
  }
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
