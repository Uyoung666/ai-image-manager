// Compare the removed raw-Chinese SigLIP path with hybrid-zh-v2's translated
// primary prompt on the repository's 21-image quality set.
//
// Usage:
//   node scripts/bench-chinese-semantic-search.mjs [test-data-dir] [model-root]

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import {
  AutoProcessor,
  AutoTokenizer,
  env,
  pipeline,
  RawImage,
  SiglipTextModel,
  SiglipVisionModel,
} from "@xenova/transformers";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testDataDir = path.resolve(
  process.argv[2] || "D:\\8806\\ai-image-manager测试用例"
);
const modelRoot = path.resolve(
  process.argv[3] || path.join(repoRoot, "models")
);
const siglipId = "Xenova/siglip-base-patch16-224";
const translationId = "Xenova/opus-mt-zh-en";
const minimumSimilarity = 0.02;

const CASES = [
  ["050510.jpg", "海上码头的日落"],
  ["20260510_test-image-0474.jpg", "荒凉昏暗的山谷"],
  ["test-image-0011.jpg", "群山之间的湖泊"],
  ["test-image-0030.jpg", "木桌上的咖啡杯"],
  ["test-image-0049.jpg", "白色的海边村庄"],
  ["test-image-0088.jpg", "高速公路上行驶的汽车"],
  ["test-image-0110.jpg", "绿色草地上的日落"],
  ["test-image-0153.jpg", "钢琴键盘的特写"],
  ["test-image-0172.jpg", "雾中的木制码头"],
  ["test-image-0215.jpg", "宽阔的沙滩"],
  ["test-image-0236.jpg", "岩石悬崖下的小教堂"],
  ["test-image-0258.jpg", "天空中飞翔的鸟群"],
  ["test-image-0301.jpg", "小路上的秋天落叶"],
  ["test-image-0322.jpg", "狭窄的鹅卵石街道"],
  ["test-image-0345.jpg", "正在行驶的地铁列车"],
  ["test-image-0366.jpg", "咖啡杯旁边的电脑键盘"],
  ["test-image-0385.jpg", "平静的海洋地平线"],
  ["test-image-0406.jpg", "被云雾覆盖的山峰"],
  ["test-image-0427.jpg", "日落时的棕榈树"],
  ["test-image-0471.jpg", "绿色松树林"],
  ["Unknown10.jpg", "仰望竹林"],
];

