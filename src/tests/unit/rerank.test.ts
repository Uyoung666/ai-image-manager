import { describe, expect, it } from "vitest";
import { fuseHybridSearchEvidence } from "@/services/rerank";

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
});
