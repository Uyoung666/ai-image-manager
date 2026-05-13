import { eq, inArray, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photoTags, tags } from "@/db/schema";
import { cosineSimilarity } from "./constants";
import { ensureLocalModel, loadModel } from "./model-loader";
import { embedImageInWorker } from "./search";
import { _localModelPath, embeddingModel, setLocalModelPath } from "./state";
import { getPhotoVectors, initVectorDB } from "./vector-db";

// --- Tag category system ---

export type TagCategory =
  | "scene"
  | "subject"
  | "animal"
  | "object"
  | "activity"
  | "lighting"
  | "style"
  | "color"
  | "weather";

export interface CandidateTag {
  category: TagCategory;
  en: string;
  zh: string;
}

const CATEGORY_THRESHOLD_MULTIPLIERS: Record<TagCategory, number> = {
  scene: 1.4,
  lighting: 1.3,
  color: 1.2,
  weather: 1.2,
  style: 1.0,
  subject: 1.0,
  animal: 1.0,
  object: 1.0,
  activity: 1.0,
};

export const CANDIDATE_TAGS: CandidateTag[] = [
  // === SCENES (25) ===
  { en: "indoor room interior", zh: "室内", category: "scene" },
  { en: "outdoor outside", zh: "户外", category: "scene" },
  { en: "city urban downtown", zh: "城市", category: "scene" },
  { en: "countryside rural village", zh: "乡村", category: "scene" },
  { en: "nature landscape scenery", zh: "自然风景", category: "scene" },
  { en: "beach ocean sea shore", zh: "海滩", category: "scene" },
  { en: "mountain hill peak", zh: "山脉", category: "scene" },
  { en: "forest woods trees dense", zh: "森林", category: "scene" },
  { en: "street road alley urban", zh: "街道", category: "scene" },
  { en: "architecture building facade", zh: "建筑", category: "scene" },
  { en: "garden flowers park", zh: "花园", category: "scene" },
  { en: "field meadow grassland", zh: "田野", category: "scene" },
  { en: "lake pond water calm", zh: "湖泊", category: "scene" },
  { en: "river stream flowing water", zh: "河流", category: "scene" },
  { en: "desert sand dunes arid", zh: "沙漠", category: "scene" },
  { en: "snow winter frozen landscape", zh: "雪景", category: "scene" },
  { en: "sky clouds atmosphere", zh: "天空", category: "scene" },
  { en: "night scene dark city lights", zh: "夜景", category: "scene" },
  { en: "underwater ocean diving marine", zh: "水下", category: "scene" },
  { en: "airport airplane terminal travel", zh: "机场", category: "scene" },
  { en: "train station railway platform", zh: "车站", category: "scene" },
  { en: "market bazaar stall shopping", zh: "市场", category: "scene" },
  { en: "restaurant cafe dining table", zh: "餐厅", category: "scene" },
  { en: "office workspace desk computer", zh: "办公室", category: "scene" },
  { en: "classroom school education", zh: "教室", category: "scene" },
  { en: "flower field garden colorful vast", zh: "花海", category: "scene" },
  // === SUBJECTS — People (15) ===
  { en: "person people human", zh: "人物", category: "subject" },
  { en: "portrait face close-up person", zh: "人像", category: "subject" },
  { en: "group people crowd gathering", zh: "群体", category: "subject" },
  { en: "child kid young boy girl", zh: "儿童", category: "subject" },
  { en: "baby infant newborn", zh: "婴儿", category: "subject" },
  { en: "couple romantic pair love", zh: "情侣", category: "subject" },
  { en: "family parents children together", zh: "家庭", category: "subject" },
  { en: "woman female girl", zh: "女性", category: "subject" },
  { en: "man male boy", zh: "男性", category: "subject" },
  { en: "elderly senior old person", zh: "老人", category: "subject" },
  { en: "selfie self-portrait phone mirror", zh: "自拍", category: "subject" },
  { en: "back silhouette person behind", zh: "背影", category: "subject" },
  { en: "smile happy laughing joyful face", zh: "笑容", category: "subject" },
  { en: "wedding bride groom ceremony", zh: "婚礼", category: "subject" },
  { en: "hands fingers gesture detail", zh: "手部特写", category: "subject" },
  // === ANIMALS (12) ===
  { en: "cat kitten feline", zh: "猫咪", category: "animal" },
  { en: "dog puppy canine", zh: "狗狗", category: "animal" },
  { en: "bird flying feathers", zh: "鸟类", category: "animal" },
  { en: "fish aquarium underwater", zh: "鱼类", category: "animal" },
  { en: "insect butterfly bee macro", zh: "昆虫", category: "animal" },
  { en: "horse riding equestrian", zh: "马", category: "animal" },
  { en: "rabbit bunny pet small", zh: "兔子", category: "animal" },
  { en: "deer wildlife forest antler", zh: "鹿", category: "animal" },
  { en: "panda bear black white", zh: "熊猫", category: "animal" },
  { en: "squirrel small animal tree", zh: "松鼠", category: "animal" },
  { en: "pet animal domestic cute", zh: "宠物", category: "animal" },
  { en: "wildlife wild animal nature", zh: "野生动物", category: "animal" },
  // === OBJECTS (20) ===
  { en: "food meal dish plate", zh: "食物", category: "object" },
  { en: "dessert cake sweet pastry", zh: "甜点", category: "object" },
  { en: "coffee cup drink cafe", zh: "咖啡", category: "object" },
  { en: "flower blossom petal", zh: "花卉", category: "object" },
  { en: "tree plant leaves branch", zh: "树木", category: "object" },
  { en: "car vehicle automobile road", zh: "汽车", category: "object" },
  { en: "bicycle bike cycling", zh: "自行车", category: "object" },
  { en: "boat ship water sailing", zh: "船", category: "object" },
  { en: "airplane aircraft sky flying", zh: "飞机", category: "object" },
  { en: "book reading pages text", zh: "书籍", category: "object" },
  { en: "phone smartphone screen mobile", zh: "手机", category: "object" },
  { en: "computer laptop keyboard screen", zh: "电脑", category: "object" },
  { en: "camera lens photography equipment", zh: "相机", category: "object" },
  { en: "glasses eyewear spectacles", zh: "眼镜", category: "object" },
  { en: "hat cap headwear", zh: "帽子", category: "object" },
  { en: "bag backpack purse handbag", zh: "包", category: "object" },
  { en: "umbrella rain protection", zh: "雨伞", category: "object" },
  { en: "candle flame light warm", zh: "蜡烛", category: "object" },
  { en: "mirror reflection glass", zh: "镜子", category: "object" },
  { en: "clock watch time", zh: "钟表", category: "object" },
  // === ACTIVITIES (15) ===
  { en: "sports exercise athletic game", zh: "运动", category: "activity" },
  { en: "running jogging exercise outdoor", zh: "跑步", category: "activity" },
  { en: "swimming pool water sport", zh: "游泳", category: "activity" },
  { en: "hiking climbing mountain trail", zh: "徒步", category: "activity" },
  { en: "cycling bicycle riding road", zh: "骑行", category: "activity" },
  { en: "dancing performance movement", zh: "舞蹈", category: "activity" },
  { en: "cooking kitchen food preparation", zh: "烹饪", category: "activity" },
  { en: "reading studying book learning", zh: "阅读", category: "activity" },
  {
    en: "music concert performance instrument",
    zh: "音乐",
    category: "activity",
  },
  { en: "painting drawing art creative", zh: "绘画", category: "activity" },
  { en: "travel journey vacation suitcase", zh: "旅行", category: "activity" },
  { en: "camping tent outdoor nature fire", zh: "露营", category: "activity" },
  {
    en: "party celebration gathering festive",
    zh: "聚会",
    category: "activity",
  },
  { en: "shopping bags store mall", zh: "购物", category: "activity" },
  {
    en: "yoga meditation stretching exercise",
    zh: "瑜伽",
    category: "activity",
  },
  // === LIGHTING (10) ===
  { en: "daytime sunny bright clear", zh: "白天", category: "lighting" },
  { en: "night dark nighttime", zh: "夜晚", category: "lighting" },
  { en: "sunset dusk golden hour evening", zh: "日落", category: "lighting" },
  { en: "sunrise dawn morning golden", zh: "日出", category: "lighting" },
  { en: "backlight silhouette rim light", zh: "逆光", category: "lighting" },
  { en: "overcast cloudy diffused light", zh: "阴天", category: "lighting" },
  { en: "fog mist haze atmospheric", zh: "雾气", category: "lighting" },
  {
    en: "neon lights colorful urban night",
    zh: "霓虹灯",
    category: "lighting",
  },
  { en: "candlelight warm dim intimate", zh: "烛光", category: "lighting" },
  { en: "rainbow colorful sky rain sun", zh: "彩虹", category: "lighting" },
  // === STYLE (18) ===
  { en: "black and white monochrome grayscale", zh: "黑白", category: "style" },
  { en: "vivid colorful saturated vibrant", zh: "鲜艳", category: "style" },
  { en: "dark moody low key shadow", zh: "暗调", category: "style" },
  { en: "bright high key light airy", zh: "亮调", category: "style" },
  { en: "macro close-up detail tiny", zh: "微距", category: "style" },
  {
    en: "blurred background bokeh shallow depth",
    zh: "虚化背景",
    category: "style",
  },
  { en: "panorama wide angle landscape view", zh: "全景", category: "style" },
  { en: "aerial drone top-down bird eye", zh: "航拍", category: "style" },
  { en: "long exposure light trails smooth", zh: "长曝光", category: "style" },
  { en: "reflection mirror water symmetry", zh: "倒影", category: "style" },
  { en: "silhouette shadow dark outline", zh: "剪影", category: "style" },
  { en: "vintage retro film grain old", zh: "复古", category: "style" },
  { en: "minimalist simple clean empty space", zh: "极简", category: "style" },
  { en: "symmetry symmetric balanced centered", zh: "对称", category: "style" },
  { en: "abstract pattern texture artistic", zh: "抽象", category: "style" },
  { en: "double exposure overlay creative", zh: "多重曝光", category: "style" },
  { en: "flat lay top view arrangement", zh: "平铺", category: "style" },
  { en: "street photography candid urban life", zh: "街拍", category: "style" },
  // === COLOR (10) ===
  { en: "red color warm", zh: "红色调", category: "color" },
  { en: "blue color cool", zh: "蓝色调", category: "color" },
  { en: "green color nature", zh: "绿色调", category: "color" },
  { en: "yellow color warm bright", zh: "黄色调", category: "color" },
  { en: "white color bright clean", zh: "白色调", category: "color" },
  { en: "black color dark", zh: "黑色调", category: "color" },
  { en: "purple violet color", zh: "紫色调", category: "color" },
  { en: "orange color warm autumn", zh: "橙色调", category: "color" },
  { en: "pink color soft romantic", zh: "粉色调", category: "color" },
  { en: "gold golden color warm shiny", zh: "金色调", category: "color" },
  // === WEATHER (6) ===
  { en: "rain rainy wet weather drops", zh: "雨天", category: "weather" },
  { en: "snow snowy winter cold white", zh: "雪天", category: "weather" },
  { en: "fog mist haze low visibility", zh: "雾天", category: "weather" },
  { en: "windy wind blowing weather", zh: "风天", category: "weather" },
  { en: "sunny clear blue sky bright", zh: "晴朗", category: "weather" },
  { en: "cloudy overcast grey sky", zh: "多云", category: "weather" },
];

