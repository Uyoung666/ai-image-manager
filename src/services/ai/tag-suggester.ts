import { eq, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photoTags, tags } from "@/db/schema";
import { cosineSimilarity } from "./constants";
import { getActiveEmbeddingModel } from "./model-config";
import { ensureLocalModel, loadModel } from "./model-loader";
import { getTagEmbeddingCacheKey, selectTagScores } from "./scoring";
import { embedImageInWorker } from "./search";
import {
  _localModelPath,
  beginAutoTagging,
  embeddingModel,
  finishAutoTagging,
  finishAutoTaggingPhoto,
  setLocalModelPath,
} from "./state";
import { getPhotoVectors, initVectorDB } from "./vector-db";

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
  siglipLabel: string;
  zh: string;
}

const CATEGORY_PARENTS: Record<TagCategory, string> = {
  scene: "场景",
  subject: "人物",
  animal: "动物",
  object: "物体",
  activity: "活动",
  lighting: "光影",
  style: "风格",
  color: "色彩",
  weather: "天气",
};

const CANDIDATE_TAG_DEFINITIONS: Omit<CandidateTag, "siglipLabel">[] = [
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

const SIGLIP_LABELS_BY_CATEGORY: Record<TagCategory, string[]> = {
  scene: [
    "an indoor room",
    "an outdoor scene",
    "a city",
    "a countryside village",
    "a natural landscape",
    "a beach by the ocean",
    "a mountain",
    "a forest",
    "a street",
    "a building",
    "a flower garden",
    "a grassy field",
    "a lake",
    "a river",
    "a desert",
    "a snowy winter landscape",
    "the sky and clouds",
    "a city at night",
    "an underwater scene",
    "an airport",
    "a train station",
    "a market",
    "a restaurant or cafe",
    "an office workspace",
    "a classroom",
    "a field of flowers",
  ],
  subject: [
    "a person",
    "a close-up portrait",
    "a group of people",
    "a child",
    "a baby",
    "a couple",
    "a family",
    "a woman",
    "a man",
    "an elderly person",
    "a selfie",
    "a person seen from behind",
    "a smiling person",
    "a wedding",
    "a close-up of hands",
  ],
  animal: [
    "a cat",
    "a dog",
    "a bird",
    "a fish",
    "an insect",
    "a horse",
    "a rabbit",
    "a deer",
    "a panda",
    "a squirrel",
    "a pet",
    "a wild animal",
  ],
  object: [
    "a plate of food",
    "a dessert or cake",
    "a cup of coffee",
    "a flower",
    "a tree or plant",
    "a car",
    "a bicycle",
    "a boat",
    "an airplane",
    "a book",
    "a smartphone",
    "a computer",
    "a camera",
    "a pair of glasses",
    "a hat",
    "a bag",
    "an umbrella",
    "a candle",
    "a mirror",
    "a clock or watch",
  ],
  activity: [
    "a person exercising",
    "a person running",
    "a person swimming",
    "a person hiking",
    "a person riding a bicycle",
    "a person dancing",
    "a person cooking",
    "a person reading a book",
    "a music performance",
    "a person painting",
    "a travel scene",
    "a camping scene",
    "a party",
    "a person shopping",
    "a person doing yoga",
  ],
  lighting: [
    "a bright daytime scene",
    "a dark nighttime scene",
    "a sunset",
    "a sunrise",
    "a backlit silhouette",
    "an overcast scene",
    "a misty scene",
    "neon lights at night",
    "a candlelit scene",
    "a rainbow",
  ],
  style: [
    "a black and white image",
    "a vivid colorful image",
    "a dark moody image",
    "a bright airy image",
    "a macro close-up",
    "a shallow depth of field with bokeh",
    "a panoramic wide-angle view",
    "an aerial view",
    "a long-exposure photograph",
    "a reflection",
    "a silhouette",
    "a vintage photograph",
    "a minimalist image",
    "a symmetrical composition",
    "an abstract pattern",
    "a double-exposure image",
    "a flat-lay arrangement",
    "a candid street photograph",
  ],
  color: [
    "a predominantly red image",
    "a predominantly blue image",
    "a predominantly green image",
    "a predominantly yellow image",
    "a predominantly white image",
    "a predominantly black image",
    "a predominantly purple image",
    "a predominantly orange image",
    "a predominantly pink image",
    "a predominantly golden image",
  ],
  weather: [
    "rainy weather",
    "snowy weather",
    "foggy weather",
    "windy weather",
    "sunny weather",
    "cloudy weather",
  ],
};

const siglipLabelOffsets: Record<TagCategory, number> = {
  scene: 0,
  subject: 0,
  animal: 0,
  object: 0,
  activity: 0,
  lighting: 0,
  style: 0,
  color: 0,
  weather: 0,
};

export const CANDIDATE_TAGS: CandidateTag[] = CANDIDATE_TAG_DEFINITIONS.map(
  (tag) => {
    const index = siglipLabelOffsets[tag.category]++;
    const siglipLabel = SIGLIP_LABELS_BY_CATEGORY[tag.category][index];
    if (!siglipLabel) {
      throw new Error(`Missing SigLIP label for ${tag.category}:${tag.en}`);
    }
    return { ...tag, siglipLabel };
  }
);

for (const category of Object.keys(
  SIGLIP_LABELS_BY_CATEGORY
) as TagCategory[]) {
  if (
    siglipLabelOffsets[category] !== SIGLIP_LABELS_BY_CATEGORY[category].length
  ) {
    throw new Error(
      `Unexpected SigLIP label count for ${category}: expected ${siglipLabelOffsets[category]}, received ${SIGLIP_LABELS_BY_CATEGORY[category].length}`
    );
  }
}

// Pre-computed text embeddings for candidate tags (computed once after model load)
let cachedTagEmbeddings: Array<{
  tag: string;
  displayName: string;
  category: TagCategory;
  vector: number[];
}> | null = null;
let cachedTagEmbeddingKey: string | null = null;
let tagEmbeddingPromise: Promise<void> | null = null;
let tagEmbeddingPromiseKey: string | null = null;
const TAG_PROMPT_VERSION = 2;
const TAG_EMBEDDING_BATCH_SIZE = 16;

// In-memory LRU cache for recently queried image vectors
const imageVecCache = new Map<number, number[]>();
const IMAGE_VEC_CACHE_MAX = 100;

function getTagPrompt(tag: CandidateTag): string {
  return getActiveEmbeddingModel().kind === "siglip"
    ? `This is a photo of ${tag.siglipLabel}.`
    : tag.en;
}

export function _ensureTagEmbeddingsForTest(): Promise<void> {
  if (!embeddingModel) {
    return Promise.resolve();
  }
  const model = getActiveEmbeddingModel();
  const cacheKey = getTagEmbeddingCacheKey(model.kind, TAG_PROMPT_VERSION);
  if (cachedTagEmbeddings && cachedTagEmbeddingKey === cacheKey) {
    return Promise.resolve();
  }
  if (tagEmbeddingPromise && tagEmbeddingPromiseKey === cacheKey) {
    return tagEmbeddingPromise;
  }

  const activeEmbeddingModel = embeddingModel;
  tagEmbeddingPromiseKey = cacheKey;
  const pending = (async () => {
    const fresh: Array<{
      tag: string;
      displayName: string;
      category: TagCategory;
      vector: number[];
    }> = [];

    for (
      let offset = 0;
      offset < CANDIDATE_TAGS.length;
      offset += TAG_EMBEDDING_BATCH_SIZE
    ) {
      const batch = CANDIDATE_TAGS.slice(
        offset,
        offset + TAG_EMBEDDING_BATCH_SIZE
      );
      const prompts = batch.map(getTagPrompt);
      const vectors = activeEmbeddingModel.embedTexts
        ? await activeEmbeddingModel.embedTexts(prompts)
        : await Promise.all(
            prompts.map((prompt) => activeEmbeddingModel.embedText(prompt))
          );
      if (vectors.length !== batch.length) {
        throw new Error(
          `Tag embedding batch mismatch: expected=${batch.length} actual=${vectors.length}`
        );
      }
      for (let index = 0; index < batch.length; index++) {
        const tag = batch[index];
        const vector = vectors[index];
        if (
          vector.length !== model.vectorDimensions ||
          vector.some((value) => !Number.isFinite(value))
        ) {
          throw new Error(
            `Invalid ${model.displayName} tag vector for "${prompts[index]}"`
          );
        }
        fresh.push({
          tag: tag.en,
          displayName: tag.zh,
          category: tag.category,
          vector,
        });
      }
    }

    cachedTagEmbeddings = fresh;
    cachedTagEmbeddingKey = cacheKey;
    console.log(
      `[AI] Pre-computed ${fresh.length}/${CANDIDATE_TAGS.length} tag embeddings (${cacheKey})`
    );
  })().finally(() => {
    if (tagEmbeddingPromise === pending) {
      tagEmbeddingPromise = null;
      tagEmbeddingPromiseKey = null;
    }
  });
  tagEmbeddingPromise = pending;
  return pending;
}

export function _resetTagEmbeddingCacheForTest(): void {
  cachedTagEmbeddings = null;
  cachedTagEmbeddingKey = null;
  tagEmbeddingPromise = null;
  tagEmbeddingPromiseKey = null;
}

export async function suggestTags(
  imagePath: string,
  _threshold = 0.25,
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

  if (cachedTagEmbeddings === null) {
    console.log("[AI] suggestTags: computing tag text embeddings...");
  }
  await _ensureTagEmbeddingsForTest();

  // Resolve image vector
  let imageVec: number[] | null = null;

  if (photoId != null) {
    const cached = imageVecCache.get(photoId);
    if (cached) {
      imageVec = cached;
      console.log(
        `[AI] suggestTags: using cached image vector for photo ${photoId}`
      );
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
      } else {
        console.log(
          `[AI] suggestTags: no vector in LanceDB for photo ${photoId}`
        );
      }
    } catch (err: any) {
      console.warn("[AI] suggestTags: LanceDB lookup failed:", err?.message);
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

  if (!imageVec) {
    console.error("[AI] suggestTags: could not obtain image vector");
    return [];
  }

  if (!cachedTagEmbeddings) {
    return [];
  }

  // Score all tags
  const resolvedImageVec = imageVec;
  const scores = cachedTagEmbeddings.map(
    ({ displayName, category, vector }) => ({
      displayName,
      category,
      similarity: cosineSimilarity(resolvedImageVec, vector),
    })
  );

  const selected = selectTagScores(
    scores,
    MAX_AUTO_TAGS_PER_PHOTO,
    getActiveEmbeddingModel()
  );
  const sortedScores = [...scores].sort(
    (left, right) => right.similarity - left.similarity
  );
  console.log(
    `[AI] suggestTags: model=${getActiveEmbeddingModel().kind} top=${sortedScores[0]?.similarity.toFixed(4) ?? "n/a"} selected=${selected.length}`
  );
  return selected;
}

const MAX_AUTO_TAGS_PER_PHOTO = 5;
let activeBatchTaggingPromise: Promise<{
  tagged: number;
  skipped: number;
}> | null = null;

export function batchSuggestTags(
  photoIds: number[],
  onProgress?: (processed: number, total: number, photoId: number) => void
): Promise<{ tagged: number; skipped: number }> {
  if (activeBatchTaggingPromise) {
    return activeBatchTaggingPromise;
  }

  const uniquePhotoIds = [...new Set(photoIds)];
  beginAutoTagging(uniquePhotoIds);
  activeBatchTaggingPromise = runBatchSuggestTags(
    uniquePhotoIds,
    onProgress
  ).finally(() => {
    finishAutoTagging(uniquePhotoIds);
    activeBatchTaggingPromise = null;
  });
  return activeBatchTaggingPromise;
}

async function runBatchSuggestTags(
  photoIds: number[],
  onProgress?: (processed: number, total: number, photoId: number) => void
): Promise<{ tagged: number; skipped: number }> {
  const db = getDatabase();

  try {
    await loadModel();
  } catch (err: any) {
    console.error("[AI] batchSuggestTags: model load failed:", err?.message);
    throw err;
  }

  if (!(embeddingModel && _localModelPath)) {
    throw new Error("AI model is not ready for tag generation");
  }

  const toProcess = [...new Set(photoIds)];

  if (toProcess.length === 0) {
    return { tagged: 0, skipped: photoIds.length };
  }

  await _ensureTagEmbeddingsForTest();

  if (!cachedTagEmbeddings) {
    throw new Error("Could not generate candidate tag embeddings");
  }

  const categoryParentIds: Record<string, number> = {};
  const parentColor = "#7c7fe0";
  for (const [cat, zhName] of Object.entries(CATEGORY_PARENTS)) {
    let parent = db
      .select({ id: tags.id })
      .from(tags)
      .where(eq(tags.name, zhName))
      .get();
    if (!parent) {
      const result = db
        .insert(tags)
        .values({ name: zhName, color: parentColor })
        .returning({ insertedId: tags.id })
        .get();
      if (result) {
        parent = { id: result.insertedId };
      }
    }
    if (parent) {
      categoryParentIds[cat] = parent.id;
    }
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

  try {
    for (const [index, photoId] of toProcess.entries()) {
      try {
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

        const topTags = selectTagScores(
          scores,
          MAX_AUTO_TAGS_PER_PHOTO,
          getActiveEmbeddingModel()
        );

        for (const s of topTags) {
          // Relative confirmation: top score's 85% or fallback 0.38
          const confirmThreshold = topTags[0]
            ? topTags[0].confidence * 0.85
            : 0.38;
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
            const parentId = categoryParentIds[s.category] || null;
            if (existingTag) {
              tagId = existingTag.id;
              // Backfill parentId for existing tags that lack one (never self-reference)
              if (parentId && tagId !== parentId) {
                db.update(tags)
                  .set({ parentId })
                  .where(
                    sql`${tags.id} = ${tagId} AND ${tags.parentId} IS NULL`
                  )
                  .run();
              }
            } else {
              const result = db
                .insert(tags)
                .values({ name: s.tag, color: tagColor, parentId })
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
                .values({
                  photoId,
                  tagId,
                  confidence: s.confidence,
                  isConfirmed,
                })
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
      } finally {
        finishAutoTaggingPhoto(photoId);
        onProgress?.(index + 1, toProcess.length, photoId);
      }
    }
  } finally {
    finishAutoTagging(toProcess);
  }

  return { tagged, skipped };
}
