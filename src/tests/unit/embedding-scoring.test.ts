import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveEmbeddingModel,
  getTextSearchMaxCosineDistance,
} from "@/services/ai/model-config";
import {
  applyNegativeSemanticPenalty,
  filterCosineSearchResults,
  fuseRankedSearchEvidence,
  fuseRankedSearchResults,
  isValidEmbeddingVector,
  selectRelevantSemanticResults,
  selectTagScores,
} from "@/services/ai/scoring";
import { CANDIDATE_TAGS } from "@/services/ai/tag-suggester";

const originalModel = process.env.AI_EMBEDDING_MODEL;
const originalPolicy = process.env.AI_SEMANTIC_POLICY;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.AI_EMBEDDING_MODEL;
  } else {
    process.env.AI_EMBEDDING_MODEL = originalModel;
  }
  if (originalPolicy === undefined) {
    delete process.env.AI_SEMANTIC_POLICY;
  } else {
    process.env.AI_SEMANTIC_POLICY = originalPolicy;
  }
});

describe("SigLIP scoring policy", () => {
  it("uses SigLIP-specific text search distances", () => {
    delete process.env.AI_EMBEDDING_MODEL;
    const model = getActiveEmbeddingModel();

    expect(getTextSearchMaxCosineDistance(0, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "en")).toBe(0.98);
    expect(model.scoring.duplicateConfirmationSimilarity).toBe(0.95);
  });

  it("keeps the SigLIP distance policy when the removed CLIP selector is set", () => {
    process.env.AI_EMBEDDING_MODEL = "clip";

    expect(getTextSearchMaxCosineDistance(0, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "zh")).toBe(0.98);
    expect(getTextSearchMaxCosineDistance(1, "en")).toBe(0.98);
  });

  it("selects separated SigLIP tags, limits categories, and calibrates confidence", () => {
    delete process.env.AI_EMBEDDING_MODEL;
    const model = getActiveEmbeddingModel();
    const selected = selectTagScores(
      [
        { category: "activity", displayName: "阅读", similarity: 0.09 },
        { category: "activity", displayName: "学习", similarity: 0.08 },
        { category: "subject", displayName: "人物", similarity: 0.065 },
        { category: "scene", displayName: "户外", similarity: 0.045 },
        { category: "style", displayName: "复古", similarity: 0.005 },
        { category: "color", displayName: "蓝色调", similarity: -0.01 },
        ...Array.from({ length: 20 }, (_, index) => ({
          category: "weather",
          displayName: `低分候选${index}`,
          similarity: -0.02,
        })),
      ],
      5,
      model
    );

    expect(selected.map((tag) => tag.tag)).toEqual(["阅读", "人物"]);
    expect(selected[0].confidence).toBe(0.95);
    expect(selected[1].confidence).toBeGreaterThanOrEqual(0.55);
    expect(selected.every((tag) => tag.confidence <= 0.95)).toBe(true);
  });

  it("returns no SigLIP tags when the score distribution is not separated", () => {
    delete process.env.AI_EMBEDDING_MODEL;

    expect(
      selectTagScores(
        [
          { category: "scene", displayName: "室内", similarity: 0.03 },
          { category: "object", displayName: "书籍", similarity: 0.025 },
          { category: "style", displayName: "极简", similarity: 0.02 },
        ],
        5,
        getActiveEmbeddingModel()
      )
    ).toEqual([]);
  });

  it("validates active-model vector dimensions and finite values", () => {
    const model = getActiveEmbeddingModel();

    expect(
      isValidEmbeddingVector(
        Array.from({ length: model.vectorDimensions }, () => 0),
        model
      )
    ).toBe(true);
    expect(isValidEmbeddingVector([0, 1], model)).toBe(false);
    expect(
      isValidEmbeddingVector(
        [
          Number.NaN,
          ...Array.from({ length: model.vectorDimensions - 1 }, () => 0),
        ],
        model
      )
    ).toBe(false);
  });
});

