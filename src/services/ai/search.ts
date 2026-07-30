import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WORKER_TIMEOUT } from "./constants";
import {
  getActiveEmbeddingModel,
  getSemanticPolicyVersion,
} from "./model-config";
import { ensureLocalModel, loadModel } from "./model-loader";
import {
  applyNegativeSemanticPenalty,
  filterCosineSearchResults,
  fuseRankedSearchEvidence,
  isValidEmbeddingVector,
  selectRelevantSemanticResults,
} from "./scoring";
import {
  getSemanticQueryPlan,
  prepareSemanticQueryPlan,
  SEMANTIC_QUERY_PLAN_VERSION,
  type SemanticQueryPlan,
  semanticQueryPlanCacheKey,
} from "./semantic-query-plan";
import {
  _localModelPath,
  embeddingModel,
  photoTable,
  setLocalModelPath,
} from "./state";
import {
  getTranslationModelVersion,
  warmupTranslationWorker,
} from "./translation-worker-client";
import { initVectorDB } from "./vector-db";

function findWorkerScript(): string {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error("embed-worker.mjs not found");
}

export function embedImageInWorker(
  imagePath: string,
  modelPath: string
): Promise<number[]> {
  return new Promise((resolve, reject) => {
    const workerScript = findWorkerScript();
    const child = fork(workerScript, [], {
      stdio: ["ignore", "inherit", "pipe", "ipc"],
      timeout: WORKER_TIMEOUT,
    });

    let stderr = "";
    let resolved = false;

    const timeout = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        child.kill();
        reject(new Error("Image embed worker timed out"));
      }
    }, WORKER_TIMEOUT);

    child.stderr?.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("message", (msg: any) => {
      if (msg.type === "ready") {
        child.send({
          type: "embed",
          modelKind: getActiveEmbeddingModel().kind,
          modelPath,
          photos: [{ id: 1, path: imagePath }],
        });
      } else if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
        child.kill();
        const result = msg.results?.[0];
        if (result?.vector && result.vector.length > 0) {
          resolve(result.vector);
        } else {
          reject(
            new Error(
              `Image embedding failed: ${result?.error || "empty vector"}`
            )
          );
        }
      }
    });

    child.on("close", (code) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(
          new Error(
            `Image embed worker exited with code ${code}: ${stderr.slice(-300)}`
          )
        );
      }
    });

    child.on("error", (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        reject(err);
      }
    });

    child.send({
      type: "init",
      modelKind: getActiveEmbeddingModel().kind,
      modelPath,
    });
  });
}

