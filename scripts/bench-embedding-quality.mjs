// Compare image/text retrieval quality on the repository's test image set.
//
// Usage:
//   node scripts/bench-embedding-quality.mjs [test-data-dir] [model-root]

import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

const repoRoot = path.resolve(import.meta.dirname, "..");
const testDataDir = path.resolve(process.argv[3] || "test-fixtures/photos");
const modelRoot = path.resolve(
  process.argv[3] || path.join(repoRoot, "models-lab")
);

const CASES = [
  ["050510.jpg", "a sunset over the ocean with a pier"],
  ["20260510_test-image-0474.jpg", "a barren dark mountain valley"],
  ["test-image-0011.jpg", "a lake in a mountain valley"],
  ["test-image-0030.jpg", "a coffee mug on a wooden table"],
  ["test-image-0049.jpg", "a white coastal village"],
  ["test-image-0088.jpg", "cars driving on a highway"],
  ["test-image-0110.jpg", "a sunset over a green meadow"],
  ["test-image-0153.jpg", "close-up of piano keys"],
  ["test-image-0172.jpg", "a wooden pier in fog"],
  ["test-image-0215.jpg", "a wide sandy beach"],
  ["test-image-0236.jpg", "a small church below a rocky cliff"],
  ["test-image-0258.jpg", "a flock of birds flying in the sky"],
  ["test-image-0301.jpg", "fallen autumn leaves on a path"],
  ["test-image-0322.jpg", "a narrow cobblestone street"],
  ["test-image-0345.jpg", "a moving subway train"],
  ["test-image-0366.jpg", "a computer keyboard beside a mug"],
  ["test-image-0385.jpg", "a calm ocean horizon"],
  ["test-image-0406.jpg", "a mountain covered in clouds"],
  ["test-image-0427.jpg", "palm trees at sunset"],
  ["test-image-0471.jpg", "a green pine forest"],
  ["Unknown10.jpg", "looking up through a bamboo forest"],
];

for (const [fileName] of CASES) {
  const filePath = path.join(testDataDir, fileName);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing test image: ${filePath}`);
  }
}

const transformers = await import("@xenova/transformers");
const {
  AutoProcessor,
  AutoTokenizer,
  RawImage,
  SiglipTextModel,
  SiglipVisionModel,
  env,
} = transformers;

env.localModelPath = modelRoot;
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.backends.onnx.wasm.numThreads = 1;

const config = {
  id: "Xenova/siglip-base-patch16-224",
  TextModel: SiglipTextModel,
  VisionModel: SiglipVisionModel,
  outputName: "pooler_output",
};

function normalize(values) {
  const vector = Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / (norm || 1));
}

function cosine(left, right) {
  return left.reduce((sum, value, index) => sum + value * right[index], 0);
}

const loadStartedAt = performance.now();
const [tokenizer, processor, textModel, visionModel] = await Promise.all([
  AutoTokenizer.from_pretrained(config.id),
  AutoProcessor.from_pretrained(config.id),
  config.TextModel.from_pretrained(config.id, { quantized: true }),
  config.VisionModel.from_pretrained(config.id, { quantized: true }),
]);
const loadMs = performance.now() - loadStartedAt;

const texts = CASES.map(([, caption]) => caption);
const textInputs = await tokenizer(texts, {
  padding: "max_length",
  truncation: true,
});
const textOutput = await textModel(textInputs);
const textTensor =
  textOutput[config.outputName || "text_embeds"] ??
  textOutput[Object.keys(textOutput)[0]];
const vectorSize = textTensor.data.length / texts.length;
const textVectors = texts.map((_, index) =>
  normalize(textTensor.data.slice(index * vectorSize, (index + 1) * vectorSize))
);

const imageStartedAt = performance.now();
const imageVectors = [];
for (const [fileName] of CASES) {
  const image = await RawImage.read(path.join(testDataDir, fileName));
  const inputs = await processor(image);
  const output = await visionModel(inputs);
  const tensor =
    output[config.outputName || "image_embeds"] ??
    output[Object.keys(output)[0]];
  imageVectors.push(normalize(tensor.data));
}
const imageMs = performance.now() - imageStartedAt;

let reciprocalRankSum = 0;
let recallAt1 = 0;
let recallAt3 = 0;
let nonEmptyQueries = 0;
const misses = [];
const minimumSimilarity = 0.02;

for (let queryIndex = 0; queryIndex < textVectors.length; queryIndex++) {
  const ranked = imageVectors
    .map((vector, imageIndex) => ({
      imageIndex,
      score: cosine(textVectors[queryIndex], vector),
    }))
    .sort((left, right) => right.score - left.score);
  const rank =
    ranked.findIndex(({ imageIndex }) => imageIndex === queryIndex) + 1;
  reciprocalRankSum += 1 / rank;
  recallAt1 += Number(rank === 1);
  recallAt3 += Number(rank <= 3);
  nonEmptyQueries += Number(ranked[0]?.score >= minimumSimilarity);
  if (rank !== 1) {
    misses.push({
      expected: CASES[queryIndex][0],
      predicted: CASES[ranked[0].imageIndex][0],
      query: CASES[queryIndex][1],
      rank,
    });
  }
}

console.log(
  JSON.stringify(
    {
      model: config.id,
      modelRoot,
      cases: CASES.length,
      dimensions: vectorSize,
      loadMs: Math.round(loadMs),
      imageMs: Math.round(imageMs),
      millisecondsPerImage: Math.round(imageMs / CASES.length),
      recallAt1: recallAt1 / CASES.length,
      recallAt3: recallAt3 / CASES.length,
      nonEmptyQueries,
      nonEmptyCoverage: nonEmptyQueries / CASES.length,
      minimumSimilarity,
      meanReciprocalRank: reciprocalRankSum / CASES.length,
      misses,
    },
    null,
    2
  )
);
