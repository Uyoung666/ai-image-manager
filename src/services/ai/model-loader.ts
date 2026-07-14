import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { abortAllWorkers } from "@/services/embed-worker-pool";
import { getSetting } from "@/services/settings-manager";
import { getDataPath } from "@/utils/data-path";
import { isSafePath } from "@/utils/path-security";
import { disposeTensors } from "./constants";
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

function detectDefaultMirror(): string | null {
  const locale = app.getLocale();

  if (locale.startsWith("zh")) {
    return "https://hf-mirror.com";
  }

  return null;
}

function resolveMirrorUrl(): string | null {
  // 1. 环境变量最高优先级
  const envMirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (envMirror) {
    console.log(`[AI] Using mirror from env: ${envMirror}`);
    return envMirror;
  }

  // 2. 读取用户保存的设置
  try {
    const savedMirror = getSetting("ai.mirror") || "auto";

    if (savedMirror === "official") {
      console.log("[AI] Using official HuggingFace");
      return null;
    }
    if (savedMirror === "hf-mirror") {
      console.log("[AI] Using hf-mirror.com from settings");
      return "https://hf-mirror.com";
    }
    if (savedMirror === "modelscope") {
      console.log("[AI] Using modelscope.cn from settings");
      return "https://modelscope.cn";
    }
    if (savedMirror === "custom") {
      const customUrl = getSetting("ai.mirror.customUrl") || "";
      if (customUrl) {
        console.log(`[AI] Using custom mirror: ${customUrl}`);
        return customUrl;
      }
    }
    // "auto" → 走自动检测
  } catch {
    // settings-manager 不可用时跳过
  }

  // 3. 自动检测
  return detectDefaultMirror();
}

// 解析一次，缓存结果，同时设置环境变量供 worker 进程继承
function getResolvedMirror(): string | null {
  const mirror = resolveMirrorUrl();
  if (mirror) {
    process.env.HF_MIRROR = mirror;
  }
  return mirror;
}

function configureTransformersEnv(env: any, localModelPath: string): void {
  env.localModelPath = localModelPath;
  env.allowLocalModels = true;
  env.useFS = true;
  env.useFSCache = true;
  env.cacheDir = path.join(getDataPath(), "hf-cache");

  const mirror = getResolvedMirror();

  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/resolve/main/";
    console.log(`[AI] Using HF mirror: ${mirror}`);
  }

  env.allowRemoteModels = true;
}

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
  const visionMarker = path.join(
    modelsDir,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "vision_model_quantized.onnx"
  );
  const textMarker = path.join(
    modelsDir,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "text_model_quantized.onnx"
  );

  // Already cached from a previous run — no work needed.
  if (fs.existsSync(visionMarker) && fs.existsSync(textMarker)) {
    return;
  }

  // Copy already in progress — wait for it.
  if (_modelCopyPromise) {
    return _modelCopyPromise;
  }

  _modelCopyPromise = (async () => {
    try {
      if (app.isPackaged) {
        const bundledModels = path.join(process.resourcesPath, "models");
        const bundledMarker = path.join(
          bundledModels,
          "Xenova",
          "clip-vit-base-patch32",
          "onnx",
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

  const visionMarker = path.join(
    localModelPath,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "vision_model_quantized.onnx"
  );
  const textMarker = path.join(
    localModelPath,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
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
    const marker = path.join(
      candidate,
      "Xenova",
      "clip-vit-base-patch32",
      "onnx",
      "vision_model_quantized.onnx"
    );
    if (fs.existsSync(marker)) {
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
    throw new Error("CLIP 本地模型路径解析失败");
  }

  try {
    (process.release as any).name = "browser";
  } catch {
    try {
      Object.defineProperty(process.release, "name", { value: "browser" });
    } catch {
      console.error(
        "[AI] Cannot override process.release.name, ONNX backend may fail"
      );
    }
  }

  const { AutoTokenizer, CLIPTextModelWithProjection, env } = await import(
    "@xenova/transformers"
  );

  try {
    (process.release as any).name = "node";
  } catch {
    /* ignore */
  }

  configureTransformersEnv(env, localModelPath);

  // Single-threaded WASM to avoid SharedArrayBuffer issues in Electron main process.
  // Only loading the text model (~64MB quantized ONNX) — vision model is isolated
  // in child processes via embed-worker.mjs to prevent WASM heap exhaustion.
  env.backends.onnx.wasm.numThreads = 1;
  console.log(
    "[AI] Using ONNX Web (WASM) backend — single-threaded, text-model only"
  );

  const modelId = "Xenova/clip-vit-base-patch32";
  const tokenizer = await AutoTokenizer.from_pretrained(modelId);
  const textModel = await CLIPTextModelWithProjection.from_pretrained(modelId, {
    quantized: true,
  });

  const embedTexts = async (texts: string[]): Promise<number[][]> => {
    if (texts.length === 0) {
      return [];
    }

    const inputs = await tokenizer(texts, {
      padding: true,
      truncation: true,
    });
    const output = await textModel(inputs);
    try {
      const { text_embeds: textEmbeds } = output;
      const data = Array.from(textEmbeds.data as Float32Array);
      const vectorSize = data.length / texts.length;
      if (!Number.isInteger(vectorSize) || vectorSize <= 0) {
        throw new Error("CLIP 文本向量维度无效");
      }

      return texts.map((_, index) => {
        const vec = data.slice(index * vectorSize, (index + 1) * vectorSize);
        const norm = Math.sqrt(
          vec.reduce((sum: number, value: number) => sum + value * value, 0)
        );
        return vec.map((value: number) => value / (norm || 1));
      });
    } finally {
      disposeTensors(output);
    }
  };

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
    "[AI] CLIP text model loaded (vision model isolated in worker processes)"
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
    isActive: isEmbedding,
    isModelLoaded,
    isPaused,
    runId: activeEmbeddingRunId,
  };
}
