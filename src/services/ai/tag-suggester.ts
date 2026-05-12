import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photoTags, tags } from "@/db/schema";
import { cosineSimilarity } from "./constants";
import { loadModel, ensureLocalModel } from "./model-loader";
import { embedImageInWorker } from "./search";
import {
  _localModelPath,
  embeddingModel,
  setLocalModelPath,
} from "./state";
import { initVectorDB, getPhotoVectors } from "./vector-db";

// --- Zero-shot tag suggestion ---
//
// CLIP ViT-B/32 was trained on English image-text pairs. English tags
// produce far better alignment with image embeddings than Chinese tags.
// We embed English text but display Chinese labels to the user.

export const CANDIDATE_TAGS: Array<{ en: string; zh: string }> = [
  // Scenes
  { en: "indoor room", zh: "室内" },
  { en: "outdoor outside", zh: "户外" },
  { en: "city urban", zh: "城市" },
  { en: "nature landscape scenery", zh: "自然风景" },
  { en: "beach ocean sea", zh: "海滩" },
  { en: "mountain hill", zh: "山脉" },
  { en: "forest woods trees", zh: "森林" },
  { en: "street road", zh: "街道" },
  { en: "architecture building", zh: "建筑" },
  { en: "garden flowers", zh: "花园" },
  { en: "field meadow grass", zh: "田野" },
  { en: "lake water", zh: "湖泊" },
  { en: "river stream", zh: "河流" },
  { en: "sky clouds", zh: "天空" },
  { en: "night scene dark", zh: "夜景" },
  // Subjects
  { en: "person people human", zh: "人物" },
  { en: "animal wildlife", zh: "动物" },
  { en: "cat kitten", zh: "猫咪" },
  { en: "dog puppy", zh: "狗狗" },
  { en: "bird", zh: "鸟类" },
  { en: "car vehicle automobile", zh: "汽车" },
  { en: "flower blossom", zh: "花卉" },
  { en: "food meal dish", zh: "食物" },
  { en: "tree plant", zh: "树木" },
  { en: "water surface reflection", zh: "水面" },
  { en: "text document writing", zh: "文字" },
  { en: "screenshot screen ui", zh: "屏幕截图" },
  { en: "document paper", zh: "文档" },
  // Objects
  { en: "cup glass mug drink beverage", zh: "杯具饮品" },
  { en: "phone smartphone cellphone", zh: "手机" },
  { en: "computer laptop pc", zh: "电脑" },
  { en: "book reading", zh: "书籍" },
  { en: "chair table furniture", zh: "家具" },
  // Time / Lighting
  { en: "daytime sunny bright", zh: "白天" },
  { en: "night dark", zh: "夜晚" },
  { en: "sunset dusk evening", zh: "黄昏" },
  { en: "sunrise dawn morning", zh: "日出" },
  { en: "sunset evening", zh: "日落" },
  { en: "backlight silhouette", zh: "逆光" },
  // Style
  { en: "black and white monochrome", zh: "黑白" },
  { en: "vivid colorful saturated", zh: "鲜艳" },
  { en: "dark moody low key", zh: "暗调" },
  { en: "bright high key", zh: "亮调" },
  { en: "macro close-up detail", zh: "微距" },
  { en: "blurred background bokeh depth of field", zh: "虚化背景" },
  // Colors
  { en: "red color", zh: "红色调" },
  { en: "blue color", zh: "蓝色调" },
  { en: "green color", zh: "绿色调" },
  { en: "yellow color", zh: "黄色调" },
  { en: "white color", zh: "白色调" },
  { en: "black color", zh: "黑色调" },
];

// Scene tags are broad concepts that tend to match almost any photo with
// moderate similarity. We apply a higher threshold to prevent them from
// dominating every photo's suggested tags (e.g. "indoor/outdoor/city" on every image).
const SCENE_TAG_NAMES = new Set([
  "indoor room", "outdoor outside", "city urban",
  "nature landscape scenery", "beach ocean sea", "mountain hill",
  "forest woods trees", "street road", "sky clouds",
  "night scene dark", "field meadow grass", "lake water", "river stream",
]);

const SUGGEST_SCENE_MULTIPLIER = 1.4;

// Pre-computed text embeddings for candidate tags (computed once after model load)
let cachedTagEmbeddings: Array<{
  tag: string;
  displayName: string;
  vector: number[];
}> | null = null;