async function fallbackSearch(
  queryVector: number[],
  limit: number,
  maxDistance = 0.75,
  knownRowCount?: number
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!photoTable) {
    return [];
  }
  const model = getActiveEmbeddingModel();
  if (!isValidEmbeddingVector(queryVector, model)) {
    console.error(
      `[AI] fallbackSearch rejected invalid ${model.displayName} query vector: expected=${model.vectorDimensions} actual=${queryVector.length}`
    );
    return [];
  }

  const rowCount = knownRowCount ?? (await photoTable.countRows());

  console.log(
    `[AI] Library (${rowCount} rows), attempting paginated brute-force`
  );
  const PAGE_SIZE = 500;
  const MAX_PAGES = Math.ceil(rowCount / PAGE_SIZE);
  const MAX_SAFE_PAGES = 100; // 最多 50000 条，防止极端情况
  const allScored: Array<{ photoId: number; distance: number }> = [];

  for (let page = 0; page < Math.min(MAX_PAGES, MAX_SAFE_PAGES); page++) {
    const rows = await photoTable
      .query()
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE)
      .toArray();

    if (rows.length === 0) {
      break;
    }

    for (const row of rows as Record<string, unknown>[]) {
      const rawVec = row.vector;
      if (!rawVec) {
        continue;
      }
      let vec: Float32Array | null = null;
      if (rawVec instanceof Float32Array) {
        vec = rawVec;
      } else if (Array.isArray(rawVec)) {
        vec = new Float32Array(rawVec as number[]);
      } else if (typeof (rawVec as any).toArray === "function") {
        vec = new Float32Array((rawVec as any).toArray());
      } else if (ArrayBuffer.isView(rawVec)) {
        vec = new Float32Array(
          (rawVec as any).buffer,
          (rawVec as any).byteOffset,
          (rawVec as any).length
        );
      }
      const vectorDimensions = getActiveEmbeddingModel().vectorDimensions;
      if (vec && vec.length === vectorDimensions) {
        const photoId = row.photo_id as number;
        let dot = 0;
        let normQ = 0;
        let normV = 0;
        for (let i = 0; i < vectorDimensions; i++) {
          dot += queryVector[i] * vec[i];
          normQ += queryVector[i] * queryVector[i];
          normV += vec[i] * vec[i];
        }
        const norm = Math.sqrt(normQ) * Math.sqrt(normV);
        const cosDist = norm > 0 ? 1 - dot / norm : 1;
        allScored.push({ photoId, distance: cosDist });
      }
    }
  }

  allScored.sort((a, b) => a.distance - b.distance);

  return allScored
    .filter((r) => r.distance <= maxDistance)
    .slice(0, limit)
    .map((r) => ({
      photoId: r.photoId,
      similarity: Math.round(Math.max(0, 1 - r.distance) * 10_000) / 10_000,
    }));
}

interface SearchTimings {
  embedMs: number;
  vectorMs: number;
}

export interface RankedSemanticSearchResult {
  photoId: number;
  primarySimilarity: number;
  rankScore: number;
  similarity: number;
  supportingGroups: string[];
}

async function searchVector(
  queryVector: number[],
  limit: number,
  maxCosineDistance: number,
  rowCount: number
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!photoTable) {
    return [];
  }
  const model = getActiveEmbeddingModel();
  if (!isValidEmbeddingVector(queryVector, model)) {
    console.error(
      `[AI] searchVector rejected invalid ${model.displayName} query vector: expected=${model.vectorDimensions} actual=${queryVector.length}`
    );
    return [];
  }
  const adaptiveRefine = Math.min(
    10,
    Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
  );

  let rawResults: Record<string, unknown>[] = [];
  const queryLimit = Math.min(Math.max(limit, 1), Math.max(rowCount, 1));
  try {
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
      .limit(queryLimit);
    rawResults = (await vq.toArray()) as Record<string, unknown>[];
  } catch (err: any) {
    console.error("[AI] vectorSearch failed:", err?.message);
  }

  if (rawResults.length === 0) {
    return fallbackSearch(queryVector, limit, maxCosineDistance, rowCount);
  }

  const filtered = filterCosineSearchResults(
    rawResults.map((result) => ({
      distance: result._distance as number,
      photoId: result.photo_id as number,
    })),
    maxCosineDistance,
    limit
  );

  if (filtered.length === 0) {
    const nearestDistance = rawResults[0]?._distance as number | undefined;
    console.log(
      `[AI] All ${rawResults.length} ${model.displayName} results above distance threshold ${maxCosineDistance}; nearest=${nearestDistance?.toFixed(4) ?? "n/a"}`
    );
    return [];
  }

  return filtered;
}

interface EmbeddingCacheEntry {
  timestamp: number;
  vector: number[];
}

const textEmbeddingCache = new Map<string, EmbeddingCacheEntry>();
const pendingEmbeddingBatches = new Map<string, Promise<number[][]>>();
const EMBEDDING_CACHE_TTL = 10 * 60 * 1000;
const MAX_EMBEDDING_CACHE = 100;
let embeddingCacheModel: typeof embeddingModel = null;

function getCachedEmbedding(text: string): number[] | null {
  const entry = textEmbeddingCache.get(text);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > EMBEDDING_CACHE_TTL) {
    textEmbeddingCache.delete(text);
    return null;
  }
  textEmbeddingCache.delete(text);
  textEmbeddingCache.set(text, entry);
  return entry.vector;
}

