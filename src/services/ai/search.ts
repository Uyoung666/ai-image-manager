import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WORKER_TIMEOUT } from "./constants";
import { ensureLocalModel, loadModel } from "./model-loader";
import {
  generateSearchPrompts,
  getQueryCoverage,
  parseChineseQuery,
} from "./query-parser";
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

    child.send({ type: "init", modelPath });
  });
}

// 自适应阈值范围：覆盖率 0% → 0.22, 覆盖率 100% → 0.55
// 中文 CLIP 零样本余弦距离天然偏高（0.4–0.7），过严阈值会导致全部过滤。
// 放宽下限确保抽象词汇也能返回结果，同时保留覆盖率越高阈值越严的趋势。
function adaptiveThreshold(coverage: number): number {
  return 0.22 + coverage * 0.33;
}

async function fallbackSearch(
  queryVector: number[],
  limit: number,
  maxDistance = 0.75
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!photoTable) {
    return [];
  }

  const rowCount = await photoTable.countRows();

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
      if (vec && vec.length === 512) {
        const photoId = row.photo_id as number;
        let dot = 0;
        let normQ = 0;
        let normV = 0;
        for (let i = 0; i < 512; i++) {
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

async function singleVectorSearch(
  text: string,
  limit: number,
  maxCosineDistance = 0.75
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(embeddingModel && photoTable)) {
    return [];
  }

  let queryVector: number[];
  try {
    queryVector = await embeddingModel.embedText(text);
  } catch (err: any) {
    console.error("[AI] embedText failed:", err?.message);
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
    console.error("[AI] vectorSearch failed:", err?.message);
  }

  if (rawResults.length === 0) {
    return fallbackSearch(queryVector, limit, maxCosineDistance);
  }

  const filtered = rawResults.filter(
    (r) => (r._distance as number) <= maxCosineDistance
  );

  if (filtered.length === 0) {
    console.log(
      `[AI] All ${rawResults.length} results above threshold ${maxCosineDistance}, returning empty`
    );
    return [];
  }

  return filtered.map((r) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
}

async function multiPromptSearch(
  prompts: string[],
  limit: number,
  maxCosineDistance = 0.75
): Promise<Array<{ photoId: number; similarity: number }>> {
  const resultSets = await Promise.all(
    prompts.map((p) => singleVectorSearch(p, limit * 2, maxCosineDistance))
  );

  const weights = [1.0, 0.7, 0.5];
  const k = 60;
  const scores = new Map<number, number>();

  for (let i = 0; i < resultSets.length; i++) {
    const w = weights[Math.min(i, weights.length - 1)];
    for (let rank = 0; rank < resultSets[i].length; rank++) {
      const { photoId, similarity } = resultSets[i][rank];
      const rrfScore = w / (k + rank + 1);
      const combined = rrfScore + similarity * w * 0.05;
      scores.set(photoId, (scores.get(photoId) || 0) + combined);
    }
  }

  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([photoId, score]) => ({
      photoId,
      similarity: Math.round(score * 10_000) / 10_000,
    }));
}

// ── AI 文本搜索 TTL 缓存 ────────────────────────────────────────────
// 避免相同 query 短时间内反复触发 CLIP 文本推理（~50ms）+ LanceDB 搜索
interface SearchCacheEntry {
  result: Array<{ photoId: number; similarity: number }>;
  timestamp: number;
}
const textSearchCache = new Map<string, SearchCacheEntry>();
const SEARCH_CACHE_TTL = 2 * 60 * 1000; // 2 minutes
const MAX_SEARCH_CACHE = 30;

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

  // TTL cache check — avoids redundant CLIP inference + LanceDB search
  const cacheKey = `${query.trim()}_${limit}`;
  const cached = getCachedSearch(cacheKey);
  if (cached) {
    console.log(`[AI] searchByText CACHE HIT: "${query}" limit=${limit}`);
    return cached;
  }

  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] searchByText: model load failed:", err?.message);
    return [];
  }

  await initVectorDB();

  if (!(embeddingModel && photoTable)) {
    console.warn("[AI] searchByText: AI not initialized");
    return [];
  }

  const hasChinese = /[一-鿿]/.test(query);
  let results: Array<{ photoId: number; similarity: number }>;

  if (hasChinese) {
    const parsed = parseChineseQuery(query);
    const coverage = getQueryCoverage(query, parsed);
    const threshold = adaptiveThreshold(coverage);
    // 始终将原始 query 传入 generateSearchPrompts 作为 Zero-Shot 兜底
    const prompts = generateSearchPrompts(parsed, query);

    console.log(
      `[AI] searchByText: "${query}" → coverage=${(coverage * 100).toFixed(0)}% threshold=${threshold.toFixed(2)} prompts=${prompts.length}: ${JSON.stringify(prompts)}`
    );

    if (prompts.length > 0) {
      results = await multiPromptSearch(prompts, limit, threshold);
    } else {
      // 极端情况：连 raw query 都没有生成 prompt（query 被完全过滤为空白）
      results = await singleVectorSearch(query, limit, threshold);
    }
  } else {
    // English query: single prompt
    const searchText = `a photo of ${query.trim()}`;
    console.log(`[AI] searchByText: en query → "${searchText}"`);
    results = await singleVectorSearch(searchText, limit);
  }

  setCachedSearch(cacheKey, results);
  return results;
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

  return rawResults.map((r) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
}
