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
  currentProgress,
  embeddingModel,
  isEmbedding,
  isModelLoaded,
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

function copyDir(src: string, dest: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    // 验证源路径和目标路径的安全性
    const allowedSources = [
      process.resourcesPath,
      app.getAppPath(),
      process.cwd(),
    ];
    const allowedDestinations = [getDataPath()];

    if (!isSafePath(src, allowedSources)) {
      reject(new Error(`[Security] 不安全的源路径: ${src}`));
      return;
    }

    if (!isSafePath(dest, allowedDestinations)) {
      reject(new Error(`[Security] 不安全的目标路径: ${dest}`));
      return;
    }

    fs.cp(src, dest, { recursive: true }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function hasBundledClipModel(): boolean {
  const resourcesPath = process.resourcesPath;
  const bundledModelPath = path.join(resourcesPath, "models");
  const bundledMarker = path.join(
    bundledModelPath,
    "Xenova",
    "clip-vit-base-patch32",
    "onnx",
    "model_quantized.onnx"
  );
  return fs.existsSync(bundledMarker);
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

  // ── Production: copy from bundled resources ────────────────
  if (app.isPackaged) {
    const bundledModelPath = path.join(process.resourcesPath, "models");
    const bundledVisionMarker = path.join(
      bundledModelPath,
      "Xenova",
      "clip-vit-base-patch32",
      "onnx",
      "vision_model_quantized.onnx",
    );

    if (fs.existsSync(bundledVisionMarker)) {
      console.log("[AI] Copying bundled models to userData...");
      await copyDir(bundledModelPath, localModelPath);
      console.log("[AI] Models copied from resources");
      return localModelPath;
    }

    const error =
      "安装包未包含模型文件，请重新打包";
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
      "vision_model_quantized.onnx",
    );
    if (fs.existsSync(marker)) {
      console.log(`[AI] Found model at: ${candidate}`);
      return candidate;
    }
  }

  throw new Error("Model not found in dev paths");
}

export async function loadModel(): Promise<void> {
  if (isModelLoaded && embeddingModel) {
    return;
  }

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

  setEmbeddingModel({
    // embedImage is intentionally NOT provided here — image embedding goes
    // through embedImageInWorker() to keep the WASM heap within limits.
    embedImage: async (_imagePath: string) => {
      throw new Error(
        "embedImage not available in main process — use embedImageInWorker()"
      );
    },
    embedText: async (text: string) => {
      const inputs = await tokenizer([text], {
        padding: true,
        truncation: true,
      });
      const output = await textModel(inputs);
      try {
        const { text_embeds } = output;
        const vec = Array.from(text_embeds.data as Float32Array);
        const norm = Math.sqrt(
          vec.reduce((s: number, v: number) => s + v * v, 0)
        );
        return vec.map((v: number) => v / (norm || 1));
      } finally {
        disposeTensors(output);
      }
    },
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
  setIsEmbedding(false);
  setPoolCancelled(true);
}

/** Pause embedding: stop consuming new batches but preserve already-written data. */
export function pauseEmbedding(): void {
  setIsEmbedding(false);
  setPoolCancelled(true);
  setIsPaused(true);
  // Signal worker processes to abort their current batch (best-effort)
  try {
    abortAllWorkers();
  } catch {
    /* pool may not be running */
  }
}

/** Cancel embedding: stop and clean up all data written in this session. */
export function cancelEmbedding(): void {
  setIsEmbedding(false);
  setPoolCancelled(true);
  setIsPaused(false);
  // Signal worker processes to abort their current batch (best-effort)
  try {
    abortAllWorkers();
  } catch {
    /* pool may not be running */
  }
}

/** Resume embedding after pause: restart from where we left off.
 *  NOTE: isEmbedding must stay false here so embedAllPhotos's entry guard passes. */
export function resumeEmbedding(): void {
  setIsPaused(false);
  setPoolCancelled(false);
}

export function getEmbeddingProgress(): EmbedProgress & {
  isActive: boolean;
  isModelLoaded: boolean;
} {
  return {
    ...currentProgress,
    isActive: isEmbedding,
    isModelLoaded,
  };
}