// Pre-computed text embeddings for candidate tags (computed once after model load)
let cachedTagEmbeddings: Array<{
  tag: string;
  displayName: string;
  category: TagCategory;
  vector: number[];
}> | null = null;

// In-memory LRU cache for recently queried image vectors
const imageVecCache = new Map<number, number[]>();
const IMAGE_VEC_CACHE_MAX = 100;

const ABSOLUTE_MIN_SIMILARITY = 0.2;

// --- Adaptive tag selection (gap analysis) ---

function selectTagsAdaptive(
  scores: Array<{
    displayName: string;
    similarity: number;
    category: TagCategory;
  }>,
  maxTags: number
): Array<{ tag: string; confidence: number }> {
  if (scores.length === 0) {
    return [];
  }

  const sorted = [...scores].sort((a, b) => b.similarity - a.similarity);
  const candidates = sorted.filter(
    (s) => s.similarity >= ABSOLUTE_MIN_SIMILARITY
  );
  if (candidates.length === 0) {
    return [];
  }

  const selected: typeof candidates = [];

  for (let i = 0; i < Math.min(candidates.length, maxTags * 2); i++) {
    const current = candidates[i];
    const multiplier = CATEGORY_THRESHOLD_MULTIPLIERS[current.category] || 1.0;
    const effectiveMin = ABSOLUTE_MIN_SIMILARITY * multiplier;

    if (current.similarity < effectiveMin) {
      break;
    }

    // Gap check: stop if gap from previous is too large (and we have at least 2)
    if (selected.length > 0) {
      const prevSim = selected[selected.length - 1].similarity;
      const gap = prevSim - current.similarity;
      if (gap > 0.1 && selected.length >= 2) {
        break;
      }
    }

    // Relative threshold: must reach 70% of the top score
    const relativeThreshold = candidates[0].similarity * 0.7;
    if (current.similarity < relativeThreshold) {
      break;
    }

    selected.push(current);
    if (selected.length >= maxTags) {
      break;
    }
  }

  return selected.map((s) => ({
    tag: s.displayName,
    confidence: Math.round(s.similarity * 100) / 100,
  }));
}

