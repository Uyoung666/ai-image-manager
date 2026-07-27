import { afterEach, describe, expect, it } from "vitest";
import {
  getActiveEmbeddingModel,
  getTextSearchMaxCosineDistance,
} from "@/services/ai/model-config";
import {
  filterCosineSearchResults,
  fuseRankedSearchResults,
  isValidEmbeddingVector,
  selectTagScores,
} from "@/services/ai/scoring";
import { CANDIDATE_TAGS } from "@/services/ai/tag-suggester";

const originalModel = process.env.AI_EMBEDDING_MODEL;

afterEach(() => {
  if (originalModel === undefined) {
    delete process.env.AI_EMBEDDING_MODEL;
  } else {
    process.env.AI_EMBEDDING_MODEL = originalModel;
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

  it("keeps the legacy CLIP distance policy for rollback", () => {
    process.env.AI_EMBEDDING_MODEL = "clip";

    expect(getTextSearchMaxCosineDistance(0, "zh")).toBe(0.22);
    expect(getTextSearchMaxCosineDistance(1, "zh")).toBe(0.55);
    expect(getTextSearchMaxCosineDistance(1, "en")).toBe(0.75);
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
});