function setCachedEmbedding(text: string, vector: number[]): void {
  if (textEmbeddingCache.size >= MAX_EMBEDDING_CACHE) {
    const lru = textEmbeddingCache.keys().next().value;
    if (lru !== undefined) {
      textEmbeddingCache.delete(lru);
    }
  }
  textEmbeddingCache.delete(text);
  textEmbeddingCache.set(text, { timestamp: Date.now(), vector });
}

async function embedSearchTexts(
  texts: string[],
  timings: SearchTimings
): Promise<number[][]> {
  if (!embeddingModel) {
    return [];
  }
  if (embeddingCacheModel !== embeddingModel) {
    textEmbeddingCache.clear();
    pendingEmbeddingBatches.clear();
    embeddingCacheModel = embeddingModel;
  }

  const vectors: Array<number[] | null> = texts.map((text) =>
    getCachedEmbedding(text)
  );
  const missing = texts
    .map((text, index) => ({ index, text }))
    .filter(({ index }) => vectors[index] === null);

  if (missing.length > 0) {
    const startedAt = Date.now();
    const missingTexts = missing.map(({ text }) => text);
    const batchKey = JSON.stringify({
      model: getActiveEmbeddingModel().kind,
      texts: missingTexts,
    });
    let generationTask = pendingEmbeddingBatches.get(batchKey);
    if (!generationTask) {
      generationTask = embeddingModel.embedTexts
        ? embeddingModel.embedTexts(missingTexts)
        : (async () => {
            const sequential: number[][] = [];
            for (const text of missingTexts) {
              sequential.push(await embeddingModel.embedText(text));
            }
            return sequential;
          })();
      pendingEmbeddingBatches.set(batchKey, generationTask);
    }
    let generated: number[][];
    try {
      generated = await generationTask;
    } finally {
      if (pendingEmbeddingBatches.get(batchKey) === generationTask) {
        pendingEmbeddingBatches.delete(batchKey);
      }
    }
    timings.embedMs += Date.now() - startedAt;
    if (generated.length !== missing.length) {
      throw new Error("CLIP 批量文本向量数量不匹配");
    }

    const model = getActiveEmbeddingModel();
    for (let index = 0; index < missing.length; index++) {
      const item = missing[index];
      const vector = generated[index];
      if (!isValidEmbeddingVector(vector, model)) {
        throw new Error(
          `${model.displayName} 文本向量无效: expected=${model.vectorDimensions} actual=${vector.length}`
        );
      }
      vectors[item.index] = vector;
      setCachedEmbedding(item.text, vector);
    }
  }

  return vectors.filter((vector): vector is number[] => vector !== null);
}

interface MultiPromptSearchResult {
  candidateDepth: number;
  consensusCutoff: number;
  cutoffReason: string;
  finalCutoff: number;
  hasMore: boolean;
  promptGroupCount: number;
  rejectedWeak: number;
  results: RankedSemanticSearchResult[];
  strongAccepted: number;
  strongCutoff: number;
  supportCandidates: RankedSemanticSearchResult[];
  supportCutoff: number;
  supportedAccepted: number;
  topSimilarity: number;
}

