import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WORKER_TIMEOUT } from "./constants";
import { ensureLocalModel, loadModel } from "./model-loader";
import { generateSearchPrompts, parseChineseQuery } from "./query-parser";
import {
  _localModelPath,
  embeddingModel,
  photoTable,
  setLocalModelPath,
} from "./state";
import { initVectorDB } from "./vector-db";

// --- Single-image worker embedding (avoids loading vision model in main process) ---

function findWorkerScript(): string {
  if (app.isPackaged) {
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "embed-worker.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  } else {
    const cwd = process.cwd();
    const candidate = path.join(cwd, "scripts", "embed-worker.mjs");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    const alt = path.join(app.getAppPath(), "scripts", "embed-worker.mjs");
    if (fs.existsSync(alt)) {
      return alt;
    }
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
      if (msg.type === "result" && !resolved) {
        resolved = true;
        clearTimeout(timeout);
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
      type: "embed",
      modelPath,
      photos: [{ id: 1, path: imagePath }],
    });
  });
}

// --- Paginated fallback search (never loads all vectors at once) ---

async function fallbackSearch(
  queryVector: number[],
  limit: number
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!photoTable) {
    return [];
  }

  const rowCount = await photoTable.countRows();

  if (rowCount > 1000) {
    console.log(
      `[AI] No results from index search. Library too large (${rowCount}) for brute-force. Returning empty.`
    );
    return [];
  }

  console.log(
    `[AI] Small library (${rowCount} rows), attempting paginated brute-force`
  );
  const PAGE_SIZE = 200;
  const MAX_PAGES = 5;
  const allScored: Array<{ photoId: number; distance: number }> = [];

  for (let page = 0; page < MAX_PAGES; page++) {
    const rows = await photoTable
      .query()
      .limit(PAGE_SIZE)
      .offset(page * PAGE_SIZE)
      .toArray();

    if (rows.length === 0) {
      break;
    }

    for (const row of rows as Array<Record<string, unknown>>) {
      const vec = row.vector as number[];
      if (!vec || vec.length !== queryVector.length) {
        continue;
      }
      let dot = 0;
      for (let i = 0; i < vec.length; i++) {
        dot += vec[i] * queryVector[i];
      }
      allScored.push({ photoId: row.photo_id as number, distance: 1 - dot });
    }
  }

  allScored.sort((a, b) => a.distance - b.distance);

  const MAX_DISTANCE = 0.75;
  return allScored
    .filter((r) => r.distance <= MAX_DISTANCE)
    .slice(0, limit)
    .map((r) => ({
      photoId: r.photoId,
      similarity: Math.round(Math.max(0, 1 - r.distance) * 10_000) / 10_000,
    }));
}

// --- Single vector search (one prompt → one embedding → LanceDB query) ---

async function singleVectorSearch(
  text: string,
  limit: number
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!(embeddingModel && photoTable)) {
    return [];
  }

  const queryVector = await embeddingModel.embedText(text);

  const rowCount = await photoTable.countRows();
  const adaptiveRefine = Math.min(
    10,
    Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
  );

  let rawResults: Array<Record<string, unknown>> = [];
  try {
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
      .limit(limit);
    rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;
  } catch (err: any) {
    console.error("[AI] vectorSearch failed:", err?.message);
  }

  if (rawResults.length === 0) {
    return fallbackSearch(queryVector, limit);
  }

  const MAX_COSINE_DISTANCE = 0.75;
  const filtered = rawResults.filter(
    (r) => (r._distance as number) <= MAX_COSINE_DISTANCE
  );

  if (filtered.length === 0) {
    console.log(
      `[AI] All ${rawResults.length} results above threshold ${MAX_COSINE_DISTANCE}, returning empty`
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

// --- Multi-prompt search with Reciprocal Rank Fusion ---

async function multiPromptSearch(
  prompts: string[],
  limit: number
): Promise<Array<{ photoId: number; similarity: number }>> {
  const resultSets = await Promise.all(
    prompts.map((p) => singleVectorSearch(p, limit * 2))
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

// --- Public API ---

export async function searchByText(
  query: string,
  limit = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (!query.trim()) {
    return [];
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

  if (hasChinese) {
    const parsed = parseChineseQuery(query);
    const prompts = generateSearchPrompts(parsed);

    console.log(
      `[AI] searchByText: "${query}" → ${prompts.length} prompts: ${JSON.stringify(prompts)}`
    );

    let results = await multiPromptSearch(prompts, limit);

    // Fallback: try raw query directly if multi-prompt returned nothing
    if (results.length === 0) {
      console.log("[AI] Multi-prompt returned 0, trying raw query embedding");
      results = await singleVectorSearch(query, limit);
    }

    return results;
  }

  // English query: single prompt
  const searchText = `a photo of ${query.trim()}`;
  console.log(`[AI] searchByText: en query → "${searchText}"`);
  return singleVectorSearch(searchText, limit);
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
  let rawResults: Array<Record<string, unknown>> = [];

  try {
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
      .limit(limit);
    rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;
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
