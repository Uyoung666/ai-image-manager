import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import { trackChildProcess } from "@/services/tracked-child-processes";
import { ensureLocalModel } from "./model-loader";

export type TranslationState = "ready" | "loading" | "degraded" | "error";

const MODEL_ID = "Xenova/opus-mt-zh-en";
const MODEL_VERSION =
  "opus-mt-zh-en-quantized@92737ae29cee287d5b7dc400c52afb9407207640";
const INIT_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8000;
const IDLE_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CACHE_SIZE = 256;
const CJK_RE = /[一-鿿]/;

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (text: string) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface TranslationWorkerMessage {
  error?: unknown;
  requestId?: unknown;
  text?: unknown;
  type?: unknown;
}

function errorMessage(error: unknown, fallback: string): string {
  return typeof error === "string" && error ? error : fallback;
}

let child: ChildProcess | null = null;
let initPromise: Promise<void> | null = null;
let translationState: TranslationState = "degraded";
let requestCounter = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
const pending = new Map<number, PendingRequest>();
const cache = new Map<string, string>();
const inFlight = new Map<string, Promise<string>>();

function translationModelDirectory(modelsRoot: string): string {
  return path.join(modelsRoot, "Xenova", "opus-mt-zh-en");
}

export function isTranslationModelAvailable(modelsRoot: string): boolean {
  const onnxDir = path.join(translationModelDirectory(modelsRoot), "onnx");
  return (
    fs.existsSync(path.join(onnxDir, "encoder_model_quantized.onnx")) &&
    (fs.existsSync(path.join(onnxDir, "decoder_model_merged_quantized.onnx")) ||
      fs.existsSync(path.join(onnxDir, "decoder_model_quantized.onnx")))
  );
}

function findWorkerScript(): string {
  const candidates = app.isPackaged
    ? [
        path.join(
          process.resourcesPath,
          "app.asar.unpacked",
          "scripts",
          "translation-worker.mjs"
        ),
        path.join(process.resourcesPath, "scripts", "translation-worker.mjs"),
      ]
    : [
        path.join(process.cwd(), "scripts", "translation-worker.mjs"),
        path.join(app.getAppPath(), "scripts", "translation-worker.mjs"),
      ];
  const match = candidates.find((candidate) => fs.existsSync(candidate));
  if (!match) {
    throw new Error("translation-worker.mjs not found");
  }
  return match;
}

function clearIdleTimer(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function scheduleIdleShutdown(): void {
  clearIdleTimer();
  idleTimer = setTimeout(() => {
    shutdownTranslationWorker();
  }, IDLE_TIMEOUT_MS);
  idleTimer.unref?.();
}

function rejectAll(error: Error): void {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

function resetWorker(nextState: TranslationState): void {
  clearIdleTimer();
  child = null;
  initPromise = null;
  translationState = nextState;
}

export function getTranslationState(): TranslationState {
  return translationState;
}

export function getTranslationModelVersion(): string {
  return MODEL_VERSION;
}

export function initTranslationWorker(modelsRoot: string): Promise<void> {
  if (child?.connected && translationState === "ready") {
    scheduleIdleShutdown();
    return Promise.resolve();
  }
  if (initPromise) {
    return initPromise;
  }
  if (!isTranslationModelAvailable(modelsRoot)) {
    translationState = "degraded";
    return Promise.reject(
      new Error(`Local translation model is unavailable: ${MODEL_ID}`)
    );
  }

  translationState = "loading";
  initPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const worker = trackChildProcess(
      fork(findWorkerScript(), [], {
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      })
    );
    captureWorkerOutput(worker, "translation-worker");
    child = worker;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      worker.kill();
      resetWorker("error");
      reject(new Error("Translation worker initialization timed out"));
    }, INIT_TIMEOUT_MS);

    worker.on("message", (message: TranslationWorkerMessage) => {
      if (message?.type === "ready" && !settled) {
        settled = true;
        clearTimeout(timer);
        translationState = "ready";
        scheduleIdleShutdown();
        resolve();
        return;
      }
      if (message?.type === "init-error" && !settled) {
        settled = true;
        clearTimeout(timer);
        worker.kill();
        resetWorker("error");
        reject(
          new Error(errorMessage(message.error, "Translation worker failed"))
        );
        return;
      }
      const requestId = Number(message?.requestId);
      const request = pending.get(requestId);
      if (!request) {
        return;
      }
      pending.delete(requestId);
      clearTimeout(request.timer);
      if (message?.type === "result" && typeof message.text === "string") {
        request.resolve(message.text.trim());
      } else {
        request.reject(
          new Error(
            errorMessage(message?.error, "Translation worker request failed")
          )
        );
      }
      scheduleIdleShutdown();
    });

    worker.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      rejectAll(error);
      resetWorker("error");
    });

    worker.on("exit", (code) => {
      const error = new Error(
        `Translation worker exited${code === null ? "" : ` with code ${code}`}`
      );
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
      rejectAll(error);
      resetWorker(code === 0 ? "degraded" : "error");
    });

    worker.send({ type: "init", modelPath: modelsRoot });
  }).finally(() => {
    if (translationState !== "ready") {
      initPromise = null;
    }
  });
  return initPromise;
}

function getCachedTranslation(key: string): string | null {
  const value = cache.get(key);
  if (!value) {
    return null;
  }
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function setCachedTranslation(key: string, value: string): void {
  if (cache.size >= MAX_CACHE_SIZE) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) {
      cache.delete(oldest);
    }
  }
  cache.set(key, value);
}

async function performTranslation(
  text: string,
  modelsRoot: string
): Promise<string> {
  await initTranslationWorker(modelsRoot);
  if (!(child?.connected && translationState === "ready")) {
    throw new Error("Translation worker is not ready");
  }
  clearIdleTimer();
  const requestId = ++requestCounter;
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error("Translation request timed out"));
      scheduleIdleShutdown();
    }, REQUEST_TIMEOUT_MS);
    pending.set(requestId, { reject, resolve, timer });
    child?.send({ type: "translate", requestId, text });
  });
}

export async function translateChineseToEnglish(text: string): Promise<string> {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    throw new Error("Translation input is empty");
  }
  if (!CJK_RE.test(normalized)) {
    return normalized;
  }

  const cacheKey = `${MODEL_VERSION}:${normalized}`;
  const cached = getCachedTranslation(cacheKey);
  if (cached) {
    return cached;
  }
  const existing = inFlight.get(cacheKey);
  if (existing) {
    return existing;
  }

  const task = (async () => {
    const modelsRoot = await ensureLocalModel();
    const translated = (
      await performTranslation(normalized, modelsRoot)
    ).trim();
    if (!translated || CJK_RE.test(translated)) {
      throw new Error("Translation result is empty or still contains Chinese");
    }
    setCachedTranslation(cacheKey, translated);
    return translated;
  })();
  inFlight.set(cacheKey, task);
  try {
    return await task;
  } finally {
    if (inFlight.get(cacheKey) === task) {
      inFlight.delete(cacheKey);
    }
  }
}

export function warmupTranslationWorker(modelsRoot: string): Promise<void> {
  return initTranslationWorker(modelsRoot).catch(() => {
    translationState = "degraded";
  });
}

export function shutdownTranslationWorker(): void {
  clearIdleTimer();
  rejectAll(new Error("Translation worker shut down"));
  if (child?.connected) {
    child.send({ type: "shutdown" });
  } else {
    child?.kill();
  }
  resetWorker("degraded");
}

export function _resetTranslationClientForTest(): void {
  shutdownTranslationWorker();
  cache.clear();
  inFlight.clear();
  requestCounter = 0;
}