async function multiPromptSearch(
  plan: SemanticQueryPlan,
  limit: number,
  timings: SearchTimings = { embedMs: 0, vectorMs: 0 }
): Promise<MultiPromptSearchResult> {
  if (!(embeddingModel && photoTable) || plan.prompts.length === 0) {
    return {
      candidateDepth: 0,
      consensusCutoff: 0,
      cutoffReason: "no-prompts",
      finalCutoff: 0,
      hasMore: false,
      promptGroupCount: 0,
      rejectedWeak: 0,
      results: [],
      supportCandidates: [],
      supportCutoff: 0,
      strongAccepted: 0,
      strongCutoff: 0,
      supportedAccepted: 0,
      topSimilarity: 0,
    };
  }

  const allTexts = [
    ...plan.prompts.map((prompt) => prompt.text),
    ...plan.negativePrompts,
  ];
  const vectors = await embedSearchTexts(allTexts, timings);
  const positiveVectors = vectors.slice(0, plan.prompts.length);
  const negativeVectors = vectors.slice(plan.prompts.length);
  const rowCount = await photoTable.countRows();
  const model = getActiveEmbeddingModel();
  const evidenceGroups = plan.prompts.map((prompt) => prompt.evidenceGroup);
  const promptGroupCount = new Set(evidenceGroups).size;
  const primaryPromptIndex = Math.max(
    0,
    plan.prompts.findIndex((prompt) => prompt.role === "primary")
  );
  const candidateMinimum =
    model.scoring.semanticSearch?.candidateMinimumSimilarity ?? 0.02;
  const candidateMaxDistance = 1 - candidateMinimum;
  let candidateDepth = Math.min(rowCount, Math.max(200, limit));

  while (candidateDepth > 0) {
    const vectorStartedAt = Date.now();
    const resultSets = await Promise.all(
      positiveVectors.map((vector) =>
        searchVector(vector, candidateDepth, candidateMaxDistance, rowCount)
      )
    );
    const negativeResultSets = await Promise.all(
      negativeVectors.map((vector) =>
        searchVector(vector, candidateDepth, candidateMaxDistance, rowCount)
      )
    );
    timings.vectorMs += Date.now() - vectorStartedAt;

    const fused = fuseRankedSearchEvidence(
      resultSets,
      rowCount,
      plan.prompts.map((prompt) => prompt.weight),
      evidenceGroups,
      primaryPromptIndex
    );
    const penalized = applyNegativeSemanticPenalty(
      fused,
      negativeResultSets,
      rowCount
    );
    const selection = selectRelevantSemanticResults(
      penalized,
      model,
      promptGroupCount,
      limit,
      {
        candidateTails: resultSets.map((results, index) => ({
          evidenceGroup: evidenceGroups[index],
          similarity: results.at(-1)?.similarity ?? 0,
        })),
        intent: plan.intent,
        primaryScores: resultSets[primaryPromptIndex]?.map(
          ({ similarity }) => similarity
        ),
        promptGroupCount,
      }
    );
    const exhausted = candidateDepth >= rowCount;
    const enoughForPage = selection.results.length >= limit;
    const hasMore =
      selection.acceptedCount > limit || (!exhausted && selection.canContinue);

    if (enoughForPage || exhausted || !selection.hasMoreCandidates) {
      console.log(
        `[AI] Semantic relevance: policy=${getSemanticPolicyVersion()} model=${model.kind} intent=${plan.intent} primary="${plan.prompts[primaryPromptIndex]?.text ?? ""}" prompts=${plan.rawPromptCount}->${plan.prompts.length} groups=${promptGroupCount} depth=${candidateDepth}/${rowCount} top=${selection.topSimilarity.toFixed(4)} cutoff=${selection.finalCutoff.toFixed(4)} reason=${selection.cutoffReason} strong=${selection.strongAccepted} supported=${selection.supportedAccepted} rejectedWeak=${selection.rejectedWeak} accepted=${selection.results.length} hasMore=${hasMore}`
      );
      return {
        candidateDepth,
        consensusCutoff: selection.consensusCutoff,
        cutoffReason: selection.cutoffReason,
        finalCutoff: selection.finalCutoff,
        hasMore,
        promptGroupCount,
        rejectedWeak: selection.rejectedWeak,
        results: selection.results,
        supportCandidates: selection.supportCandidates,
        supportCutoff: selection.supportCutoff,
        strongAccepted: selection.strongAccepted,
        strongCutoff: selection.strongCutoff,
        supportedAccepted: selection.supportedAccepted,
        topSimilarity: selection.topSimilarity,
      };
    }

    candidateDepth = Math.min(
      rowCount,
      Math.max(candidateDepth + 200, candidateDepth * 2)
    );
  }

  return {
    candidateDepth: 0,
    consensusCutoff: 0,
    cutoffReason: "no-candidates",
    finalCutoff: 0,
    hasMore: false,
    promptGroupCount,
    rejectedWeak: 0,
    results: [],
    supportCandidates: [],
    supportCutoff: 0,
    strongAccepted: 0,
    strongCutoff: 0,
    supportedAccepted: 0,
    topSimilarity: 0,
  };
}

