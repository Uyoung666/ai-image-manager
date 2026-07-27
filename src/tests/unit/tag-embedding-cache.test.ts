import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setEmbeddingModel } from "@/services/ai/state";
import {
  _ensureTagEmbeddingsForTest,
  _resetTagEmbeddingCacheForTest,
  CANDIDATE_TAGS,
} from "@/services/ai/tag-suggester";

function vector(value = 1): number[] {
  return Array.from({ length: 768 }, () => value);
}

describe("tag embedding cache", () => {
  beforeEach(() => {
    vi.stubEnv("AI_EMBEDDING_MODEL", "siglip");
    _resetTagEmbeddingCacheForTest();
  });

  afterEach(() => {
    setEmbeddingModel(null);
    _resetTagEmbeddingCacheForTest();
    vi.unstubAllEnvs();
  });

  it("precomputes candidates in batches of sixteen", async () => {
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => vector())
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await _ensureTagEmbeddingsForTest();

    expect(embedTexts).toHaveBeenCalledTimes(
      Math.ceil(CANDIDATE_TAGS.length / 16)
    );
    expect(embedTexts.mock.calls.every(([texts]) => texts.length <= 16)).toBe(
      true
    );
  });

  it("shares one precomputation across concurrent callers", async () => {
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => vector())
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await Promise.all([
      _ensureTagEmbeddingsForTest(),
      _ensureTagEmbeddingsForTest(),
    ]);

    expect(embedTexts).toHaveBeenCalledTimes(
      Math.ceil(CANDIDATE_TAGS.length / 16)
    );
  });

  it("does not publish a partial cache after an invalid vector", async () => {
    let fail = true;
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => (fail ? [1] : vector()))
    );
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });

    await expect(_ensureTagEmbeddingsForTest()).rejects.toThrow(
      "Invalid SigLIP"
    );
    fail = false;
    await _ensureTagEmbeddingsForTest();

    expect(embedTexts).toHaveBeenCalledTimes(
      1 + Math.ceil(CANDIDATE_TAGS.length / 16)
    );
  });
});
