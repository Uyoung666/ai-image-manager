import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WORKER_TIMEOUT } from "./constants";
import {
  getActiveEmbeddingModel,
  getTextSearchMaxCosineDistance,
} from "./model-config";
import { ensureLocalModel, loadModel } from "./model-loader";
import {
  generateSearchPrompts,
  getQueryCoverage,
  parseChineseQuery,
} from "./query-parser";
import {
  filterCosineSearchResults,
  fuseRankedSearchResults,
  isValidEmbeddingVector,
} from "./scoring";
import {
  _localModelPath,
  embeddingModel,
  photoTable,
  setLocalModelPath,
} from "./state";
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

// 自适应阈值范围：覆盖率 0% → 0.22, 覆盖率 100% → 0.55
// 中文 CLIP 零样本余弦距离天然偏高（0.4–0.7），过严阈值会导致全部过滤。
// 放宽下限确保抽象词汇也能返回结果，同时保留覆盖率越高阈值越严的趋势。
function adaptiveThreshold(coverage: number): number {
  return getTextSearchMaxCosineDistance(coverage, "zh");
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
  const queryLimit =
    model.kind === "siglip" ? Math.min(Math.max(limit * 4, limit), 200) : limit;
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
    const generated = embeddingModel.embedTexts
      ? await embeddingModel.embedTexts(missing.map(({ text }) => text))
      : await (async () => {
          const sequential: number[][] = [];
          for (const { text } of missing) {
            sequential.push(await embeddingModel.embedText(text));
          }
          return sequential;
        })();
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

async function singleVectorSearch(
  text: string,
  limit: number,
  maxCosineDistance = 0.75,
  timings: SearchTimings = { embedMs: 0, vectorMs: 0 }
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(embeddingModel && photoTable)) {
    return [];
  }

  try {
    const [queryVector] = await embedSearchTexts([text], timings);
    if (!queryVector) {
      return [];
    }
    const vectorStartedAt = Date.now();
    const rowCount = await photoTable.countRows();
    const results = await searchVector(
      queryVector,
      limit,
      maxCosineDistance,
      rowCount
    );
    timings.vectorMs += Date.now() - vectorStartedAt;
    return results;
  } catch (err: any) {
    console.error("[AI] text vector search failed:", err?.message);
    return [];
  }
}

async function multiPromptSearch(
  prompts: string[],
  limit: number,
  maxCosineDistance = 0.75,
  timings: SearchTimings = { embedMs: 0, vectorMs: 0 }
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(embeddingModel && photoTable)) {
    return [];
  }

  const vectors = await embedSearchTexts(prompts, timings);
  const vectorStartedAt = Date.now();
  const rowCount = await photoTable.countRows();
  const candidateLimit = Math.min(limit * 2, 200);
  const resultSets = await Promise.all(
    vectors.map((vector) =>
      searchVector(vector, candidateLimit, maxCosineDistance, rowCount)
    )
  );
  timings.vectorMs += Date.now() - vectorStartedAt;

  return fuseRankedSearchResults(resultSets, limit);
}

// ── AI 文本搜索 TTL 缓存 ────────────────────────────────────────────
// 避免相同 query 短时间内反复触发 CLIP 文本推理（~50ms）+ LanceDB 搜索
interface SearchCacheEntry {
  result: Array<{ photoId: number; similarity: number }>;
  timestamp: number;
}
const textSearchCache = new Map<string, SearchCacheEntry>();
const pendingTextSearches = new Map<
  string,
  Promise<Array<{ photoId: number; similarity: number }>>
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

function getCachedSearch(
  cacheKey: string
): Array<{ photoId: number; similarity: number }> | null {
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
  result: Array<{ photoId: number; similarity: number }>
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
  if (!query.trim()) {
    return [];
  }

  const cacheKey = `${query.trim()}_${limit}`;
  const pending = pendingTextSearches.get(cacheKey);
  if (pending) {
    console.log(`[AI] searchByText IN-FLIGHT HIT: "${query}" limit=${limit}`);
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
    console.log(`[AI] searchByText CACHE HIT: "${query}" limit=${limit}`);
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
): Promise<Array<{ photoId: number; similarity: number }>> {
  const totalStartedAt = Date.now();
  const timings: SearchTimings = { embedMs: 0, vectorMs: 0 };
  const initStartedAt = Date.now();

  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] searchByText: model load failed:", err?.message);
    return [];
  }

  await initVectorDB();
  const initMs = Date.now() - initStartedAt;

  if (!(embeddingModel && photoTable)) {
    console.warn("[AI] searchByText: AI not initialized");
    return [];
  }

  const hasChinese = /[一-鿿]/.test(query);
  let results: Array<{ photoId: number; similarity: number }>;
  const parseStartedAt = Date.now();
  let parseMs = 0;

  if (hasChinese) {
    const parsed = parseChineseQuery(query);
    const coverage = getQueryCoverage(query, parsed);
    const threshold = adaptiveThreshold(coverage);
    // 始终将原始 query 传入 generateSearchPrompts 作为 Zero-Shot 兜底
    const prompts = generateSearchPrompts(parsed, query);
    parseMs = Date.now() - parseStartedAt;

    console.log(
      `[AI] searchByText: "${query}" → coverage=${(coverage * 100).toFixed(0)}% threshold=${threshold.toFixed(2)} prompts=${prompts.length}: ${JSON.stringify(prompts)}`
    );

    if (prompts.length > 0) {
      results = await multiPromptSearch(prompts, limit, threshold, timings);
    } else {
      // 极端情况：连 raw query 都没有生成 prompt（query 被完全过滤为空白）
      results = await singleVectorSearch(query, limit, threshold, timings);
    }
  } else {
    // English query: single prompt
    const searchText = `a photo of ${query.trim()}`;
    parseMs = Date.now() - parseStartedAt;
    console.log(`[AI] searchByText: en query → "${searchText}"`);
    results = await singleVectorSearch(
      searchText,
      limit,
      getTextSearchMaxCosineDistance(1, "en"),
      timings
    );
  }

  setCachedSearch(cacheKey, results);
  searchCacheModel = embeddingModel;
  searchCacheTable = photoTable;
  warmedModel = embeddingModel;
  warmedTable = photoTable;
  console.log(
    `[AI] searchByText timing: init=${initMs}ms parse=${parseMs}ms embed=${timings.embedMs}ms vector=${timings.vectorMs}ms total=${Date.now() - totalStartedAt}ms`
  );
  return results;
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