// ── AI 文本搜索 TTL 缓存 ────────────────────────────────────────────
// 避免相同 query 短时间内反复触发 CLIP 文本推理（~50ms）+ LanceDB 搜索
interface SearchCacheEntry {
  result: SemanticTextSearchResult;
  timestamp: number;
}
const textSearchCache = new Map<string, SearchCacheEntry>();
const pendingTextSearches = new Map<
  string,
  Promise<SemanticTextSearchResult>
>();
const SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const MAX_SEARCH_CACHE = 30;
let warmedModel: typeof embeddingModel = null;
let warmedTable: typeof photoTable = null;
let searchCacheModel: typeof embeddingModel = null;
let searchCacheTable: typeof photoTable = null;

export function isAiSearchReady(): boolean {
  return (
    embeddingModel !== null &&
    photoTable !== null &&
    warmedModel === embeddingModel &&
    warmedTable === photoTable
  );
}

function getCachedSearch(cacheKey: string): SemanticTextSearchResult | null {
  const entry = textSearchCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.timestamp > SEARCH_CACHE_TTL) {
    textSearchCache.delete(cacheKey);
    return null;
  }
  // LRU: 命中时移到末尾
  textSearchCache.delete(cacheKey);
  textSearchCache.set(cacheKey, entry);
  return entry.result;
}

function setCachedSearch(
  cacheKey: string,
  result: SemanticTextSearchResult
): void {
  if (textSearchCache.size >= MAX_SEARCH_CACHE) {
    const lru = textSearchCache.keys().next().value;
    if (lru !== undefined) {
      textSearchCache.delete(lru);
    }
  }
  textSearchCache.delete(cacheKey);
  textSearchCache.set(cacheKey, { result, timestamp: Date.now() });
}

export async function searchByText(
  query: string,
  limit = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  return (await searchByTextWithPlan(query, limit)).results.map(
    ({ photoId, similarity }) => ({ photoId, similarity })
  );
}

export interface SemanticTextSearchResult {
  candidateDepth: number;
  consensusCutoff: number;
  cutoffReason: string;
  finalCutoff: number;
  hasMore: boolean;
  plan: SemanticQueryPlan;
  promptGroupCount: number;
  rejectedWeak: number;
  results: RankedSemanticSearchResult[];
  strongAccepted: number;
  strongCutoff: number;
  supportCandidates: RankedSemanticSearchResult[];
  supportCutoff: number;
  supportedAccepted: number;
  topSimilarity: number;
}