for (const [fileName] of CASES) {
  const filePath = path.join(testDataDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing test image: ${filePath}`);
  }
}

const QUERIES = CASES.flatMap(([fileName, visualQuery], imageIndex) => [
  {
    category: "中文",
    expected: fileName,
    imageIndex,
    raw: visualQuery,
    visualQuery,
  },
  {
    category: "口语中文",
    expected: fileName,
    imageIndex,
    raw: `帮我找一下${visualQuery}的照片`,
    visualQuery,
  },
  {
    category: "中英混合",
    expected: fileName,
    imageIndex,
    raw: `${visualQuery} photo`,
    visualQuery: `${visualQuery} photo`,
  },
  {
    category: "时间表达",
    expected: fileName,
    imageIndex,
    raw: `去年夏天拍的${visualQuery}`,
    visualQuery,
  },
  {
    category: "否定条件",
    expected: fileName,
    imageIndex,
    raw: `${visualQuery}，不要人物`,
    visualQuery,
  },
]);

env.localModelPath = modelRoot;
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.backends.onnx.wasm.numThreads = 1;

function normalize(values) {
  const vector = Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / (norm || 1));
}

function cosine(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))];
}

async function embedTexts(texts, tokenizer, textModel) {
  const inputs = await tokenizer(texts, {
    padding: "max_length",
    truncation: true,
  });
  const output = await textModel(inputs);
  const tensor = output.pooler_output ?? output[Object.keys(output)[0]];
  const size = tensor.data.length / texts.length;
  return texts.map((_, index) =>
    normalize(tensor.data.slice(index * size, (index + 1) * size))
  );
}

function evaluate(label, textVectors, imageVectors, latencies = []) {
  let recallAt1 = 0;
  let recallAt3 = 0;
  let recallAt10 = 0;
  let reciprocalRank = 0;
  let ndcgAt10 = 0;
  let zeroResults = 0;
  const categoryMetrics = new Map();
  const misses = [];

  for (let index = 0; index < QUERIES.length; index++) {
    const query = QUERIES[index];
    const ranked = imageVectors
      .map((vector, imageIndex) => ({
        imageIndex,
        score: cosine(textVectors[index], vector),
      }))
      .sort((left, right) => right.score - left.score);
    const rank =
      ranked.findIndex(({ imageIndex }) => imageIndex === query.imageIndex) + 1;
    const metrics = categoryMetrics.get(query.category) ?? {
      count: 0,
      recallAt3: 0,
      reciprocalRank: 0,
    };
    metrics.count++;
    metrics.recallAt3 += Number(rank <= 3);
    metrics.reciprocalRank += 1 / rank;
    categoryMetrics.set(query.category, metrics);

    recallAt1 += Number(rank === 1);
    recallAt3 += Number(rank <= 3);
    recallAt10 += Number(rank <= 10);
    reciprocalRank += 1 / rank;
    ndcgAt10 += rank <= 10 ? 1 / Math.log2(rank + 1) : 0;
    zeroResults += Number((ranked[0]?.score ?? -1) < minimumSimilarity);
    if (rank > 3) {
      misses.push({
        expected: query.expected,
        predicted: CASES[ranked[0].imageIndex][0],
        query: query.raw,
        rank,
      });
    }
  }

  return {
    label,
    queries: QUERIES.length,
    recallAt1: recallAt1 / QUERIES.length,
    recallAt3: recallAt3 / QUERIES.length,
    recallAt10: recallAt10 / QUERIES.length,
    meanReciprocalRank: reciprocalRank / QUERIES.length,
    ndcgAt10: ndcgAt10 / QUERIES.length,
    zeroResultRate: zeroResults / QUERIES.length,
    p50LatencyMs: Math.round(percentile(latencies, 0.5)),
    p95LatencyMs: Math.round(percentile(latencies, 0.95)),
    byCategory: Object.fromEntries(
      [...categoryMetrics].map(([category, metrics]) => [
        category,
        {
          count: metrics.count,
          recallAt3: metrics.recallAt3 / metrics.count,
          meanReciprocalRank: metrics.reciprocalRank / metrics.count,
        },
      ])
    ),
    misses: misses.slice(0, 25),
  };
}

const loadStartedAt = performance.now();
const [tokenizer, processor, textModel, visionModel, translator] =
  await Promise.all([
    AutoTokenizer.from_pretrained(siglipId),
    AutoProcessor.from_pretrained(siglipId),
    SiglipTextModel.from_pretrained(siglipId, { quantized: true }),
    SiglipVisionModel.from_pretrained(siglipId, { quantized: true }),
    pipeline("translation", translationId, { quantized: true }),
  ]);
const coldLoadMs = performance.now() - loadStartedAt;

const imageVectors = [];
for (const [fileName] of CASES) {
  const image = await RawImage.read(path.join(testDataDir, fileName));
  const output = await visionModel(await processor(image));
  const tensor = output.pooler_output ?? output[Object.keys(output)[0]];
  imageVectors.push(normalize(tensor.data));
}

const baselineTexts = QUERIES.map(({ raw }) => `a photo of ${raw}`);
const baselineVectors = await embedTexts(baselineTexts, tokenizer, textModel);

const optimizedTexts = [];
const warmLatencies = [];
const translationCache = new Map();
for (const query of QUERIES) {
  const startedAt = performance.now();
  let translated = translationCache.get(query.visualQuery);
  if (!translated) {
    const output = await translator(query.visualQuery, {
      max_new_tokens: 96,
      num_beams: 1,
    });
    translated = output?.[0]?.translation_text?.trim() ?? "";
    translationCache.set(query.visualQuery, translated);
  }
  const prompt = `a photo of ${translated}`;
  optimizedTexts.push(prompt);
  await embedTexts([prompt], tokenizer, textModel);
  warmLatencies.push(performance.now() - startedAt);
}
const optimizedVectors = await embedTexts(optimizedTexts, tokenizer, textModel);

const baseline = evaluate(
  "legacy-raw-chinese-embedding",
  baselineVectors,
  imageVectors
);
const optimized = evaluate(
  "hybrid-zh-v2-primary-prompt",
  optimizedVectors,
  imageVectors,
  warmLatencies
);

console.log(
  JSON.stringify(
    {
      model: siglipId,
      translationModel: translationId,
      modelRoot,
      images: CASES.length,
      queries: QUERIES.length,
      coldLoadMs: Math.round(coldLoadMs),
      minimumSimilarity,
      baseline,
      optimized,
      relativeImprovement: {
        meanReciprocalRank:
          optimized.meanReciprocalRank / baseline.meanReciprocalRank - 1,
        ndcgAt10: optimized.ndcgAt10 / baseline.ndcgAt10 - 1,
      },
    },
    null,
    2
  )
);
