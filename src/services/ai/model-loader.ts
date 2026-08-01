import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { abortAllWorkers } from "@/services/embed-worker-pool";
import { getDataPath } from "@/utils/data-path";
import { isSafePath } from "@/utils/path-security";
import {
  getActiveEmbeddingModel,
  getEmbeddingModelFile,
  getTranslationModelFile,
} from "./model-config";
import type { EmbedProgress } from "./state";
import {
  _localModelPath,
  activeEmbeddingRunId,
  aiControlState,
  currentProgress,
  embeddingModel,
  isEmbedding,
  isModelLoaded,
  isPaused,
  setAiControlState,
  setCurrentProgress,
  setEmbeddingModel,
  setIsEmbedding,
  setIsModelLoaded,
  setIsPaused,
  setLocalModelPath,
  setPoolCancelled,
} from "./state";
import { embedTextsInWorker, initTextWorker } from "./text-worker-client";

async function copyDir(src: string, dest: string): Promise<void> {
  // 验证源路径和目标路径的安全性
  const allowedSources = [
    process.resourcesPath,
    app.getAppPath(),
    process.cwd(),
  ];
  const allowedDestinations = [getDataPath()];

  if (!isSafePath(src, allowedSources)) {
    throw new Error(`[Security] 不安全的源路径: ${src}`);
  }

  if (!isSafePath(dest, allowedDestinations)) {
    throw new Error(`[Security] 不安全的目标路径: ${dest}`);
  }

  // Log source contents before copy
  try {
    const srcExists = fs.existsSync(src);
    const srcEntries = srcExists
      ? fs.readdirSync(src, { recursive: true }).length
      : 0;
    console.error(
      `[copyDir] src=${src} exists=${srcExists} entries=${srcEntries}`
    );
    console.error(`[copyDir] dest=${dest}`);
  } catch {
    /* best-effort logging */
  }

  try {
    await fs.promises.cp(src, dest, { recursive: true });
    const destEntries = fs.readdirSync(dest, { recursive: true }).length;
    console.error(`[copyDir] done — dest entries=${destEntries}`);
  } catch (err: any) {
    console.error(`[copyDir] failed: ${err.message}`);
    throw err;
  }
}

// ── Shared single-flight model copy (fixes Issue #25 race condition) ──
let _modelCopyPromise: Promise<void> | null = null;

/**
 * Copy bundled AI models to dataPath exactly once, regardless of how many
 * callers invoke it concurrently. Callers that arrive while a copy is already
 * in-flight will wait for (and reuse) that existing copy.
 */
export async function copyModelsOnce(): Promise<void> {
  const dataPath = getDataPath();
  const modelsDir = path.join(dataPath, "models");
  const visionMarker = getEmbeddingModelFile(
    modelsDir,
    "vision_model_quantized.onnx"
  );
  const textMarker = getEmbeddingModelFile(
    modelsDir,
    "text_model_quantized.onnx"
  );
  const translationEncoder = getTranslationModelFile(
    modelsDir,
    "encoder_model_quantized.onnx"
  );
  const translationDecoder = getTranslationModelFile(
    modelsDir,
    "decoder_model_merged_quantized.onnx"
  );

  // Already cached from a previous run — no work needed.
  if (
    fs.existsSync(visionMarker) &&
    fs.existsSync(textMarker) &&
    fs.existsSync(translationEncoder) &&
    fs.existsSync(translationDecoder)
  ) {
    return;
  }

  // Copy already in progress — wait for it.
  if (_modelCopyPromise) {
    return _modelCopyPromise;
  }

  _modelCopyPromise = (async () => {
    try {
      if (app.isPackaged) {
        const bundledModels = path.join(
          process.resourcesPath,
          "models-release"
        );
        const bundledMarker = getEmbeddingModelFile(
          bundledModels,
          "vision_model_quantized.onnx"
        );
        if (!fs.existsSync(bundledMarker)) {
          throw new Error("Bundled models not found in installation package");
        }
        await copyDir(bundledModels, modelsDir);
        console.log(
          "[AI] copyModelsOnce: models copied from bundled resources"
        );
      }
      // Dev mode: ensureModelAvailable() in main.ts handles copying from project
      // dirs to dataPath; ensureLocalModel() returns source path directly — no
      // copy needed here.
    } finally {
      _modelCopyPromise = null; // clear on failure to allow retry
    }
  })();

  return _modelCopyPromise;
}