export async function searchByTextWithPlan(
  query: string,
  limit = 50
): Promise<SemanticTextSearchResult> {
  if (!query.trim()) {
    return {
      candidateDepth: 0,
      consensusCutoff: 0,
      cutoffReason: "empty-query",
      finalCutoff: 0,
      hasMore: false,
      plan: await prepareSemanticQueryPlan(""),
      promptGroupCount: 0,
      rejectedWeak: 0,
      results: [],
      supportCandidates: [],
      supportCutoff: 0,
      strongAccepted: 0,
      strongCutoff: 0,
      supportedAccepted: 0,
      topSimilarity: 0,
    };
  }

  const cacheKey = JSON.stringify({
    limit,
    model: getActiveEmbeddingModel().kind,
    policy: getSemanticPolicyVersion(),
    query: query.trim(),
    strategy: "hybrid-zh-v2",
    translation: getTranslationModelVersion(),
    version: SEMANTIC_QUERY_PLAN_VERSION,
  });
  const pending = pendingTextSearches.get(cacheKey);
  if (pending) {
    console.log(`[AI] searchByText IN-FLIGHT HIT: limit=${limit}`);
    return pending;
  }

  if (searchCacheModel !== embeddingModel || searchCacheTable !== photoTable) {
    textSearchCache.clear();
    searchCacheModel = embeddingModel;
    searchCacheTable = photoTable;
  }

  // TTL cache check — avoids redundant CLIP inference + LanceDB search
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`[AI] searchByText CACHE HIT: limit=${limit}`);
    return cached;
  }

  const searchPromise = performTextSearch(query, limit, cacheKey);
  pendingTextSearches.set(cacheKey, searchPromise);
  try {
    return await searchPromise;
  } finally {
    if (pendingTextSearches.get(cacheKey) === searchPromise) {
      pendingTextSearches.delete(cacheKey);
    }
  }
}

async function performTextSearch(
  query: string,
  limit: number,
  cacheKey: string
): Promise<SemanticTextSearchResult> {
  const totalStartedAt = Date.now();
  const timings: SearchTimings = { embedMs: 0, vectorMs: 0 };
  const initStartedAt = Date.now();

  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] searchByText: model load failed:", err?.message);
    return {
      candidateDepth: 0,
      consensusCutoff: 0,
      cutoffReason: "model-load-failed",
      finalCutoff: 0,
      hasMore: false,
      plan: await prepareSemanticQueryPlan(query, {
        translate: async () => "",
      }),
      promptGroupCount: 0,
      rejectedWeak: 0,
      results: [],
      supportCandidates: [],
      supportCutoff: 0,
      strongAccepted: 0,
      strongCutoff: 0,
      supportedAccepted: 0,
      topSimilarity: 0,
    };
  }

  await initVectorDB();
  const initMs = Date.now() - initStartedAt;

  if (!(embeddingModel && photoTable)) {
    console.warn("[AI] searchByText: AI not initialized");
    return {
      candidateDepth: 0,
      consensusCutoff: 0,
      cutoffReason: "ai-not-initialized",
      finalCutoff: 0,
      hasMore: false,
      plan: await prepareSemanticQueryPlan(query, {
        translate: async () => "",
      }),
      promptGroupCount: 0,
      rejectedWeak: 0,
      results: [],
      supportCandidates: [],
      supportCutoff: 0,
      strongAccepted: 0,
      strongCutoff: 0,
      supportedAccepted: 0,
      topSimilarity: 0,
    };
  }

  const parseStartedAt = Date.now();
  const plan = await getSemanticQueryPlan(query);
  const parseMs = Date.now() - parseStartedAt;
  const effectiveCacheKey = semanticQueryPlanCacheKey(
    plan,
    getActiveEmbeddingModel().kind,
    limit,
    getTranslationModelVersion()
  );
  const planCached = getCachedSearch(effectiveCacheKey);
  if (planCached) {
    setCachedSearch(cacheKey, planCached);
    return planCached;
  }
  const semanticSearch =
    plan.prompts.length > 0
      ? await multiPromptSearch(plan, limit, timings)
      : {
          candidateDepth: 0,
          consensusCutoff: 0,
          cutoffReason: "no-prompts",
          finalCutoff: 0,
          hasMore: false,
          promptGroupCount: 0,
          rejectedWeak: 0,
          results: [],
          supportCandidates: [],
          supportCutoff: 0,
          strongAccepted: 0,
          strongCutoff: 0,
          supportedAccepted: 0,
          topSimilarity: 0,
        };
  const searchResult = { plan, ...semanticSearch };

  setCachedSearch(cacheKey, searchResult);
  if (effectiveCacheKey !== cacheKey) {
    setCachedSearch(effectiveCacheKey, searchResult);
  }
  searchCacheModel = embeddingModel;
  searchCacheTable = photoTable;
  warmedModel = embeddingModel;
  warmedTable = photoTable;
  console.log(
    `[AI] searchByText timing: language=${plan.language} intent=${plan.intent} translation=${plan.translationMode} coverage=${Math.round(plan.coverage * 100)} prompts=${plan.rawPromptCount}->${plan.prompts.length} groups=${semanticSearch.promptGroupCount} negatives=${plan.negativePrompts.length} results=${semanticSearch.results.length} init=${initMs}ms parse=${parseMs}ms embed=${timings.embedMs}ms vector=${timings.vectorMs}ms total=${Date.now() - totalStartedAt}ms`
  );
  return searchResult;
}

