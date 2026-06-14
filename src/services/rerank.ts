import { inArray } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { embeddingModel } from "./ai/state";

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

// 从 LanceDB 批量读取向量
async function getPhotoVectors(
  photoIds: number[]
): Promise<Map<number, number[]>> {
  const { photoTable } = await import("./ai/state");

  if (!photoTable || photoIds.length === 0) {
    return new Map();
  }

  try {
    const db = getDatabase();

    // 获取 vectorId
    const photoRecords = db
      .select({ id: photos.id, vectorId: photos.vectorId })
      .from(photos)
      .where(inArray(photos.id, photoIds))
      .all();

    const vectorIdMap = new Map<string, number>();
    for (const record of photoRecords) {
      if (record.vectorId) {
        vectorIdMap.set(record.vectorId, record.id);
      }
    }

    if (vectorIdMap.size === 0) {
      return new Map();
    }

    // 从 LanceDB 批量查询向量
    const vectorIds = Array.from(vectorIdMap.keys());
    const results = new Map<number, number[]>();

    // 分批查询（每批 50 个）
    const BATCH_SIZE = 50;
    for (let i = 0; i < vectorIds.length; i += BATCH_SIZE) {
      const batch = vectorIds.slice(i, i + BATCH_SIZE);

      try {
        // 使用 photo_id IN (...) 而不是 vector_id
        const photoIdsBatch = batch
          .map((vectorId) => vectorIdMap.get(vectorId))
          .filter((id): id is number => id !== undefined);

        if (photoIdsBatch.length === 0) {
          continue;
        }

        const rows = await photoTable
          .query()
          .where(`photo_id IN (${photoIdsBatch.join(",")})`)
          .toArray();

        for (const row of rows as Array<Record<string, unknown>>) {
          const photoId = row.photo_id as number;
          if (!photoId) {
            continue;
          }

          const rawVec = row.vector;
          let vec: number[];

          // 标准化 LanceDB 向量格式
          if (Array.isArray(rawVec)) {
            vec = rawVec as number[];
          } else if (typeof (rawVec as any).toArray === "function") {
            vec = Array.from((rawVec as any).toArray());
          } else if (ArrayBuffer.isView(rawVec)) {
            vec = Array.from(rawVec as Float32Array);
          } else {
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

// 跨模态重排序：使用 CLIP Score 精排
export async function rerankWithCLIPScore(
  query: string,
  candidates: Array<{ photoId: number; similarity: number }>,
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
    } catch (err: any) {
      console.error("[Rerank] embedText failed:", err?.message);
      return candidates.slice(0, topK);
    }

    // 2. 批量获取候选照片的向量
    const photoIds = candidates.map((c) => c.photoId);
    const photoVectors = await getPhotoVectors(photoIds);

    if (photoVectors.size === 0) {
      console.warn("[Rerank] No photo vectors found, skip reranking");
      return candidates.slice(0, topK);
    }

    // 3. 计算 CLIP Score（余弦相似度）
    const scored = candidates
      .map((candidate) => {
        const photoVector = photoVectors.get(candidate.photoId);
        if (!photoVector) {
          return { ...candidate, clipScore: candidate.similarity };
        }

        const clipScore = cosineSimilarity(queryVector, photoVector);
        return {
          photoId: candidate.photoId,
          similarity: clipScore, // 更新为 CLIP Score
          clipScore,
        };
      })
      .filter((item) => item.clipScore > 0);

    // 4. 按 CLIP Score 重新排序
    scored.sort((a, b) => b.clipScore - a.clipScore);

    return scored.slice(0, topK);
  } catch (err) {
    console.error("[Rerank] Failed:", err);
    return candidates.slice(0, topK);
  }
}
