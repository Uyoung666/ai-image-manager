import { afterEach, describe, expect, it, vi } from "vitest";
import { setEmbeddingModel, setPhotoTable } from "@/services/ai/state";
import { rerankWithCLIPScore } from "@/services/rerank";

afterEach(() => {
  setEmbeddingModel(null);
  setPhotoTable(null);
});

describe("semantic reranking", () => {
  it("loads candidate vectors directly by LanceDB photo_id", async () => {
    const toArray = vi.fn().mockResolvedValue([
      { photo_id: 1, vector: [1, 0] },
      { photo_id: 2, vector: [0, 1] },
    ]);
    const where = vi.fn().mockReturnValue({ toArray });
    const query = vi.fn().mockReturnValue({ where });

    setPhotoTable({ query });
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn().mockResolvedValue([1, 0]),
    });

    const results = await rerankWithCLIPScore(
      "city at night",
      [
        { photoId: 2, similarity: 0.1 },
        { photoId: 1, similarity: 0.1 },
      ],
      2
    );

    expect(where).toHaveBeenCalledWith("photo_id IN (2,1)");
    expect(results).toEqual([
      { photoId: 1, similarity: 0.685 },
      { photoId: 2, similarity: 0.035 },
    ]);
  });
});