let warmupPromise: Promise<void> | null = null;

export function warmupAiSearch(): Promise<void> {
  if (!warmupPromise) {
    warmupPromise = (async () => {
      const startedAt = Date.now();
      await loadModel();
      await initVectorDB();
      if (!(embeddingModel && photoTable)) {
        return;
      }

      const timings: SearchTimings = { embedMs: 0, vectorMs: 0 };
      const [vector] = await embedSearchTexts(["a photo"], timings);
      const rowCount = await photoTable.countRows();
      if (vector && rowCount > 0) {
        await photoTable
          .vectorSearch(vector)
          .distanceType("cosine")
          .limit(1)
          .toArray();
      }
      warmedModel = embeddingModel;
      warmedTable = photoTable;
      if (_localModelPath) {
        warmupTranslationWorker(_localModelPath).catch(() => undefined);
      }
      console.log(
        `[AI] Semantic search warmup completed in ${Date.now() - startedAt}ms`
      );
    })().finally(() => {
      warmupPromise = null;
    });
  }

  return warmupPromise;
}

export async function searchByImage(
  imagePath: string,
  limit = 20
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(imagePath && fs.existsSync(imagePath))) {
    console.warn("[AI] searchByImage: image file not found:", imagePath);
    return [];
  }

  await initVectorDB();

  if (!photoTable) {
    console.warn("[AI] searchByImage: AI not initialized");
    return [];
  }

  let localModelPath = _localModelPath;
  if (!localModelPath) {
    localModelPath = await ensureLocalModel();
    setLocalModelPath(localModelPath);
  }

  let queryVector: number[];
  try {
    const { embedSingleImage, isPoolReady } = await import(
      "@/services/embed-worker-pool"
    );
    if (isPoolReady()) {
      queryVector = await embedSingleImage(imagePath, localModelPath);
    } else {
      queryVector = await embedImageInWorker(imagePath, localModelPath);
    }
  } catch {
    try {
      queryVector = await embedImageInWorker(imagePath, localModelPath);
    } catch (fallbackErr: any) {
      console.error(
        "[AI] searchByImage: image embedding failed:",
        fallbackErr?.message
      );
      return [];
    }
  }

  const model = getActiveEmbeddingModel();
  if (!isValidEmbeddingVector(queryVector, model)) {
    console.error(
      `[AI] searchByImage rejected invalid ${model.displayName} query vector: expected=${model.vectorDimensions} actual=${queryVector.length}`
    );
    return [];
  }

  const rowCount = await photoTable.countRows();
  const adaptiveRefine = Math.min(
    10,
    Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
  );
  let rawResults: Record<string, unknown>[] = [];

  try {
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
      .limit(limit);
    rawResults = (await vq.toArray()) as Record<string, unknown>[];
  } catch (err: any) {
    console.error("[AI] searchByImage vectorSearch failed:", err?.message);
  }

  if (rawResults.length === 0) {
    return fallbackSearch(queryVector, limit);
  }

  return filterCosineSearchResults(
    rawResults.map((result) => ({
      distance: result._distance as number,
      photoId: result.photo_id as number,
    })),
    Number.POSITIVE_INFINITY,
    limit
  );
}
