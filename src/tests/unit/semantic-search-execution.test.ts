// @vitest-environment node

import { performance } from "node:perf_hooks";
import type { Connection, Table } from "@lancedb/lancedb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { searchByTextWithPlan } from "@/services/ai/search";
import type { SemanticQueryPlan } from "@/services/ai/semantic-query-plan";
import {
  setEmbeddingModel,
  setIsModelLoaded,
  setIsVectorDBReady,
  setPhotoTable,
  setVectordb,
} from "@/services/ai/state";
import { withVectorDbOperation } from "@/services/ai/vector-db";
import { createSearchDiagnostics } from "@/services/search-control";
import { invalidateVectorSearch } from "@/services/search-revision";

vi.mock("@/services/ai/translation-worker-client", () => ({
  getTranslationModelVersion: () => "test",
  warmupTranslationWorker: () => Promise.resolve(),
}));
vi.mock("@/services/ai/threshold-profile", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/services/ai/threshold-profile")>();
  return {
    ...actual,
    getActiveThresholdProfile: () => ({
      ...actual.getActiveThresholdProfile(),
      calibrationStatus: "calibrated",
    }),
  };
});
const unit = (index: number) =>
  Array.from({ length: 768 }, (_, i) => Number(i === index));
const PHOTO_ID_INTERVAL_RE = /^photo_id BETWEEN (\d+) AND (\d+)$/;
const plan = (auxiliary = false): SemanticQueryPlan => ({
  coverage: 1,
  intent: "composed",
  language: "en",
  negativePrompts: [],
  normalizedQuery: "dog on beach",
  rawPromptCount: 1,
  translationMode: "none",
  version: 5,
  prompts: [
    {
      text: "dog on beach",
      role: "primary",
      canonicalKey: "full",
      evidenceGroup: "whole-query",
      weight: 1,
    },
    ...(auxiliary
      ? [
          {
            text: "dog",
            role: "focused" as const,
            canonicalKey: "dog",
            evidenceGroup: "subject" as const,
            weight: 0.5,
          },
        ]
      : []),
  ],
});
function install(
  rows: (limit: number, vector: number[]) => Record<string, unknown>[],
  count = 2,
  photoVectors: (filter: string) => Record<string, unknown>[] = () => [
    { photo_id: 1, vector: unit(0) },
    { photo_id: 2, vector: unit(1) },
  ]
) {
  const toArray = vi.fn();
  const table = {
    countRows: () => Promise.resolve(count),
    vectorSearch: vi.fn((vector: number[]) => {
      let limit = 1;
      const query = {
        distanceType: () => query,
        refineFactor: () => query,
        where: vi.fn(() => query),
        select: () => query,
        bypassVectorIndex: () => query,
        limit: (value: number) => {
          limit = value;
          return query;
        },
        toArray: () => Promise.resolve(rows(limit, vector)),
      };
      return query;
    }),
    query: () => {
      let filter = "";
      const query = {
        where: (value: string) => {
          filter = value;
          return query;
        },
        toArray: () => {
          toArray(filter);
          return Promise.resolve(photoVectors(filter));
        },
      };
      return query;
    },
  };
  setPhotoTable(table as unknown as Table);
  setVectordb({} as Connection);
  setIsVectorDBReady(true);
  setIsModelLoaded(true);
  const embedTexts = vi.fn((texts: string[]) =>
    Promise.resolve(texts.map((text) => unit(text === "dog" ? 1 : 0)))
  );
  setEmbeddingModel({
    embedImage: vi.fn(),
    embedText: (text) => Promise.resolve(unit(text === "dog" ? 1 : 0)),
    embedTexts,
  });
  return { table, embedTexts, toArray };
}
afterEach(() => {
  setEmbeddingModel(null);
  setPhotoTable(null);
  setVectordb(null);
  setIsVectorDBReady(false);
  setIsModelLoaded(false);
});

