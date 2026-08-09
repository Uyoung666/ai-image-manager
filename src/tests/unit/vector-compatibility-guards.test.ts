import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
});

async function installRuntime(options?: { staleFingerprint?: boolean }) {
  const [modelConfig, state, thresholdProfile] = await Promise.all([
    import("@/services/ai/model-config"),
    import("@/services/ai/state"),
    import("@/services/ai/threshold-profile"),
  ]);
  const active = modelConfig.getActiveEmbeddingRuntimeInfo();
  const profile = thresholdProfile.getActiveThresholdProfile();
  state.setActiveEmbeddingRuntime({
    ...active,
    calibrationStatus: profile.calibrationStatus,
    fingerprint: options?.staleFingerprint
      ? "d".repeat(64)
      : active.fingerprint,
    thresholdProfileId: profile.profileId,
    vectorCompatibility: "matching",
  });
  return { active, state };
}

describe("vector compatibility search guards", () => {
  it("blocks semantic search before embedding when the runtime fingerprint is stale", async () => {
    const { state } = await installRuntime({ staleFingerprint: true });
    const embedTexts = vi.fn();
    const vectorSearch = vi.fn();
    state.setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
      embedTexts,
    });
    state.setIsModelLoaded(true);
    state.setIsVectorDBReady(true);
    state.setPhotoTable({
      countRows: vi.fn().mockResolvedValue(21),
      vectorSearch,
    } as unknown as LanceTable);
    state.setVectordb({} as unknown as LanceConnection);

    const { searchByTextWithPlan } = await import("@/services/ai/search");
    const result = await searchByTextWithPlan(
      "vector-compatibility-block-test",
      20
    );

    expect(result.cutoffReason).toBe("vector-fingerprint-mismatch");
    expect(result.results).toEqual([]);
    expect(embedTexts).not.toHaveBeenCalled();
    expect(vectorSearch).not.toHaveBeenCalled();
  }, 15_000);
});

describe("AI health vector compatibility", () => {
  it("reports a fingerprint mismatch and degrades health", async () => {
    const { active, state } = await installRuntime({ staleFingerprint: true });
    state.setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: vi.fn(),
    });
    state.setIsModelLoaded(true);
    state.setIsVectorDBReady(true);
    state.setPhotoTable({
      countRows: vi.fn().mockResolvedValue(21),
      listIndices: vi.fn().mockResolvedValue([]),
      schema: vi.fn().mockResolvedValue({
        fields: [{ name: "vector", type: { listSize: active.dimensions } }],
      }),
    } as unknown as LanceTable);
    state.setVectordb({
      tableNames: vi.fn().mockResolvedValue(["photo_embeddings"]),
    } as unknown as LanceConnection);

    const { checkAiHealth } = await import("@/services/ai/health");
    const health = await checkAiHealth();

    expect(health).toMatchObject({
      embeddingAdapterId: active.adapterId,
      embeddingFingerprint: active.fingerprint,
      lancedb: "ok",
      overall: "degraded",
      vectorCompatibility: "fingerprint-mismatch",
      vectorTable: "ok",
      vectorTableRows: 21,
    });
  });
});
