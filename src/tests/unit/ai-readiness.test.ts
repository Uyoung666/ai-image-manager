import { beforeEach, describe, expect, it, vi } from "vitest";
import type { VectorCompatibility } from "@/services/ai/model-fingerprint";

const fixture = vi.hoisted(() => {
  const active = {
    adapterId: "test-siglip",
    dimensions: 768,
    fingerprint: "a".repeat(64),
  };
  return {
    active,
    runtime: {
      ...active,
      vectorCompatibility: "matching" as string,
      vectorBuildState: "ready" as string,
    },
    init: vi.fn(),
    load: vi.fn(),
    count: vi.fn(),
  };
});
vi.mock("@/db", () => ({
  getDatabase: () => ({
    select: () => ({
      from: () => ({ where: () => ({ get: () => ({ count: 8 }) }) }),
    }),
  }),
}));
vi.mock("@/services/ai/model-config", () => ({
  getActiveEmbeddingRuntimeInfo: () => fixture.active,
}));
vi.mock("@/services/ai/model-loader", () => ({ loadModel: fixture.load }));
vi.mock("@/services/ai/vector-db", () => ({
  initVectorDB: fixture.init,
  withVectorDbOperation: (operation: () => Promise<unknown>) => operation(),
}));
vi.mock("@/services/ai/translation-worker-client", () => ({
  getTranslationState: () => "ready",
}));
vi.mock("@/services/ai/state", () => ({
  currentProgress: { phase: "idle", processed: 0, total: 8 },
  embeddingModel: null,
  getActiveEmbeddingRuntime: () => fixture.runtime,
  isEmbedding: false,
  isModelLoaded: false,
  photoTable: { countRows: fixture.count, listIndices: async () => [] },
  setPhotoTable: vi.fn(),
  setVectordb: vi.fn(),
  vectordb: null,
}));

import { getAiReadiness } from "@/services/ai/health";

beforeEach(() => {
  vi.clearAllMocks();
  fixture.runtime = {
    ...fixture.active,
    vectorCompatibility: "matching",
    vectorBuildState: "ready",
  };
  fixture.init.mockResolvedValue(undefined);
  fixture.count.mockResolvedValue(8);
});

describe("AI readiness for index migration", () => {
  it.each<VectorCompatibility>([
    "fingerprint-mismatch",
    "missing-fingerprint",
    "invalid-fingerprint",
    "dimension-mismatch",
  ])("preserves the incompatibility error and requires rebuilding: %s", async (compatibility) => {
    fixture.runtime.vectorCompatibility = compatibility;
    fixture.init.mockRejectedValue(
      new Error(`Vector store incompatible: ${compatibility}`)
    );
    const readiness = await getAiReadiness({ loadModel: false });
    expect(readiness).toMatchObject({
      coverageState: "error",
      lastError: `Vector store incompatible: ${compatibility}`,
      rebuildRequired: true,
      vectorCompatibility: compatibility,
      vectorDB: "error",
    });
    expect(fixture.load).not.toHaveBeenCalled();
  });

  it("keeps a same-fingerprint build resumable and partial without requesting reset", async () => {
    fixture.runtime.vectorBuildState = "building";
    const readiness = await getAiReadiness({ loadModel: false });
    expect(readiness).toMatchObject({
      coverageState: "partial",
      indexedPhotos: 8,
      rebuildRequired: false,
      vectorBuildState: "building",
      vectorCompatibility: "matching",
    });
  });

  it("does not request reset for compatible partial coverage", async () => {
    fixture.count.mockResolvedValue(3);
    expect(await getAiReadiness({ loadModel: false })).toMatchObject({
      coverageState: "partial",
      indexedPhotos: 3,
      rebuildRequired: false,
    });
  });

  it("preserves a general database failure without incorrectly requiring a rebuild", async () => {
    fixture.init.mockRejectedValue(new Error("Permission denied"));
    expect(await getAiReadiness({ loadModel: false })).toMatchObject({
      lastError: "Permission denied",
      rebuildRequired: false,
      vectorDB: "error",
    });
  });
});
