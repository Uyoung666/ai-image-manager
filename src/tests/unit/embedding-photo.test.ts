import { describe, expect, it, vi } from "vitest";
import { summarizeEmbeddingFailures } from "@/services/ai/embedding-failures";
import { processEmbeddingPhoto } from "../../../scripts/embedding-photo.mjs";

describe("embedding failure stages", () => {
  it("keeps GPU decode errors local to one photo and processes the next image", async () => {
    const infer = vi.fn<() => Promise<number[]>>().mockResolvedValue([1, 0]);
    const failed = await processEmbeddingPhoto(1, {
      prepare: () => Promise.reject(new Error("HEIC decode failed")),
      infer,
      normalize: (v) => v,
      provider: "directml",
    });
    expect(failed).toMatchObject({
      stage: "decode",
      errorCode: "IMAGE_DECODE_FAILED",
      providerError: false,
    });
    expect(infer).not.toHaveBeenCalled();
    const success = await processEmbeddingPhoto(2, {
      prepare: async () => new Float32Array(3),
      infer,
      normalize: (v) => v,
      provider: "directml",
    });
    expect(success).toEqual({ id: 2, vector: [1, 0] });
    expect(summarizeEmbeddingFailures([failed, success])).toMatchObject({
      failed: 1,
      decodeFailed: 1,
    });
  });
  it.each([
    "cpu",
    "directml",
  ])("only inference errors can trigger provider fallback: %s", async (provider) => {
    const result = await processEmbeddingPhoto(1, {
      prepare: async () => [],
      infer: () => Promise.reject(new Error("ORT provider failed")),
      normalize: (v) => v,
      provider,
    });
    expect(result).toMatchObject({
      stage: "inference",
      providerError: provider === "directml",
    });
  });
  it("does not classify invalid output vectors as GPU provider failures", async () => {
    const result = await processEmbeddingPhoto(1, {
      prepare: async () => [],
      infer: async () => [],
      normalize: () => {
        throw new Error("Invalid vector");
      },
      provider: "directml",
    });
    expect(result).toMatchObject({
      stage: "normalization",
      providerError: false,
    });
  });
});