export async function suggestTags(
  imagePath: string,
  threshold = 0.25,
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

  // Pre-compute tag text embeddings once
  if (cachedTagEmbeddings === null) {
    const fresh: Array<{
      tag: string;
      displayName: string;
      category: TagCategory;
      vector: number[];
    }> = [];
    for (const { en, zh, category } of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(en);
        fresh.push({ tag: en, displayName: zh, category, vector: textVec });
      } catch (err: any) {
        console.error(`[AI] Tag embedding failed for "${en}":`, err?.message);
      }
    }
    if (fresh.length > 0) {
      cachedTagEmbeddings = fresh;
    }
    console.log(
      `[AI] Pre-computed ${fresh.length}/${CANDIDATE_TAGS.length} tag embeddings`
    );
  }

  // Resolve image vector
  let imageVec: number[] | null = null;

  if (photoId != null) {
    const cached = imageVecCache.get(photoId);
    if (cached) {
      imageVec = cached;
    }
  }

  if (!imageVec && photoId != null) {
    try {
      await initVectorDB();
      const vectors = await getPhotoVectors([photoId]);
      const vec = vectors.get(photoId);
      if (vec) {
        imageVec = vec;
        if (imageVecCache.size >= IMAGE_VEC_CACHE_MAX) {
          const firstKey = imageVecCache.keys().next().value;
          if (firstKey !== undefined) {
            imageVecCache.delete(firstKey);
          }
        }
        imageVecCache.set(photoId, vec);
      }
    } catch {
      /* fall through to worker */
    }
  }

  if (!imageVec) {
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

  if (!cachedTagEmbeddings) {
    return [];
  }

  // Score all tags
  const scores = cachedTagEmbeddings.map(
    ({ displayName, category, vector }) => ({
      displayName,
      category,
      similarity: cosineSimilarity(imageVec!, vector),
    })
  );

  return selectTagsAdaptive(scores, 10);
}

