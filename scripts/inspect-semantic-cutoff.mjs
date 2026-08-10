/**
 * Read-only inspection of a text prompt against an existing SigLIP index.
 *
 * Usage (Electron's Node runtime is required for native dependencies):
 *   electron scripts/inspect-semantic-cutoff.mjs <data-root> <english-query> [intent]
 */
import path from "node:path";
import { performance } from "node:perf_hooks";
import lancedb from "@lancedb/lancedb";
import { AutoTokenizer, env, SiglipTextModel } from "@xenova/transformers";
import Database from "better-sqlite3";

const dataRoot = path.resolve(process.argv[2] || "data");
const query = process.argv[3] || "bicycle";
const intent = process.argv[4] || "object";
const modelId = "Xenova/siglip-base-patch16-224";
const prompt = `This is a photo of ${query}.`;

const policies = {
  object: { base: 0.055, ratio: 0.6 },
  composed: { base: 0.045, ratio: 0.5 },
  scene: { base: 0.035, ratio: 0.4 },
  unknown: { base: 0.05, ratio: 0.55 },
};

function normalize(values) {
  const vector = Array.from(values);
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  return vector.map((value) => value / (norm || 1));
}

function scoreGapCutoff(scores) {
  const top = scores.slice(0, 100).sort((left, right) => right - left);
  if (top.length < 6) {
    return null;
  }
  const span = top[0] - top.at(-1);
  let largestGap = 0;
  let cutoff = null;
  for (let index = 4; index < top.length - 1; index += 1) {
    const gap = top[index] - top[index + 1];
    if (gap > largestGap) {
      largestGap = gap;
      cutoff = (top[index] + top[index + 1]) / 2;
    }
  }
  return largestGap >= 0.006 && largestGap >= span * 0.12 ? cutoff : null;
}

env.localModelPath = path.join(dataRoot, "models");
env.allowLocalModels = true;
env.allowRemoteModels = false;
env.backends.onnx.wasm.numThreads = 1;

const startedAt = performance.now();
const [tokenizer, textModel, vectorDb] = await Promise.all([
  AutoTokenizer.from_pretrained(modelId),
  SiglipTextModel.from_pretrained(modelId, { quantized: true }),
  lancedb.connect(path.join(dataRoot, "vectors")),
]);
const inputs = await tokenizer([prompt], {
  padding: "max_length",
  truncation: true,
});
const output = await textModel(inputs);
const tensor = output.pooler_output ?? output[Object.keys(output)[0]];
const vector = normalize(tensor.data);
const table = await vectorDb.openTable("photo_embeddings");
const rows = await table
  .vectorSearch(vector)
  .distanceType("cosine")
  .refineFactor(10)
  .limit(200)
  .toArray();
const candidates = rows
  .map((row) => ({
    photoId: row.photo_id,
    similarity: 1 - row._distance,
  }))
  .filter(({ similarity }) => similarity >= 0.02);
const policy = policies[intent] ?? policies.unknown;
const topSimilarity = candidates[0]?.similarity ?? 0;
const gap =
  intent === "object" || intent === "unknown"
    ? scoreGapCutoff(candidates.map(({ similarity }) => similarity))
    : null;
const finalCutoff = Math.max(
  policy.base,
  topSimilarity * policy.ratio,
  gap ?? 0
);
const accepted = candidates.filter(
  ({ similarity }) => similarity >= finalCutoff
);

const sqlite = new Database(
  path.join(dataRoot, "data", "ai-image-manager.db"),
  { readonly: true, fileMustExist: true }
);
const byId = new Map(
  sqlite
    .prepare("SELECT id, filename, content_hash FROM photos")
    .all()
    .map((photo) => [photo.id, photo])
);
const tagsById = new Map(
  sqlite
    .prepare(
      `SELECT photo_tags.photo_id AS photo_id, group_concat(tags.name, ', ') AS tags
       FROM photo_tags
       INNER JOIN tags ON tags.id = photo_tags.tag_id
       GROUP BY photo_tags.photo_id`
    )
    .all()
    .map((row) => [row.photo_id, row.tags])
);
sqlite.close();

console.log(
  JSON.stringify(
    {
      query,
      prompt,
      intent,
      topSimilarity,
      gapCutoff: gap,
      finalCutoff,
      candidates: candidates.length,
      accepted: accepted.length,
      latencyMs: Math.round(performance.now() - startedAt),
      results: accepted.slice(0, 50).map((result) => ({
        ...result,
        ...byId.get(result.photoId),
        tags: tagsById.get(result.photoId) ?? null,
      })),
      firstRejected: candidates
        .filter(({ similarity }) => similarity < finalCutoff)
        .slice(0, 10)
        .map((result) => ({
          ...result,
          ...byId.get(result.photoId),
          tags: tagsById.get(result.photoId) ?? null,
        })),
    },
    null,
    2
  )
);