describe("embedding prompts and ranked fusion", () => {
  it("provides a curated SigLIP label for every candidate tag", () => {
    const expectedCategoryCounts = {
      activity: 15,
      animal: 12,
      color: 10,
      lighting: 10,
      object: 20,
      scene: 26,
      style: 18,
      subject: 15,
      weather: 6,
    };
    const actualCategoryCounts = Object.fromEntries(
      Object.keys(expectedCategoryCounts).map((category) => [
        category,
        CANDIDATE_TAGS.filter((tag) => tag.category === category).length,
      ])
    );

    expect(CANDIDATE_TAGS).toHaveLength(132);
    expect(actualCategoryCounts).toEqual(expectedCategoryCounts);
    expect(
      CANDIDATE_TAGS.every((tag) => tag.siglipLabel.trim().length > 0)
    ).toBe(true);
    expect(
      CANDIDATE_TAGS.find((tag) => tag.en === "reading studying book learning")
        ?.siglipLabel
    ).toBe("a person reading a book");
  });

  it("sorts by fused rank but exposes the best raw cosine similarity", () => {
    const fused = fuseRankedSearchResults(
      [
        [
          { photoId: 1, similarity: 0.09 },
          { photoId: 2, similarity: 0.08 },
        ],
        [
          { photoId: 2, similarity: 0.11 },
          { photoId: 3, similarity: 0.07 },
        ],
      ],
      3
    );

    expect(fused[0]).toEqual({ photoId: 2, similarity: 0.11 });
    expect(fused.find((result) => result.photoId === 1)?.similarity).toBe(0.09);
  });

  it("filters SigLIP text results at distance 0.98 and keeps raw cosine scores", () => {
    expect(
      filterCosineSearchResults(
        [
          { distance: 0.97, photoId: 1 },
          { distance: 0.98, photoId: 2 },
          { distance: 0.981, photoId: 3 },
        ],
        0.98,
        10
      )
    ).toEqual([
      { photoId: 1, similarity: 0.03 },
      { photoId: 2, similarity: 0.02 },
    ]);
  });

  it("uses the object floor and rejects weak camera-like candidates", () => {
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.0916,
          rankScore: 0.03,
          similarity: 0.0916,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 2,
          primarySimilarity: 0.0527,
          rankScore: 0.02,
          similarity: 0.0527,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 3,
          primarySimilarity: 0.0482,
          rankScore: 0.01,
          similarity: 0.0482,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 4,
          primarySimilarity: 0.0427,
          rankScore: 0.005,
          similarity: 0.0427,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100,
      {
        intent: "object",
        primaryScores: [0.0916, 0.08, 0.07, 0.065, 0.06, 0.0527, 0.0482],
      }
    );

    expect(selection.strongCutoff).toBeGreaterThanOrEqual(0.055);
    expect(selection.results.map((result) => result.photoId)).toEqual([1]);
    expect(selection.supportCandidates.map((result) => result.photoId)).toEqual([
      1, 2, 3,
    ]);
    expect(selection.supportCutoff).toBeGreaterThan(0.045);
    expect(selection.rejectedWeak).toBe(3);
    expect(selection.hasMoreCandidates).toBe(false);
  });

  it("continues broad scene retrieval while the primary tail remains eligible", () => {
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.1,
          rankScore: 0.03,
          similarity: 0.1,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100,
      {
        candidateTails: [{ evidenceGroup: "whole-query", similarity: 0.05 }],
        intent: "scene",
        primaryScores: [0.1],
      }
    );

    expect(selection.hasMoreCandidates).toBe(true);
  });

  it("does not double-count duplicate prompts in one evidence group", () => {
    const fused = fuseRankedSearchEvidence(
      [[{ photoId: 1, similarity: 0.09 }], [{ photoId: 1, similarity: 0.12 }]],
      10,
      [1, 0.75],
      ["whole-query", "whole-query"]
    );

    expect(fused[0].supportingGroups).toEqual(["whole-query"]);
    expect(fused[0].rankScore).toBeCloseTo(1 / 61);
    expect(fused[0].primarySimilarity).toBe(0.09);
  });

  it("supports the legacy semantic policy rollback switch", () => {
    process.env.AI_SEMANTIC_POLICY = "legacy";
    const selection = selectRelevantSemanticResults(
      [
        {
          photoId: 1,
          primarySimilarity: 0.1,
          rankScore: 0.03,
          similarity: 0.1,
          supportingGroups: ["whole-query"],
        },
        {
          photoId: 2,
          primarySimilarity: 0.041,
          rankScore: 0.02,
          similarity: 0.041,
          supportingGroups: ["whole-query"],
        },
      ],
      getActiveEmbeddingModel(),
      1,
      100
    );

    expect(selection.cutoffReason).toBe("legacy");
    expect(selection.strongCutoff).toBeCloseTo(0.04);
    expect(selection.results.map(({ photoId }) => photoId)).toEqual([1, 2]);
  });

  it("只在正向召回候选上应用 0.25 否定惩罚", () => {
    const positive = fuseRankedSearchEvidence(
      [
        [
          { photoId: 1, similarity: 0.2 },
          { photoId: 2, similarity: 0.19 },
        ],
      ],
      10,
      [1]
    );
    const reranked = applyNegativeSemanticPenalty(
      positive,
      [[{ photoId: 1, similarity: 0.2 }]],
      10
    );

    expect(reranked.map((result) => result.photoId)).toEqual([2, 1]);
    expect(reranked[1].similarity).toBe(0.15);
    expect(reranked).toHaveLength(2);
  });
});