// --- Batch tag suggestion (incremental, post-embedding) ---

const MAX_AUTO_TAGS_PER_PHOTO = 5;

export async function batchSuggestTags(
  photoIds: number[]
): Promise<{ tagged: number; skipped: number }> {
  const db = getDatabase();

  try {
    await loadModel();
  } catch {
    return { tagged: 0, skipped: photoIds.length };
  }

  if (!(embeddingModel && _localModelPath)) {
    return { tagged: 0, skipped: photoIds.length };
  }

  // Skip photos that already have tags (incremental processing)
  const alreadyTagged = db
    .select({ photoId: photoTags.photoId })
    .from(photoTags)
    .where(inArray(photoTags.photoId, photoIds))
    .all();
  const alreadyTaggedSet = new Set(alreadyTagged.map((r) => r.photoId));
  const toProcess = photoIds.filter((id) => !alreadyTaggedSet.has(id));

  if (toProcess.length === 0) {
    return { tagged: 0, skipped: photoIds.length };
  }

  // Pre-compute tag embeddings
  if (cachedTagEmbeddings === null) {
    const fresh: Array<{
      tag: string;
      displayName: string;
      category: TagCategory;
      vector: number[];
    }> = [];
    for (const { en, zh, category } of CANDIDATE_TAGS) {
      try {
        const textVec = await embeddingModel.embedText(en);
        fresh.push({ tag: en, displayName: zh, category, vector: textVec });
      } catch {
        /* skip */
      }
    }
    if (fresh.length > 0) {
      cachedTagEmbeddings = fresh;
    }
  }

  if (!cachedTagEmbeddings) {
    return { tagged: 0, skipped: photoIds.length };
  }

  await initVectorDB();
  const vectors = await getPhotoVectors(toProcess);

  let tagged = 0;
  let skipped = 0;
  const tagColors = [
    "#5e6ad2",
    "#46a758",
    "#ffb224",
    "#e5484d",
    "#7c7fe0",
    "#3b9ec6",
    "#d97a3e",
    "#a855f7",
  ];

  for (const photoId of toProcess) {
    const imageVec = vectors.get(photoId);
    if (!imageVec) {
      skipped++;
      continue;
    }

    const scores = cachedTagEmbeddings.map(
      ({ displayName, category, vector }) => ({
        displayName,
        category,
        similarity: cosineSimilarity(imageVec, vector),
      })
    );

    const topTags = selectTagsAdaptive(scores, MAX_AUTO_TAGS_PER_PHOTO);

    for (const s of topTags) {
      // Relative confirmation: top score's 85% or fallback 0.38
      const confirmThreshold = topTags[0] ? topTags[0].confidence * 0.85 : 0.38;
      const isConfirmed = s.confidence >= confirmThreshold;

      try {
        let hash = 0;
        for (let i = 0; i < s.tag.length; i++) {
          hash = s.tag.charCodeAt(i) + ((hash << 5) - hash);
        }
        const tagColor = tagColors[Math.abs(hash) % tagColors.length];

        const existingTag = db
          .select({ id: tags.id })
          .from(tags)
          .where(eq(tags.name, s.tag))
          .get();

        let tagId: number;
        if (existingTag) {
          tagId = existingTag.id;
        } else {
          const result = db
            .insert(tags)
            .values({ name: s.tag, color: tagColor })
            .returning({ insertedId: tags.id })
            .get();
          if (!result) {
            continue;
          }
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
      } catch {
        /* skip individual tag failures */
      }
    }
    if (topTags.length > 0) {
      tagged++;
    } else {
      skipped++;
    }
  }

  return { tagged, skipped };
}