describe("semantic execution correctness", () => {
  it("returns every recalled tag-support candidate independently of page size", async () => {
    install(
      () => [1, 2, 3].map((photo_id) => ({ photo_id, _distance: 0.95 })),
      3
    );
    const objectPlan = { ...plan(), intent: "object" as const };
    const small = await searchByTextWithPlan("support candidates", 1, {
      deadline: performance.now() + 2000,
      plan: objectPlan,
    });
    const large = await searchByTextWithPlan("support candidates", 10, {
      deadline: performance.now() + 2000,
      plan: objectPlan,
    });
    expect(small.results).toEqual([]);
    expect(small.supportCandidates.map((row) => row.photoId)).toEqual([
      1, 2, 3,
    ]);
    expect(small.supportCandidates).toEqual(large.supportCandidates);
    expect(small.hasMore).toBe(false);
  });
  it("hands all accepted candidates to the caller before display pagination", async () => {
    install(
      () => [1, 2, 3].map((photo_id) => ({ photo_id, _distance: 0.2 })),
      3
    );
    const result = await searchByTextWithPlan("all accepted", 1, {
      deadline: performance.now() + 2000,
      plan: plan(),
    });
    expect(result.results.map((row) => row.photoId)).toEqual([1, 2, 3]);
    expect(result.hasMore).toBe(false);
  });
  it("lets the caller extend a fixed candidate depth after hybrid admission", async () => {
    const { table } = install(
      (limit) => [{ photo_id: limit, _distance: 0.2 }],
      500
    );
    const initial = await searchByTextWithPlan("caller depth", 10, {
      deadline: performance.now() + 2000,
      candidateDepth: 200,
      plan: plan(),
    });
    expect(initial).toMatchObject({ candidateDepth: 200, hasMore: true });
    expect(table.vectorSearch).toHaveBeenCalledOnce();
    const extended = await searchByTextWithPlan("caller depth", 10, {
      deadline: performance.now() + 2000,
      candidateDepth: 400,
      plan: plan(),
    });
    expect(extended).toMatchObject({ candidateDepth: 400, hasMore: true });
    expect(extended.results[0].photoId).toBe(400);
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);
  });
  it("always uses single-text batches when only part of the query plan is cached", async () => {
    const { embedTexts } = install(() => [{ photo_id: 1, _distance: 0.2 }]);
    await searchByTextWithPlan("warm primary", 10, {
      deadline: performance.now() + 2000,
      plan: plan(),
    });
    await searchByTextWithPlan("add auxiliary", 10, {
      deadline: performance.now() + 2000,
      plan: plan(true),
    });
    expect(embedTexts.mock.calls.map(([texts]) => texts)).toEqual([
      ["dog on beach"],
      ["dog"],
    ]);
  });
  it("shares each text encoding without cancelling another subscriber", async () => {
    const { embedTexts } = install(() => [{ photo_id: 1, _distance: 0.2 }]);
    const releases: Array<() => void> = [];
    embedTexts.mockImplementation(
      (texts) =>
        new Promise((resolve) => {
          releases.push(() =>
            resolve(texts.map((text) => unit(text === "dog" ? 1 : 0)))
          );
        })
    );
    const controller = new AbortController();
    const first = searchByTextWithPlan("subscriber A", 10, {
      deadline: performance.now() + 2000,
      plan: plan(true),
      signal: controller.signal,
    });
    const firstSettled = expect(first).rejects.toMatchObject({
      reason: "cancelled",
    });
    const second = searchByTextWithPlan("subscriber B", 10, {
      deadline: performance.now() + 2000,
      plan: plan(true),
    });
    await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledTimes(2));
    controller.abort();
    await firstSettled;
    for (const release of releases) {
      release();
    }
    expect((await second).results[0].photoId).toBe(1);
    expect(embedTexts.mock.calls.every(([texts]) => texts.length === 1)).toBe(
      true
    );
  });
  it("does not cache invalid text vectors", async () => {
    const { embedTexts } = install(() => [{ photo_id: 1, _distance: 0.2 }]);
    embedTexts.mockResolvedValueOnce([unit(0).map(() => Number.NaN)]);
    await expect(
      searchByTextWithPlan("invalid encoding", 10, {
        deadline: performance.now() + 2000,
        plan: plan(),
      })
    ).rejects.toThrow("文本向量无效");
    const retry = await searchByTextWithPlan("invalid encoding", 10, {
      deadline: performance.now() + 2000,
      plan: plan(),
    });
    expect(retry.results[0].photoId).toBe(1);
    expect(embedTexts).toHaveBeenCalledTimes(2);
  });
  it("discards encoding completed after the active model was replaced", async () => {
    const { embedTexts } = install(() => [{ photo_id: 1, _distance: 0.2 }]);
    let release!: () => void;
    embedTexts.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve([unit(0)]);
        })
    );
    const search = searchByTextWithPlan("stale encoding", 10, {
      deadline: performance.now() + 2000,
      plan: plan(),
    });
    const settled = expect(search).rejects.toThrow(
      "Stale text embedding result discarded"
    );
    await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledOnce());
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: () => Promise.resolve(unit(0)),
    });
    release();
    await settled;
  });
  it("rejects a stale query vector if the model changed while waiting for the vector queue", async () => {
    const { table, embedTexts } = install(() => [
      { photo_id: 1, _distance: 0.2 },
    ]);
    let release!: () => void;
    const maintenance = withVectorDbOperation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    const search = searchByTextWithPlan("stale queued vector", 10, {
      deadline: performance.now() + 2000,
      plan: plan(),
    });
    const settled = expect(search).rejects.toThrow(
      "Stale text embedding result discarded"
    );
    await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledOnce());
    setEmbeddingModel({
      embedImage: vi.fn(),
      embedText: () => Promise.resolve(unit(0)),
    });
    release();
    await maintenance;
    await settled;
    expect(table.vectorSearch).not.toHaveBeenCalled();
  });
  it("marks missing required photo vectors incomplete and does not cache them", async () => {
    let complete = false;
    const { table } = install(
      () => [
        { photo_id: 1, _distance: 0.2 },
        { photo_id: 2, _distance: 0.3 },
      ],
      2,
      () => [
        ...(complete ? [{ photo_id: 1, vector: unit(0) }] : []),
        { photo_id: 2, vector: unit(1) },
      ]
    );
    const negativePlan = { ...plan(), negativePrompts: ["dog"] };
    const result = await searchByTextWithPlan("missing photo vector", 10, {
      deadline: performance.now() + 2000,
      plan: negativePlan,
    });
    expect(result.cutoffReason).toBe("missing-photo-vector");
    expect(result.results.map((row) => row.photoId)).toEqual([2]);
    complete = true;
    const retry = await searchByTextWithPlan("missing photo vector", 10, {
      deadline: performance.now() + 2000,
      plan: negativePlan,
    });
    expect(retry.cutoffReason).not.toBe("missing-photo-vector");
    expect(retry.results.map((row) => row.photoId)).toEqual([1, 2]);
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);
  });
  it("keeps negative ranks global while scoring photo vectors in bounded batches", async () => {
    const count = 1201;
    const filterIds = (filter: string): number[] => {
      const interval = PHOTO_ID_INTERVAL_RE.exec(filter);
      if (interval) {
        const first = Number(interval[1]);
        return Array.from(
          { length: Number(interval[2]) - first + 1 },
          (_, index) => first + index
        );
      }
      return (filter.match(/\d+/g) ?? []).map(Number);
    };
    const { toArray } = install(
      () =>
        Array.from({ length: count }, (_, index) => ({
          photo_id: index + 1,
          _distance: 0.2,
        })),
      count,
      (filter) =>
        filterIds(filter).map((photo_id) => {
          const negativeScore = (photo_id - 1) / (count - 1);
          const vector = unit(0);
          vector[0] = Math.sqrt(1 - negativeScore ** 2);
          vector[1] = negativeScore;
          return { photo_id, vector };
        })
    );
    const result = await searchByTextWithPlan("global negative rank", 10, {
      deadline: performance.now() + 2000,
      candidateDepth: count,
      plan: { ...plan(), negativePrompts: ["dog"] },
    });
    expect(toArray).toHaveBeenCalledTimes(3);
    expect(
      toArray.mock.calls.every(([filter]) => filterIds(filter).length <= 500)
    ).toBe(true);
    expect(result.results).toHaveLength(count);
    expect(result.results.find((row) => row.photoId === 1)).toMatchObject({
      similarity: 0.8,
      rankScore: 1 / 61 - 0.25 / (60 + count),
    });
    expect(result.results.find((row) => row.photoId === count)).toMatchObject({
      similarity: 0.55,
      rankScore: 1 / (60 + count) - 0.25 / 61,
    });
  });
  it("does not silently omit a negative concept whose translation failed", async () => {
    const { table } = install(() => [{ photo_id: 1, _distance: 0.01 }]);
    await searchByTextWithPlan("beach", 10, {
      deadline: performance.now() + 1000,
      plan: plan(),
    });
    table.vectorSearch.mockClear();
    const incomplete = plan();
    incomplete.negativeTerms = ["dog"];
    const result = await searchByTextWithPlan("no dogs", 10, {
      deadline: performance.now() + 1000,
      plan: incomplete,
    });
    expect(result).toMatchObject({
      results: [],
      cutoffReason: "missing-negative-query",
    });
    expect(table.vectorSearch).not.toHaveBeenCalled();
  });
  it("does not promote a dictionary fragment into a whole-query score", async () => {
    const { table, embedTexts } = install(() => [
      { photo_id: 1, _distance: 0.01 },
    ]);
    const fallbackPlan = plan();
    fallbackPlan.prompts[0].role = "structured";
    fallbackPlan.translationMode = "dictionary-fallback";
    const result = await searchByTextWithPlan("missing translation", 10, {
      deadline: performance.now() + 1000,
      plan: fallbackPlan,
    });
    expect(result).toMatchObject({
      results: [],
      cutoffReason: "missing-primary-query",
    });
    expect(table.vectorSearch).not.toHaveBeenCalled();
    expect(embedTexts).not.toHaveBeenCalled();
    const recovered = await searchByTextWithPlan("missing translation", 10, {
      deadline: performance.now() + 1000,
      plan: plan(),
    });
    expect(recovered.results.map((row) => row.photoId)).toEqual([1]);
    expect(table.vectorSearch).toHaveBeenCalledOnce();
  });
  it("supplements an auxiliary-only candidate with its actual whole-query score", async () => {
    const { toArray } = install((_limit, vector) =>
      vector[0]
        ? [{ photo_id: 1, _distance: 0.2 }]
        : [{ photo_id: 2, _distance: 0.01 }]
    );
    const result = await searchByTextWithPlan("composition", 10, {
      deadline: performance.now() + 1000,
      allowedPhotoIds: [1, 2],
      plan: plan(true),
    });
    expect(toArray).toHaveBeenCalledOnce();
    expect(result.results.map((row) => row.photoId)).toEqual([1]);
  });
  it("continues after empty initial batches and preserves stable reachability", async () => {
    const { table } = install(
      (limit) => (limit < 500 ? [] : [{ photo_id: 500, _distance: 0.2 }]),
      500
    );
    const result = await searchByTextWithPlan("deep", 10, {
      deadline: performance.now() + 1000,
      allowedPhotoIds: Array.from({ length: 500 }, (_, i) => i + 1),
      plan: plan(),
    });
    expect(table.vectorSearch).toHaveBeenCalledTimes(3);
    expect(result.results[0].photoId).toBe(500);
    expect(result.hasMore).toBe(false);
  });
  it("scores the negative concept over the positive candidates without another ANN top-K", async () => {
    const { table, toArray } = install(() => [
      { photo_id: 1, _distance: 0.2 },
      { photo_id: 2, _distance: 0.3 },
    ]);
    const negativePlan = plan();
    negativePlan.negativePrompts = ["dog"];
    const result = await searchByTextWithPlan("beach without dog", 10, {
      deadline: performance.now() + 1000,
      plan: negativePlan,
      allowedPhotoIds: [1, 2],
    });
    expect(toArray).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledOnce();
    expect(result.results.find((row) => row.photoId === 2)).toMatchObject({
      primarySimilarity: 0.45,
      similarity: 0.45,
    });
  });
  it("encodes outside the vector queue and skips cancelled queued reads", async () => {
    const { table, embedTexts } = install(() => [
      { photo_id: 1, _distance: 0.2 },
    ]);
    let release!: () => void;
    const maintenance = withVectorDbOperation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    await Promise.resolve();
    const controller = new AbortController();
    const pending = searchByTextWithPlan("queued", 10, {
      deadline: performance.now() + 1000,
      signal: controller.signal,
      plan: plan(),
    });
    await vi.waitFor(() => expect(embedTexts).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ reason: "cancelled" });
    release();
    await maintenance;
    await withVectorDbOperation(() => undefined);
    expect(table.vectorSearch).not.toHaveBeenCalled();
  });
  it("invalidates candidate caches after a vector batch revision", async () => {
    const { table } = install(() => [{ photo_id: 1, _distance: 0.2 }]);
    const options = {
      deadline: performance.now() + 2000,
      allowedPhotoIds: [1, 2],
      plan: plan(),
      sourceRevision: "same",
    };
    await searchByTextWithPlan("revision", 10, options);
    const diagnostics = createSearchDiagnostics();
    await searchByTextWithPlan("revision", 10, { ...options, diagnostics });
    expect(diagnostics.cacheHit).toBe(true);
    invalidateVectorSearch();
    await searchByTextWithPlan("revision", 10, options);
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);
  });
});
