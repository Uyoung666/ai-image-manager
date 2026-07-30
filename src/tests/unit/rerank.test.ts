import { describe, expect, it } from "vitest";
import {
  buildTagSearchEvidence,
  fuseGatedHybridSearchEvidence,
  fuseHybridSearchEvidence,
  normalizeAutoTagStrength,
} from "@/services/rerank";

describe("semantic reranking", () => {
  it("累加同一照片的多来源证据且不再执行文本 embedding", () => {
    const results = fuseHybridSearchEvidence(
      [
        { photoId: 1, similarity: 0.1 },
        { photoId: 2, similarity: 0.2 },
      ],
      [
        { exact: true, photoId: 1, source: "person" },
        { exact: true, photoId: 1, source: "tag" },
        { exact: false, photoId: 2, source: "filename" },
      ],
      10
    );

    expect(results.map((result) => result.photoId)).toEqual([1, 2]);
    expect(results[0].evidence).toEqual(["person", "tag", "ai"]);
    expect(results[0]._source).toBe("person");
    expect(results[0].rankScore).toBeGreaterThan(results[1].rankScore);
  });

  it("RRF 同分时按精确命中、语义相似度和 photoId 稳定排序", () => {
    const results = fuseHybridSearchEvidence(
      [
        { photoId: 3, similarity: 0.1 },
        { photoId: 4, similarity: 0.1 },
      ],
      [
        { exact: false, photoId: 8, source: "filename" },
        { exact: false, photoId: 7, source: "filename" },
      ],
      10
    );

    expect(results.map((result) => result.photoId)).toEqual([3, 4, 7, 8]);
  });

  it("保留多 Prompt 已累加的 RRF 分数，不用余弦相似度覆盖排序", () => {
    const results = fuseHybridSearchEvidence(
      [
        { photoId: 1, rankScore: 0.03, similarity: 0.1 },
        { photoId: 2, rankScore: 0.016, similarity: 0.9 },
      ],
      [{ exact: false, photoId: 2, source: "filename" }],
      10
    );

    expect(results.map((result) => result.photoId)).toEqual([1, 2]);
    expect(results[0].similarity).toBe(0.1);
  });

  it("auto tags only support semantic candidates while manual tags recall independently", () => {
    const evidence = buildTagSearchEvidence(
      [
        {
          id: 1,
          name: "bicycle",
          origin: "manual",
          userConfirmed: true,
        },
        {
          id: 2,
          name: "bicycle",
          origin: "auto",
          userConfirmed: false,
        },
        {
          id: 3,
          name: "bicycle",
          origin: "auto",
          userConfirmed: false,
        },
      ],
      new Set([2]),
      (name) => name === "bicycle"
    );

    expect(evidence).toEqual([
      { exact: true, photoId: 1, source: "tag" },
      { exact: false, photoId: 2, source: "autoTag" },
    ]);
  });

  it("keeps auto-tag support below semantic as the displayed source", () => {
    const [result] = fuseHybridSearchEvidence(
      [{ photoId: 2, similarity: 0.08 }],
      [{ exact: false, photoId: 2, source: "autoTag" }],
      10
    );

    expect(result._source).toBe("ai");
    expect(result.exact).toBe(false);
  });

  it("gates auto-tag rescue by semantic floor and confidence", () => {
    const semantic = [
      {
        photoId: 1,
        primarySimilarity: 0.06,
        rankScore: 0.03,
        similarity: 0.06,
        supportingGroups: ["whole-query"],
      },
      {
        photoId: 2,
        primarySimilarity: 0.05,
        rankScore: 0.02,
        similarity: 0.05,
        supportingGroups: ["whole-query"],
      },
      {
        photoId: 3,
        primarySimilarity: 0.05,
        rankScore: 0.019,
        similarity: 0.05,
        supportingGroups: ["whole-query"],
      },
      {
        photoId: 4,
        primarySimilarity: 0.043,
        rankScore: 0.018,
        similarity: 0.043,
        supportingGroups: ["whole-query"],
      },
    ];
    const tags = [
      {
        confidence: 0.8,
        id: 2,
        name: "自行车",
        origin: "auto" as const,
        userConfirmed: false,
      },
      {
        confidence: 0.7,
        id: 3,
        name: "自行车",
        origin: "auto" as const,
        userConfirmed: false,
      },
      {
        confidence: 0.9,
        id: 4,
        name: "自行车",
        origin: "auto" as const,
        userConfirmed: false,
      },
      {
        confidence: null,
        id: 5,
        name: "自行车",
        origin: "manual" as const,
        userConfirmed: true,
      },
    ];

    const result = fuseGatedHybridSearchEvidence(
      semantic,
      [{ exact: true, photoId: 5, source: "tag" }],
      tags,
      {
        acceptedSemanticPhotoIds: new Set([1]),
        intent: "object",
        promptGroupCount: 1,
        strongCutoff: 0.055,
        supportCutoff: 0.046_75,
        topSimilarity: 0.09,
      }
    );

    expect(result.results.map(({ photoId }) => photoId)).toEqual([5, 2, 1]);
    expect(result.diagnostics.autoTagRescued).toBe(1);
    expect(result.results.some(({ photoId }) => photoId === 3)).toBe(false);
    expect(result.results.some(({ photoId }) => photoId === 4)).toBe(false);
  });

  it("normalizes usable auto-tag confidence into the configured half-to-one range", () => {
    expect(normalizeAutoTagStrength(0.55)).toBe(0.5);
    expect(normalizeAutoTagStrength(0.75)).toBe(0.75);
    expect(normalizeAutoTagStrength(0.95)).toBe(1);
  });
});