export async function ensureLocalModel(): Promise<string> {
  const localModelPath = path.join(getDataPath(), "models");

  const visionMarker = getEmbeddingModelFile(
    localModelPath,
    "vision_model_quantized.onnx"
  );
  const textMarker = getEmbeddingModelFile(
    localModelPath,
    "text_model_quantized.onnx"
  );
  if (fs.existsSync(visionMarker) && fs.existsSync(textMarker)) {
    return localModelPath;
  }

  // ── Production: use shared single-flight copy (fixes Issue #25 race) ──
  if (app.isPackaged) {
    await copyModelsOnce();

    // Re-check after the shared copy completes.
    if (fs.existsSync(visionMarker) && fs.existsSync(textMarker)) {
      return localModelPath;
    }

    const error = "安装包未包含模型文件，请重新打包";
    setCurrentProgress({
      ...currentProgress,
      phase: "error",
      currentFile: "",
      downloadPercent: undefined,
      error,
    });
    throw new Error(error);
  }

  // ── Dev mode: search project directories ──────────────────
  const devCandidates = [
    path.join(process.cwd(), "models"),
    path.join(app.getAppPath(), "models"),
    path.join(app.getAppPath(), "..", "models"),
    path.join(app.getAppPath(), "..", "..", "models"),
  ];

  for (const candidate of devCandidates) {
    const visionCandidate = getEmbeddingModelFile(
      candidate,
      "vision_model_quantized.onnx"
    );
    const textCandidate = getEmbeddingModelFile(
      candidate,
      "text_model_quantized.onnx"
    );
    if (fs.existsSync(visionCandidate) && fs.existsSync(textCandidate)) {
      console.log(`[AI] Found model at: ${candidate}`);
      return candidate;
    }
  }

  throw new Error("Model not found in dev paths");
}

let modelLoadPromise: Promise<void> | null = null;

export function loadModel(): Promise<void> {
  if (isModelLoaded && embeddingModel) {
    return Promise.resolve();
  }

  if (!modelLoadPromise) {
    modelLoadPromise = initializeModel().finally(() => {
      modelLoadPromise = null;
    });
  }

  return modelLoadPromise;
}

async function initializeModel(): Promise<void> {
  if (!_localModelPath) {
    setLocalModelPath(await ensureLocalModel());
  }
  const localModelPath = _localModelPath;
  if (!localModelPath) {
    throw new Error("AI embedding 本地模型路径解析失败");
  }

  const model = getActiveEmbeddingModel();
  await initTextWorker(localModelPath, model.kind);

  const embedTexts = (texts: string[]): Promise<number[][]> =>
    embedTextsInWorker(texts, localModelPath);

  setEmbeddingModel({
    // embedImage is intentionally NOT provided here — image embedding goes
    // through embedImageInWorker() to keep the WASM heap within limits.
    embedImage: async (_imagePath: string) => {
      throw new Error(
        "embedImage not available in main process — use embedImageInWorker()"
      );
    },
    embedText: async (text: string) => {
      const [vector] = await embedTexts([text]);
      return vector;
    },
    embedTexts,
  });

  setIsModelLoaded(true);
  console.log(
    `[AI] ${model.displayName} text model loaded in isolated worker process`
  );
}

export function isAiModelLoaded(): boolean {
  return isModelLoaded;
}

export function stopEmbedding(): void {
  if (aiControlState === "idle") {
    return;
  }
  setAiControlState("cancelling");
  setPoolCancelled(true);
}

/** Pause embedding: stop consuming new batches but preserve already-written data. */
export function pauseEmbedding(): void {
  if (aiControlState !== "running") {
    return;
  }
  setAiControlState("pausing");
  setPoolCancelled(true);
  // Signal worker processes to abort their current batch (best-effort)
  try {
    abortAllWorkers();
  } catch {
    /* pool may not be running */
  }
}

/** Cancel embedding: stop and clean up all data written in this session. */
export function cancelEmbedding(): void {
  if (aiControlState === "idle") {
    return;
  }
  setAiControlState("cancelling");
  setPoolCancelled(true);
  // Signal worker processes to abort their current batch (best-effort)
  try {
    abortAllWorkers();
  } catch {
    /* pool may not be running */
  }
}

/** Resume embedding after pause: restart from where we left off.
 *  NOTE: isEmbedding must stay false here so embedAllPhotos's entry guard passes. */
export function resumeEmbedding(): boolean {
  if (aiControlState !== "paused") {
    return false;
  }
  setAiControlState("idle");
  setPoolCancelled(false);
  setIsPaused(false);
  setIsEmbedding(false);
  return true;
}

export function getEmbeddingProgress(): EmbedProgress & {
  controlState: typeof aiControlState;
  isActive: boolean;
  isModelLoaded: boolean;
  isPaused: boolean;
  runId: number;
} {
  return {
    ...currentProgress,
    controlState: aiControlState,
    isActive: isEmbedding || currentProgress.phase === "tagging",
    isModelLoaded,
    isPaused,
    runId: activeEmbeddingRunId,
  };
}
