import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { MIN_VECTORS_FOR_INDEX, WORKER_TIMEOUT } from "./constants";
import { loadModel, ensureLocalModel } from "./model-loader";
import {
  _localModelPath,
  embeddingModel,
  photoTable,
  setLocalModelPath,
} from "./state";
import { initVectorDB } from "./vector-db";
import { ZH_TO_EN_SEARCH } from "./zh-en-dict";

// --- Single-image worker embedding (avoids loading vision model in main process) ---

function findWorkerScript(): string {
  // In dev mode, the .mjs file lives in the project's scripts/ directory
  if (app.isPackaged) {
    // Production: scripts are bundled as extraResources
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
    // Fallback: relative to app path
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

    // fork() inherits Electron's Node.js — no native-module version mismatch
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

// --- Search ---

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

  // Ensure vector index exists before searching
  try {
    const indices = await photoTable.listIndices();
    const hasIndex = indices.some(
      (idx: any) => idx.column === "vector" || idx.name === "vector_idx"
    );
    if (!hasIndex) {
      const rowCount = await photoTable.countRows();
      if (rowCount >= MIN_VECTORS_FOR_INDEX) {
        const { Index: LIdx } = await import("@lancedb/lancedb");
        console.log(
          `[AI] Creating vector index on ${rowCount} rows before search...`
        );
        await photoTable.createIndex("vector", {
          config: LIdx.ivfPq({
            numPartitions: Math.max(2, Math.floor(Math.sqrt(rowCount))),
            distanceType: "cosine",
          }),
        });
        console.log("[AI] Vector index created for search");
      } else {
        console.log(
          `[AI] Using brute-force search: ${rowCount} vectors < ${MIN_VECTORS_FOR_INDEX} threshold`
        );
      }
    }
  } catch (err: any) {
    console.warn(
      "[AI] Index check failed, attempting search anyway:",
      err?.message
    );
  }

  // Translate Chinese queries to English for better CLIP alignment.
  // CLIP ViT-B/32 was trained on natural-language image captions, not keyword
  // lists. We wrap translated terms in a CLIP-friendly prompt template and
  // deduplicate repeated words to produce cleaner embeddings.
  let searchText = query.trim();
  const hasChinese = /[一-鿿]/.test(searchText);
  if (hasChinese) {
    let translated = searchText;
    // Sort keys by length descending so longer phrases match first
    const sortedKeys = Object.keys(ZH_TO_EN_SEARCH).sort(
      (a, b) => b.length - a.length
    );
    for (const zh of sortedKeys) {
      if (translated.includes(zh)) {
        translated = translated.replace(
          new RegExp(zh, "g"),
          ZH_TO_EN_SEARCH[zh]
        );
      }
    }
    // Deduplicate repeated keywords from overlapping translations
    const words = translated.split(/\s+/);
    const seen = new Set<string>();
    const unique = words.filter((w) => {
      const lower = w.toLowerCase();
      if (seen.has(lower)) {
        return false;
      }
      seen.add(lower);
      return true;
    });
    // Strip any remaining untranslated CJK characters — CLIP VIT-B/32
    // only understands English, embedding Chinese produces noise.
    const englishOnly = unique.filter(
      (w) => !/[一-鿿㄀-鿿㐀-䶿]/.test(w)
    );
    if (englishOnly.length === 0) {
      // If nothing translated, use the raw query but let CLIP try
      searchText = query.trim();
    } else {
      // CLIP works best with short, natural descriptions
      const keywords = englishOnly.slice(0, 4).join(" ");
      searchText = `a photo of ${keywords}`;
    }
    console.log(`[AI] searchByText: zh→en "${query.trim()}" → "${searchText}"`);
  }

  const queryVector = await embeddingModel.embedText(searchText);
  console.log(
    `[AI] searchByText: query="${searchText}" vecLen=${queryVector.length}`
  );

  let rawResults: Array<Record<string, unknown>> = [];
  const rowCount = await photoTable.countRows();

  try {
    // Cosine distance + adaptive refineFactor for accurate ranking.
    // refineFactor re-ranks candidates with uncompressed vectors to correct
    // IVF_PQ quantization errors. Smaller datasets need MORE refinement
    // because fewer partitions mean coarser quantization.
    const adaptiveRefine = Math.min(
      10,
      Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
    );
    const vq = photoTable
      .vectorSearch(queryVector)
      .distanceType("cosine")
      .refineFactor(adaptiveRefine)
      .limit(limit);
    rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;
  } catch (err: any) {
    console.error("[AI] vectorSearch failed:", err?.message);
  }

  if (rawResults.length > 0) {
    const top5 = rawResults
      .slice(0, 5)
      .map((r) => Math.round((r._distance as number) * 10_000) / 10_000);
    console.log(
      `[AI] searchByText: LanceDB returned ${rawResults.length} results` +
        `, top-5 cosine-distances=[${top5.join(", ")}]`
    );
  }

  // Fallback: brute-force scan when vectorSearch returns nothing
  if (rawResults.length === 0) {
    // First fallback: if Chinese was translated but returned no results,
    // try embedding the original Chinese query directly
    if (hasChinese && searchText !== query.trim()) {
      console.log(
        `[AI] Translated search returned 0, trying original Chinese: "${query.trim()}"`
      );
      try {
        const zhVector = await embeddingModel.embedText(query.trim());
        const zhVq = photoTable
          .vectorSearch(zhVector)
          .distanceType("cosine")
          .refineFactor(
            Math.min(10, Math.max(3, Math.ceil(100 / Math.sqrt(rowCount))))
          )
          .limit(limit);
        rawResults = (await zhVq.toArray()) as Array<Record<string, unknown>>;
        if (rawResults.length > 0) {
          console.log(
            `[AI] Chinese fallback returned ${rawResults.length} results`
          );
        }
      } catch (fallbackErr: any) {
        console.error("[AI] Chinese fallback failed:", fallbackErr?.message);
      }
    }
  }

  // Second fallback: brute-force scan when both translated and Chinese return nothing
  if (rawResults.length === 0) {
    const rowCount2 = await photoTable.countRows();
    if (rowCount2 > 1) {
      console.log(
        `[AI] vectorSearch returned 0, falling back to brute-force scan (${rowCount2} rows)`
      );
      try {
        const allRows = await photoTable.query().toArray();
        const scored = (allRows as Array<Record<string, unknown>>)
          .filter(
            (r) =>
              Array.isArray(r.vector) && r.vector.length === queryVector.length
          )
          .map((r) => {
            const vec = r.vector as number[];
            // Normalized vectors: dot = cosine similarity, 1-dot = cosine distance
            let dot = 0;
            for (let i = 0; i < vec.length; i++) {
              dot += vec[i] * queryVector[i];
            }
            return { ...r, _distance: 1 - dot };
          })
          .sort((a, b) => (a._distance as number) - (b._distance as number))
          .slice(0, limit);
        rawResults = scored;
        console.log(
          `[AI] Brute-force fallback returned ${rawResults.length} results`
        );
      } catch (fallbackErr: any) {
        console.error(
          "[AI] Brute-force fallback also failed:",
          fallbackErr?.message
        );
      }
    }
  }

  if (rawResults.length === 0) {
    return [];
  }

  // cosine distance ∈ [0, 2]: 0 = identical, 1 = orthogonal, 2 = opposite.
  // Cosine similarity = 1 - cosine_distance
  // CLIP ViT-B/32: good matches typically cosine similarity 0.25-0.40
  //   → cosine distance 0.60-0.75. Threshold 0.75 = similarity ≥ 0.25.
  const MAX_COSINE_DISTANCE = 0.75;
  const filtered = rawResults.filter(
    (r: Record<string, unknown>) => (r._distance as number) <= MAX_COSINE_DISTANCE
  );

  if (filtered.length === 0 && rawResults.length > 0) {
    // No results pass the similarity threshold — return empty instead of
    // showing irrelevant photos. The user can refine their search terms.
    console.log(
      `[AI] searchByText: all ${rawResults.length} results above threshold ${MAX_COSINE_DISTANCE}, returning empty (no relevant matches)`
    );
    return [];
  }

  return filtered.map((r: Record<string, unknown>) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
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

  // Image embedding: prefer persistent worker pool, fallback to single fork
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
  } catch (err: any) {
    try {
      queryVector = await embedImageInWorker(imagePath, localModelPath);
    } catch (fallbackErr: any) {
      console.error("[AI] searchByImage: image embedding failed:", fallbackErr?.message);
      return [];
    }
  }

  const rowCount = await photoTable.countRows();
  const adaptiveRefine = Math.min(
    10,
    Math.max(3, Math.ceil(100 / Math.sqrt(Math.max(rowCount, 1))))
  );
  const vq = photoTable
    .vectorSearch(queryVector)
    .distanceType("cosine")
    .refineFactor(adaptiveRefine)
    .limit(limit);
  let rawResults = (await vq.toArray()) as Array<Record<string, unknown>>;

  // Brute-force fallback when vector index search returns empty
  if (rawResults.length === 0) {
    console.log("[AI] searchByImage: index search empty, trying brute-force...");
    try {
      const allRows = await photoTable.query().toArray();
      const allData = allRows.map((r: any) => ({
        photo_id: r.photo_id as number,
        vector: Array.from(r.vector as Float32Array),
      }));
      const scored = allData.map((r: { photo_id: number; vector: number[] }) => {
        let dot = 0;
        let normA = 0;
        let normB = 0;
        for (let i = 0; i < queryVector.length; i++) {
          dot += queryVector[i] * r.vector[i];
          normA += queryVector[i] * queryVector[i];
          normB += r.vector[i] * r.vector[i];
        }
        const sim = dot / (Math.sqrt(normA) * Math.sqrt(normB));
        return { photo_id: r.photo_id, _distance: 1 - sim };
      });
      scored.sort((a: { _distance: number }, b: { _distance: number }) => a._distance - b._distance);
      rawResults = scored.slice(0, limit) as unknown as Array<Record<string, unknown>>;
    } catch (bfErr: any) {
      console.warn("[AI] searchByImage: brute-force fallback failed:", bfErr?.message);
    }
  }

  if (rawResults.length === 0) {
    return [];
  }

  return rawResults.map((r: Record<string, unknown>) => {
    const cosDist = r._distance as number;
    const similarity = Math.max(0, 1 - cosDist);
    return {
      photoId: r.photo_id as number,
      similarity: Math.round(similarity * 10_000) / 10_000,
    };
  });
}
