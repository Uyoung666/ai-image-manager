/**
 * Persistent text embedding worker.
 *
 * Keeps tokenizer/model loading and ONNX inference outside Electron's main
 * process so a first-run SigLIP warmup cannot block renderer IPC.
 */

const MODEL_CONFIGS = {
  clip: {
    displayName: "CLIP ViT-B/32",
    modelId: "Xenova/clip-vit-base-patch32",
    outputName: "text_embeds",
    vectorDimensions: 512,
  },
  siglip: {
    displayName: "SigLIP Base Patch16-224",
    modelId: "Xenova/siglip-base-patch16-224",
    outputName: "pooler_output",
    vectorDimensions: 768,
  },
};

let activeModel = MODEL_CONFIGS.siglip;
let textModel = null;
let tokenizer = null;

function disposeOutput(output) {
  for (const value of Object.values(output ?? {})) {
    if (value && typeof value.dispose === "function") {
      value.dispose();
    }
  }
}

async function initialize(message) {
  const modelKind = message.modelKind === "clip" ? "clip" : "siglip";
  activeModel = MODEL_CONFIGS[modelKind];

  const { AutoTokenizer, CLIPTextModelWithProjection, SiglipTextModel, env } =
    await import("@xenova/transformers");

  env.localModelPath = message.modelPath;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useFS = true;
  env.useFSCache = true;

  tokenizer = await AutoTokenizer.from_pretrained(activeModel.modelId);
  const TextModel =
    modelKind === "siglip" ? SiglipTextModel : CLIPTextModelWithProjection;
  textModel = await TextModel.from_pretrained(activeModel.modelId, {
    quantized: true,
  });

  process.send?.({ type: "ready" });
}

async function embed(message) {
  if (!(tokenizer && textModel)) {
    throw new Error("Text embedding model is not initialized");
  }

  const texts = Array.isArray(message.texts) ? message.texts : [];
  if (texts.length === 0) {
    process.send?.({
      type: "result",
      requestId: message.requestId,
      vectors: [],
    });
    return;
  }

  const inputs = await tokenizer(texts, {
    padding: activeModel === MODEL_CONFIGS.siglip ? "max_length" : true,
    truncation: true,
  });
  const output = await textModel(inputs);
  try {
    const embeddings = output[activeModel.outputName];
    if (!embeddings) {
      throw new Error(
        `${activeModel.displayName} output "${activeModel.outputName}" missing`
      );
    }

    const data = Array.from(embeddings.data);
    const vectorSize = data.length / texts.length;
    if (
      !Number.isInteger(vectorSize) ||
      vectorSize !== activeModel.vectorDimensions
    ) {
      throw new Error(
        `${activeModel.displayName} vector size mismatch: expected=${activeModel.vectorDimensions} actual=${vectorSize}`
      );
    }

    const vectors = texts.map((_, index) => {
      const vector = data.slice(index * vectorSize, (index + 1) * vectorSize);
      const norm = Math.sqrt(
        vector.reduce((sum, value) => sum + value * value, 0)
      );
      return vector.map((value) => value / (norm || 1));
    });
    process.send?.({ type: "result", requestId: message.requestId, vectors });
  } finally {
    disposeOutput(output);
  }
}

async function handleMessage(message) {
  try {
    if (message?.type === "init") {
      await initialize(message);
      return;
    }
    if (message?.type === "embed") {
      await embed(message);
      return;
    }
    if (message?.type === "shutdown") {
      process.exit(0);
    }
  } catch (error) {
    process.send?.({
      type: message?.type === "init" ? "init-error" : "error",
      requestId: message?.requestId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

let operationQueue = Promise.resolve();
process.on("message", (message) => {
  if (message?.type === "shutdown") {
    process.exit(0);
  }
  operationQueue = operationQueue.then(() => handleMessage(message));
});