// In-memory LRU cache for recently queried image vectors (tag suggestion).
// Avoids repeated LanceDB lookups or worker embedding for the same photo.
const imageVecCache = new Map<number, number[]>();
const IMAGE_VEC_CACHE_MAX = 100;

export async function suggestTags(
  imagePath: string,
  threshold = 0.28,
  photoId?: number
): Promise<Array<{ tag: string; confidence: number }>> {
  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] suggestTags: model load failed:", err?.message);
    return [];
  }

  if (!embeddingModel) {
    console.warn("[AI] suggestTags: AI not initialized");
    return [];
  }

  let localModelPath = _localModelPath;
  if (!localModelPath) {
    localModelPath = await ensureLocalModel();
    setLocalModelPath(localModelPath);
  }

  // Pre-compute tag text embeddings once (main process, text model only).
  // Embed English text for CLIP compatibility; display Chinese to the user.
  if (cachedTagEmbeddings === null) {
    const fresh: Array<{
      tag: string;
      displayName: string;
      vector: number[];
    }> = [];
    for (const { en, zh } of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(en);
        fresh.push({ tag: en, displayName: zh, vector: textVec });
      } catch (err: any) {
        console.error(`[AI] Tag embedding failed for "${en}":`, err?.message);
      }
    }
    if (fresh.length > 0) {
      cachedTagEmbeddings = fresh;
    }
    console.log(
      `[AI] Pre-computed ${fresh.length}/${CANDIDATE_TAGS.length} tag embeddings (English text)`
    );
  }

  // Resolve image vector: check in-memory cache → LanceDB → worker embedding
  let imageVec: number[] | null = null;

  if (photoId != null) {
    // 1) In-memory LRU cache
    const cached = imageVecCache.get(photoId);
    if (cached) {
      imageVec = cached;
    }
  }

  if (!imageVec && photoId != null) {
    // 2) LanceDB lookup (already-computed embedding from embedAllPhotos)
    try {
      await initVectorDB();
      const vectors = await getPhotoVectors([photoId]);
      const vec = vectors.get(photoId);
      if (vec) {
        imageVec = vec;
        // Promote to in-memory cache
        if (imageVecCache.size >= IMAGE_VEC_CACHE_MAX) {
          const firstKey = imageVecCache.keys().next().value;
          if (firstKey !== undefined) {
            imageVecCache.delete(firstKey);
          }
        }
        imageVecCache.set(photoId, vec);
      }
    } catch {
      // LanceDB unavailable — fall through to worker
    }
  }

  if (!imageVec) {
    // 3) Worker embedding (no cached vector available)
    try {
      imageVec = await embedImageInWorker(imagePath, localModelPath);
      if (photoId != null && imageVec) {
        if (imageVecCache.size >= IMAGE_VEC_CACHE_MAX) {
          const firstKey = imageVecCache.keys().next().value;
          if (firstKey !== undefined) {
            imageVecCache.delete(firstKey);
          }
        }
        imageVecCache.set(photoId, imageVec);
      }
    } catch (err: any) {
      console.error("[AI] suggestTags: image embedding failed:", err?.message);
      return [];
    }
  }

  const results: Array<{ tag: string; confidence: number }> = [];

  if (cachedTagEmbeddings) {
    for (const { tag, displayName, vector } of cachedTagEmbeddings) {
      const sim = cosineSimilarity(imageVec, vector);
      const effectiveThreshold = SCENE_TAG_NAMES.has(tag)
        ? threshold * SUGGEST_SCENE_MULTIPLIER
        : threshold;
      if (sim >= effectiveThreshold) {
        results.push({
          tag: displayName,
          confidence: Math.round(sim * 100) / 100,
        });
      }
    }
  }

  results.sort((a, b) => b.confidence - a.confidence);
  // If no results above threshold, return top 5 with highest similarity
  // as low-confidence suggestions so the user has a starting point.
  // Scene tags still get a multiplier in the fallback to avoid always
  // returning "indoor/outdoor/city" for every photo.
  if (results.length === 0 && cachedTagEmbeddings) {
    const allScores = cachedTagEmbeddings
      .map(({ tag, displayName, vector }) => ({
        tag: displayName,
        confidence: Math.round(cosineSimilarity(imageVec!, vector) * 100) / 100,
        isScene: SCENE_TAG_NAMES.has(tag),
      }));
    allScores.sort((a, b) => b.confidence - a.confidence);
    const fallback = allScores
      .slice(0, 8)
      .filter((s) => {
        const minScore = s.isScene ? 0.15 * SUGGEST_SCENE_MULTIPLIER : 0.15;
        return s.confidence >= minScore;
      })
      .slice(0, 3);
    if (fallback.length > 0) {
      return fallback.map(({ tag, confidence }) => ({ tag, confidence }));
    }
    return [];
  }

  return results.slice(0, 10);
}

