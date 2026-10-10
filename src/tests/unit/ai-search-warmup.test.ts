import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getActiveEmbeddingModel } from "@/services/ai/model-config";
import {
  isAiSearchReady,
  searchByText,
  warmupAiSearch,
} from "@/services/ai/search";
import {
  setEmbeddingModel,
  setIsModelLoaded,
  setIsVectorDBReady,
  setPhotoTable,
  setVectordb,
} from "@/services/ai/state";

const CJK_RE = /[一-鿿]/;

vi.mock("@/services/ai/translation-worker-client", () => ({
  getTranslationModelVersion: () => "translation-test-v1",
  translateChineseToEnglish: vi.fn().mockResolvedValue("cute kitten"),
  warmupTranslationWorker: vi.fn().mockResolvedValue(undefined),
}));

function createVectorTable(results: Record<string, unknown>[] = []) {
  const toArray = vi.fn().mockResolvedValue(results);
  const query = {
    distanceType: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    refineFactor: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    toArray,
    where: vi.fn().mockReturnThis(),
  };
  return {
    countRows: vi.fn().mockResolvedValue(10),
    query: vi.fn().mockReturnValue(query),
    vectorSearch: vi.fn().mockReturnValue(query),
  } as unknown as LanceTable;
}

function createEmbeddingVector(): number[] {
  return new Array(getActiveEmbeddingModel().vectorDimensions).fill(0.1);
}

function installReadyAi(
  table: ReturnType<typeof createVectorTable>,
  embedTexts: (texts: string[]) => Promise<number[][]>
) {
  setEmbeddingModel({
    embedImage: vi.fn(),
    embedText: async (text) => (await embedTexts([text]))[0],
    embedTexts,
  });
  setIsModelLoaded(true);
  setPhotoTable(table);
  setVectordb({} as unknown as LanceConnection);
  setIsVectorDBReady(true);
}

afterEach(() => {
  setEmbeddingModel(null);
  setIsModelLoaded(false);
  setPhotoTable(null);
  setVectordb(null);
  setIsVectorDBReady(false);
});

describe("AI semantic search warmup", () => {
  it("预热模型和向量查询后才报告搜索就绪", async () => {
    const table = createVectorTable();
    const embedTexts = vi.fn().mockResolvedValue([createEmbeddingVector()]);
    installReadyAi(table, embedTexts);

    expect(isAiSearchReady()).toBe(false);
    await warmupAiSearch();

    expect(isAiSearchReady()).toBe(true);
    expect(embedTexts).toHaveBeenCalledWith(["a photo"]);
    expect(table.vectorSearch).toHaveBeenCalledOnce();
  });

  it("相同查询并发到达时复用同一个进行中任务", async () => {
    const table = createVectorTable([{ photo_id: 7, _distance: 0.2 }]);
    const embedTexts = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return [createEmbeddingVector()];
    });
    installReadyAi(table, embedTexts);

    const first = searchByText("concurrency-cat-test", 5);
    const second = searchByText("concurrency-cat-test", 5);
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual(secondResult);
    expect(embedTexts).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledOnce();
  });

  it("中文多 Prompt 固定单文本编码，并复用任务、缓存和行数查询", async () => {
    const table = createVectorTable([
      { photo_id: 8, _distance: 0.2, vector: createEmbeddingVector() },
    ]);
    const embedTexts = vi.fn(async (texts: string[]) =>
      texts.map(() => createEmbeddingVector())
    );
    installReadyAi(table, embedTexts);

    const [first, shared] = await Promise.all([
      searchByText("可爱猫咪", 20),
      searchByText("可爱猫咪", 20),
    ]);

    expect(first).toEqual(shared);
    expect(embedTexts).toHaveBeenCalledTimes(2);
    const prompts = embedTexts.mock.calls.map(([batch]) => {
      expect(batch).toHaveLength(1);
      return batch[0];
    });
    expect(new Set(prompts).size).toBe(prompts.length);
    expect(prompts.every((prompt: string) => !CJK_RE.test(prompt))).toBe(true);
    expect(table.countRows).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);

    expect(await searchByText("可爱猫咪", 20)).toEqual(first);
    expect(embedTexts).toHaveBeenCalledTimes(2);
    expect(table.countRows).toHaveBeenCalledOnce();
    expect(table.vectorSearch).toHaveBeenCalledTimes(2);
  });
});
