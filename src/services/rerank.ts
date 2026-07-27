import { embeddingModel } from "./ai/state";

// 晚期融合：S_final = α·S_exact·sourceBoost + β·S_clip
const ALPHA_EXACT = 0.35;
const BETA_CLIP = 0.65;
const SOURCE_BOOST: Record<string, number> = {
  person: 1.5, // 人脸识别强信号
  tag: 1.2,
  filename: 1.1,
  ai: 1.0,
};

// 计算余弦相似度
function cosineSimilarity(vecA: number[], vecB: number[]): number {
  if (vecA.length !== vecB.length) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }

  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);

  if (normA === 0 || normB === 0) {
    return 0;
  }

  return dotProduct / (normA * normB);
}

function toNumberVector(rawVector: unknown): number[] | null {
  if (Array.isArray(rawVector)) {
    return rawVector.every((value) => typeof value === "number")
      ? rawVector
      : null;
  }
  if (
    rawVector &&
    typeof rawVector === "object" &&
    "toArray" in rawVector &&
    typeof rawVector.toArray === "function"
  ) {
    return Array.from(rawVector.toArray() as Iterable<number>);
  }
  if (ArrayBuffer.isView(rawVector) && !(rawVector instanceof DataView)) {
    return Array.from(rawVector as unknown as ArrayLike<number>);
  }
  return null;
}

// 从 LanceDB 批量读取向量
async function getPhotoVectors(
  photoIds: number[]
): Promise<Map<number, number[]>> {
  const { photoTable } = await import("./ai/state");

  const validPhotoIds = [
    ...new Set(
      photoIds.filter((photoId) => Number.isSafeInteger(photoId) && photoId > 0)
    ),
  ];
  if (!photoTable || validPhotoIds.length === 0) {
    return new Map();
  }

  try {
    const results = new Map<number, number[]>();

    // 分批查询（每批 50 个）
    const BATCH_SIZE = 50;
    for (let i = 0; i < validPhotoIds.length; i += BATCH_SIZE) {
      const batch = validPhotoIds.slice(i, i + BATCH_SIZE);

      try {
        const rows = await photoTable
          .query()
          .where(`photo_id IN (${batch.join(",")})`)
          .toArray();

        for (const row of rows as Record<string, unknown>[]) {
          const photoId = row.photo_id as number;
          if (!photoId) {
            continue;
          }

          const vec = toNumberVector(row.vector);
          if (!vec) {
            continue;
          }

          results.set(photoId, vec);
        }
      } catch (err) {
        console.error("[Rerank] Batch query failed:", err);
      }
    }

    return results;
  } catch (err) {
    console.error("[Rerank] Get vectors failed:", err);
    return new Map();
  }
}

/** 跨模态晚期融合：S_final = α·S_exact·sourceBoost + β·S_clip，不覆盖精确语义 */
export async function rerankWithCLIPScore(
  query: string,
  candidates: Array<{
    photoId: number;
    similarity: number;
    /** 可选：召回来源标记，用于语义提权 */
    _source?: "person" | "tag" | "filename" | "ai";
  }>,
  topK = 50
): Promise<Array<{ photoId: number; similarity: number }>> {
  if (candidates.length === 0 || !query.trim()) {
    return candidates;
  }

  try {
    // 确保模型已加载
    if (!embeddingModel) {
      console.warn("[Rerank] Embedding model not loaded, skip reranking");
      return candidates.slice(0, topK);
    }

    // 1. 获取查询向量
    let queryVector: number[];
    try {
      queryVector = await embeddingModel.embedText(query.trim());
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("[Rerank] embedText failed:", message);
      return candidates.slice(0, topK);
    }

    // 2. 批量获取候选照片的向量
    const photoIds = candidates.map((c) => c.photoId);
    const photoVectors = await getPhotoVectors(photoIds);

    if (photoVectors.size === 0) {
      console.warn(
        "[Rerank] No photo vectors found, returning original scores"
      );
      return candidates.slice(0, topK);
    }

    // 3. 晚期融合
    const scored = candidates.map((candidate) => {
      const photoVector = photoVectors.get(candidate.photoId);
      const sExact = candidate.similarity;

      if (!photoVector) {
        return { photoId: candidate.photoId, similarity: sExact };
      }

      const sClip = Math.max(0, cosineSimilarity(queryVector, photoVector));
      const boost = SOURCE_BOOST[candidate._source ?? "ai"] ?? 1.0;
      const sFinal = ALPHA_EXACT * sExact * boost + BETA_CLIP * sClip;

      return {
        photoId: candidate.photoId,
        similarity: Math.round(sFinal * 10_000) / 10_000,
      };
    });

    // 4. 按融合分数降序排列
    scored.sort((a, b) => b.similarity - a.similarity);

    return scored.slice(0, topK);
  } catch (err) {
    console.error("[Rerank] Failed:", err);
    return candidates.slice(0, topK);
  }
}
