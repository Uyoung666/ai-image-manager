import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { getDataPath } from "@/utils/data-path";
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
  setLocalModelPath,
} from "./state";

function configureTransformersEnv(env: any, localModelPath: string): void {
  env.localModelPath = localModelPath;
  env.allowLocalModels = true;
  env.useFS = true;
  env.useFSCache = true;
  env.cacheDir = path.join(getDataPath(), "hf-cache");

  const mirror = process.env.HF_MIRROR || process.env.HF_ENDPOINT;
  if (mirror) {
    env.remoteHost = mirror;
    env.remotePathTemplate = "{model}/resolve/main/";
    console.log(`[AI] Using HF mirror: ${mirror}`);
  }

  env.allowRemoteModels = true;
}

function copyDir(src: string, dest: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
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

function getClipProgressPercent(): number {
  const startedAt = currentProgress.loadingStartedAt;
  if (!startedAt) {
    return 1;
  }
  const elapsed = Date.now() - startedAt;
  return Math.max(1, Math.min(95, 1 + Math.floor(elapsed / 1500)));
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

  try {
    const resourcesPath = process.resourcesPath;
    const bundledModelPath = path.join(resourcesPath, "models");
    const bundledVisionMarker = path.join(
      bundledModelPath,
      "Xenova",
      "clip-vit-base-patch32",
      "onnx",
      "vision_model_quantized.onnx"
    );

    if (fs.existsSync(bundledVisionMarker)) {
      console.log("[AI] Copying bundled models to userData...");
      await copyDir(bundledModelPath, localModelPath);
      console.log("[AI] Models copied from resources");
      return localModelPath;
    }
  } catch {
    // Not packaged
  }

  if (!app.isPackaged) {
    const devCandidates = [
      path.join(process.cwd(), "models"),
      path.join(app.getAppPath(), "models"),
      path.join(app.getAppPath(), "..", "models"),
      path.join(app.getAppPath(), "..", "..", "models"),
    ];

    console.log("[AI] Dev mode - searching for models...");
    for (const candidate of devCandidates) {
      const marker = path.join(
        candidate,
        "Xenova",
        "clip-vit-base-patch32",
        "onnx",
        "vision_model_quantized.onnx"
      );
      console.log(`[AI]   check: ${marker}`);
      if (fs.existsSync(marker)) {
        console.log(`[AI] Found model at: ${candidate}`);
        return candidate;
      }
    }
    console.log("[AI] Model not found in dev paths, will attempt download");
    return localModelPath;
  }

  const error =
    "安装包未包含 CLIP 模型文件，请重新打包并确认 resources/models/Xenova/clip-vit-base-patch32/onnx/model_quantized.onnx 存在";
  setCurrentProgress({
    ...currentProgress,
    phase: "error",
    currentFile: "",
    downloadPercent: undefined,
    error,
  });
  throw new Error(error);
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
      console.error("[AI] Cannot override process.release.name, ONNX backend may fail");
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