// --- Batch tag suggestion (post-embedding) ---
// Called after embedAllPhotos completes to auto-tag photos using pre-computed
// LanceDB vectors instead of expensive per-photo worker embedding.
// Scene tags (indoor/outdoor/city) get a higher threshold to prevent
// every photo from being tagged with them.

const BASE_THRESHOLD = 0.30;
const SCENE_THRESHOLD_MULTIPLIER = 1.4;
const MAX_AUTO_TAGS_PER_PHOTO = 5;
const MIN_CONFIRMED_SIMILARITY = 0.38;

export async function batchSuggestTags(
  photoIds: number[],
): Promise<{ tagged: number; skipped: number }> {
  const db = getDatabase();

  try {
    await loadModel();
  } catch {
    return { tagged: 0, skipped: photoIds.length };
  }

  if (!embeddingModel || !_localModelPath) {
    return { tagged: 0, skipped: photoIds.length };
  }

  // Pre-compute tag embeddings once
  if (cachedTagEmbeddings === null) {
    const fresh: Array<{ tag: string; displayName: string; vector: number[] }> = [];
    for (const { en, zh } of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(en);
        fresh.push({ tag: en, displayName: zh, vector: textVec });
      } catch { /* skip individual tag */ }
    }
    if (fresh.length > 0) cachedTagEmbeddings = fresh;
  }

  if (!cachedTagEmbeddings) {
    return { tagged: 0, skipped: photoIds.length };
  }

  // Batch-fetch vectors from LanceDB
  await initVectorDB();
  const vectors = await getPhotoVectors(photoIds);

  let tagged = 0;
  let skipped = 0;
  const tagColors = [
    "#5e6ad2", "#46a758", "#ffb224", "#e5484d",
    "#7c7fe0", "#3b9ec6", "#d97a3e", "#a855f7",
  ];

  for (const photoId of photoIds) {
    const imageVec = vectors.get(photoId);
    if (!imageVec) { skipped++; continue; }

    const scored: Array<{ displayName: string; tag: string; confidence: number }> = [];
    for (const { tag, displayName, vector } of cachedTagEmbeddings) {
      const sim = cosineSimilarity(imageVec, vector);
      const threshold = SCENE_TAG_NAMES.has(tag)
        ? BASE_THRESHOLD * SCENE_THRESHOLD_MULTIPLIER
        : BASE_THRESHOLD;
      if (sim >= threshold) {
        scored.push({ displayName, tag, confidence: Math.round(sim * 100) / 100 });
      }
    }
    scored.sort((a, b) => b.confidence - a.confidence);
    // Cap to top N tags
    const topTags = scored.slice(0, MAX_AUTO_TAGS_PER_PHOTO);

    for (const s of topTags) {
      const isConfirmed = s.confidence >= MIN_CONFIRMED_SIMILARITY;
      try {
        let hash = 0;
        for (let i = 0; i < s.displayName.length; i++) {
          hash = s.displayName.charCodeAt(i) + ((hash << 5) - hash);
        }
        const tagColor = tagColors[Math.abs(hash) % tagColors.length];

        const existingTag = db
          .select({ id: tags.id })
          .from(tags)
          .where(eq(tags.name, s.displayName))
          .get();

        let tagId: number;
        if (existingTag) {
          tagId = existingTag.id;
        } else {
          const result = db
            .insert(tags)
            .values({ name: s.displayName, color: tagColor })
            .returning({ insertedId: tags.id })
            .get();
          if (!result) continue;
          tagId = result.insertedId;
        }

        const existing = db
          .select({ id: photoTags.id })
          .from(photoTags)
          .where(
            sql`${photoTags.photoId} = ${photoId} AND ${photoTags.tagId} = ${tagId}`
          )
          .get();
        if (!existing) {
          db.insert(photoTags)
            .values({ photoId, tagId, confidence: s.confidence, isConfirmed })
            .onConflictDoNothing()
            .run();
        }
      } catch { /* skip individual tag failures */ }
    }
    tagged++;
  }

  return { tagged, skipped };
}
