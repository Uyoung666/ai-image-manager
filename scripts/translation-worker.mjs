/**
 * Persistent local Chinese → English translation worker.
 *
 * The worker is intentionally isolated from Electron's main process because
 * Marian encoder/decoder initialization and generation are CPU/memory heavy.
 */

const MODEL_ID = "Xenova/opus-mt-zh-en";
let translator = null;

async function initialize(message) {
  const { env, pipeline } = await import("@xenova/transformers");
  env.localModelPath = message.modelPath;
  env.allowLocalModels = true;
  env.allowRemoteModels = false;
  env.useFS = true;
  env.useFSCache = true;
  env.backends.onnx.wasm.numThreads = 1;

  translator = await pipeline("translation", MODEL_ID, {
    quantized: true,
  });
  process.send?.({ type: "ready" });
}

async function translate(message) {
  if (!translator) {
    throw new Error("Translation model is not initialized");
  }
  const text = typeof message.text === "string" ? message.text.trim() : "";
  if (!text) {
    throw new Error("Translation input is empty");
  }

  const output = await translator(text, {
    max_new_tokens: 96,
    num_beams: 1,
  });
  const first = Array.isArray(output) ? output[0] : output;
  const translatedText = first?.translation_text?.trim();
  if (!translatedText) {
    throw new Error("Translation model returned empty output");
  }
  process.send?.({
    type: "result",
    requestId: message.requestId,
    text: translatedText,
  });
}

async function shutdown() {
  try {
    await translator?.dispose?.();
  } finally {
    translator = null;
    process.exit(0);
  }
}

let operationQueue = Promise.resolve();
process.on("message", (message) => {
  if (message?.type === "shutdown") {
    operationQueue = operationQueue.then(shutdown);
    return;
  }
  operationQueue = operationQueue.then(async () => {
    try {
      if (message?.type === "init") {
        await initialize(message);
      } else if (message?.type === "translate") {
        await translate(message);
      }
    } catch (error) {
      process.send?.({
        type: message?.type === "init" ? "init-error" : "error",
        requestId: message?.requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
