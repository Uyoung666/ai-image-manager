/**
 * Configurable text embedding worker.
 *
 * The first adapter uses transformers-js. The protocol carries an engine field
 * so an ONNX Runtime text implementation can be added later without changing
 * the client contract.
 */

let activeAdapter = null;
let textModel = null;
let tokenizer = null;
const PATH_SPLIT_RE = /[\\/]/u;
const QUANTIZED_ONNX_RE = /_quantized\.onnx$/iu;
const ONNX_RE = /\.onnx$/iu;

function validateAdapter(adapter) {
  if (!adapter || adapter.protocolVersion !== 1) {
    throw new Error("Unsupported or missing text worker adapter protocol");
  }
  const text = adapter.text;
  if (
    typeof adapter.adapterId !== "string" ||
    typeof adapter.fingerprint !== "string" ||
    typeof adapter.modelRoot !== "string" ||
    typeof adapter.modelId !== "string" ||
    !text ||
    typeof text.modelRelativePath !== "string" ||
    !Number.isInteger(text.dimensions) ||
    text.dimensions <= 0 ||
    typeof text.outputName !== "string" ||
    !Number.isInteger(text.maxLength) ||
    text.maxLength <= 0 ||
    text.padding !== "max_length" ||
    adapter.normalization !== "l2"
  ) {
    throw new Error("Invalid text worker adapter configuration");
  }
  if (text.engine !== "transformers-js") {
    throw new Error(`Text engine is not enabled in phase 1: ${text.engine}`);
  }
  return adapter;
}

function disposeOutput(output) {
  for (const value of Object.values(output ?? {})) {
    value?.dispose?.();
  }
}

async function initialize(message) {
  activeAdapter = validateAdapter(message.adapter);
  const { AutoModel, AutoTokenizer, env } = await import(
    "@xenova/transformers"
  );
  env.localModelPath = activeAdapter.modelRoot;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useFS = true;
  env.useFSCache = true;

  tokenizer = await AutoTokenizer.from_pretrained(activeAdapter.modelId);
  textModel = await AutoModel.from_pretrained(activeAdapter.modelId, {
    model_file_name: activeAdapter.text.modelRelativePath
      .split(PATH_SPLIT_RE)
      .at(-1)
      .replace(QUANTIZED_ONNX_RE, "")
      .replace(ONNX_RE, ""),
    quantized: true,
  });
  process.send?.({
    type: "ready",
    adapterId: activeAdapter.adapterId,
    fingerprint: activeAdapter.fingerprint,
  });
}

function normalizeVector(vector) {
  if (
    vector.length !== activeAdapter.text.dimensions ||
    vector.some((value) => !Number.isFinite(value))
  ) {
    throw new Error(
      `Invalid text vector: expected ${activeAdapter.text.dimensions} finite values`
    );
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  const normalized = vector.map((value) => value / (norm || 1));
  if (normalized.some((value) => !Number.isFinite(value))) {
    throw new Error("Text vector normalization produced non-finite values");
  }
  return normalized;
}

async function embed(message) {
  if (!(tokenizer && textModel && activeAdapter)) {
    throw new Error("Text embedding model is not initialized");
  }
  const texts = Array.isArray(message.texts) ? message.texts : [];
  if (texts.length === 0) {
    process.send?.({
      type: "result",
      requestId: message.requestId,
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      vectors: [],
    });
    return;
  }

  const inputs = await tokenizer(texts, {
    padding: activeAdapter.text.padding,
    truncation: true,
    max_length: activeAdapter.text.maxLength,
  });
  const output = await textModel(inputs);
  try {
    const embeddings = output[activeAdapter.text.outputName];
    if (!embeddings) {
      throw new Error(`Output "${activeAdapter.text.outputName}" missing`);
    }
    const data = Array.from(embeddings.data);
    const vectorSize = data.length / texts.length;
    if (
      !Number.isInteger(vectorSize) ||
      vectorSize !== activeAdapter.text.dimensions
    ) {
      throw new Error(
        `Text vector size mismatch: expected=${activeAdapter.text.dimensions} actual=${vectorSize}`
      );
    }
    const vectors = texts.map((_, index) =>
      normalizeVector(data.slice(index * vectorSize, (index + 1) * vectorSize))
    );
    process.send?.({
      type: "result",
      requestId: message.requestId,
      adapterId: activeAdapter.adapterId,
      fingerprint: activeAdapter.fingerprint,
      vectors,
    });
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
      adapterId: activeAdapter?.adapterId,
      fingerprint: activeAdapter?.fingerprint,
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
