import { type ChildProcess, fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { WORKER_TIMEOUT } from "./constants";
import {
  type EmbeddingModelKind,
  getActiveEmbeddingModel,
} from "./model-config";

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (vectors: number[][]) => void;
  timeout: ReturnType<typeof setTimeout>;
}

interface WorkerMessage {
  error?: string;
  requestId?: number;
  type: "ready" | "init-error" | "result" | "error";
  vectors?: number[][];
}

let worker: ChildProcess | null = null;
let workerKey: string | null = null;
let workerReady = false;
let initializationPromise: Promise<void> | null = null;
let nextRequestId = 1;
const pendingRequests = new Map<number, PendingRequest>();

function findTextWorkerScript(): string {
  const candidates = [
    path.join(app.getAppPath(), "scripts", "text-embed-worker.mjs"),
    path.join(
      app.getAppPath(),
      ".vite",
      "build",
      "scripts",
      "text-embed-worker.mjs"
    ),
    path.join(process.cwd(), "scripts", "text-embed-worker.mjs"),
    path.join(
      import.meta.dirname,
      "..",
      "..",
      "..",
      "scripts",
      "text-embed-worker.mjs"
    ),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("text-embed-worker.mjs not found");
}

function rejectPendingRequests(error: Error): void {
  for (const pending of pendingRequests.values()) {
    clearTimeout(pending.timeout);
    pending.reject(error);
  }
  pendingRequests.clear();
}

function validateVectors(vectors: unknown, expectedCount: number): number[][] {
  const dimensions = getActiveEmbeddingModel().vectorDimensions;
  if (
    !Array.isArray(vectors) ||
    vectors.length !== expectedCount ||
    vectors.some(
      (vector) =>
        !Array.isArray(vector) ||
        vector.length !== dimensions ||
        vector.some((value) => !Number.isFinite(value))
    )
  ) {
    throw new Error(
      `Invalid text embedding result: expected ${expectedCount}x${dimensions}`
    );
  }
  return vectors as number[][];
}

function handleRequestMessage(message: WorkerMessage): void {
  if (message.requestId === undefined) {
    return;
  }
  const pending = pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(message.requestId);
  clearTimeout(pending.timeout);
  if (message.type === "error") {
    pending.reject(
      new Error(message.error ?? "Text embedding worker request failed")
    );
  } else if (message.type === "result") {
    pending.resolve(message.vectors ?? []);
  }
}

export function initTextWorker(
  modelPath: string,
  modelKind: EmbeddingModelKind = getActiveEmbeddingModel().kind
): Promise<void> {
  const key = JSON.stringify({ modelKind, modelPath });
  if (worker?.connected && workerReady && workerKey === key) {
    return Promise.resolve();
  }
  if (initializationPromise && workerKey === key) {
    return initializationPromise;
  }
  if (worker) {
    shutdownTextWorker();
  }

  workerKey = key;
  workerReady = false;
  const child = fork(findTextWorkerScript(), [], {
    stdio: ["ignore", "inherit", "inherit", "ipc"],
  });
  worker = child;

  initializationPromise = new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error("Text embedding worker initialization timed out"));
      child.kill();
    }, WORKER_TIMEOUT);

    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    child.on("message", (message: WorkerMessage) => {
      if (message.type === "ready") {
        workerReady = true;
        finish();
        return;
      }
      if (message.type === "init-error") {
        finish(new Error(message.error ?? "Text embedding worker init failed"));
        child.kill();
        return;
      }
      handleRequestMessage(message);
    });

    child.on("error", (error) => {
      finish(error);
    });
    child.on("exit", (code, signal) => {
      const error = new Error(
        `Text embedding worker exited (code=${code ?? "null"}, signal=${signal ?? "null"})`
      );
      finish(error);
      rejectPendingRequests(error);
      if (worker === child) {
        worker = null;
        workerKey = null;
        workerReady = false;
        initializationPromise = null;
      }
    });

    child.send({ type: "init", modelKind, modelPath });
  }).finally(() => {
    initializationPromise = null;
  });

  return initializationPromise;
}

export async function embedTextsInWorker(
  texts: string[],
  modelPath: string
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }
  await initTextWorker(modelPath);
  const child = worker;
  if (!child?.connected) {
    throw new Error("Text embedding worker is unavailable");
  }

  const requestId = nextRequestId++;
  const vectors = await new Promise<number[][]>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId);
      reject(new Error("Text embedding worker request timed out"));
    }, WORKER_TIMEOUT);
    pendingRequests.set(requestId, { reject, resolve, timeout });
    try {
      child.send({ type: "embed", requestId, texts });
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(error);
    }
  });
  return validateVectors(vectors, texts.length);
}

export function shutdownTextWorker(): void {
  const child = worker;
  worker = null;
  workerKey = null;
  workerReady = false;
  initializationPromise = null;
  rejectPendingRequests(new Error("Text embedding worker shut down"));
  if (!child) {
    return;
  }
  try {
    child.send({ type: "shutdown" });
  } catch {
    child.kill();
  }
  setTimeout(() => {
    if (!child.killed) {
      child.kill();
    }
  }, 500);
}
