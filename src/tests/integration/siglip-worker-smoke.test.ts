import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getActiveEmbeddingAdapter } from "@/services/ai/model-adapter";
import {
  getActiveEmbeddingRuntimeInfo,
  getActiveEmbeddingWorkerAdapter,
} from "@/services/ai/model-config";
import { verifyAdapterArtifacts } from "@/services/ai/model-fingerprint";

interface WorkerMessage {
  adapterId?: string;
  error?: string;
  fingerprint?: string;
  requestId?: number;
  results?: Array<{ error?: string; id: number; vector?: number[] }>;
  type?: string;
  vectors?: number[][];
}

interface WorkerHandle {
  child: ChildProcess;
  getStderr: () => string;
}

interface WorkerSmokeResult {
  adapterId: string;
  fingerprint: string;
  imageVector: number[];
  textVector: number[];
}

const projectRoot = process.cwd();
const packagedResources = process.env.AIM_WORKER_SMOKE_RESOURCES?.trim();
const modelRoot = packagedResources
  ? path.join(packagedResources, "models-release")
  : path.join(projectRoot, "models");
const workerRoot = packagedResources
  ? path.join(packagedResources, "app.asar.unpacked", "scripts")
  : path.join(projectRoot, "scripts");
const imageWorkerPath = path.join(workerRoot, "embed-worker.mjs");
const textWorkerPath = path.join(workerRoot, "text-embed-worker.mjs");

let tempRoot = "";
let testImagePath = "";
let testUserDataPath = "";
let testVectorPath = "";

function spawnProductionWorker(scriptPath: string): WorkerHandle {
  let stderr = "";
  const child = fork(scriptPath, [], {
    cwd: projectRoot,
    env: {
      ...process.env,
      AIM_SMOKE_USER_DATA: testUserDataPath,
      AIM_SMOKE_VECTOR_DIR: testVectorPath,
      ELECTRON_RUN_AS_NODE: "1",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return { child, getStderr: () => stderr };
}

function sendAndWait(
  handle: WorkerHandle,
  message: object,
  predicate: (response: WorkerMessage) => boolean,
  timeoutMs = 120_000
): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const { child } = handle;
    const cleanup = () => {
      clearTimeout(timeout);
      child.off("error", onError);
      child.off("exit", onExit);
      child.off("message", onMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Worker exited before responding (code=${String(code)}, signal=${String(signal)}): ${handle.getStderr()}`
        )
      );
    };
    const onMessage = (response: WorkerMessage) => {
      if (!predicate(response)) {
        return;
      }
      cleanup();
      resolve(response);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Worker response timed out after ${timeoutMs}ms: ${handle.getStderr()}`
        )
      );
    }, timeoutMs);
    child.on("error", onError);
    child.on("exit", onExit);
    child.on("message", onMessage);
    child.send(message);
  });
}

async function stopWorker(handle: WorkerHandle | null): Promise<void> {
  if (!handle || handle.child.exitCode !== null) {
    return;
  }
  const { child } = handle;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => {
      child.kill();
      resolve();
    }, 2000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    try {
      child.send({ type: "shutdown" });
    } catch {
      child.kill();
    }
  });
}

function expectNormalizedVector(vector: unknown, dimensions: number): void {
  expect(Array.isArray(vector)).toBe(true);
  const values = vector as number[];
  expect(values).toHaveLength(dimensions);
  expect(values.every(Number.isFinite)).toBe(true);
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  expect(norm).toBeCloseTo(1, 4);
}

function fileSha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function cosineSimilarity(left: number[], right: number[]): number {
  expect(left).toHaveLength(right.length);
  return left.reduce(
    (sum, value, index) => sum + value * (right[index] ?? 0),
    0
  );
}

async function runProductionWorkerSmoke(
  layoutWorkerRoot: string,
  layoutModelRoot: string
): Promise<WorkerSmokeResult> {
  const layoutImageWorker = path.join(layoutWorkerRoot, "embed-worker.mjs");
  const layoutTextWorker = path.join(layoutWorkerRoot, "text-embed-worker.mjs");
  expect(fs.existsSync(layoutImageWorker)).toBe(true);
  expect(fs.existsSync(layoutTextWorker)).toBe(true);

  const activeAdapter = getActiveEmbeddingAdapter();
  const runtimeInfo = getActiveEmbeddingRuntimeInfo();
  const workerAdapter = getActiveEmbeddingWorkerAdapter(layoutModelRoot);
  expect(activeAdapter.id).toBe("siglip-v1-base-patch16-224");
  expect(activeAdapter.embeddingSpace.dimensions).toBe(768);
  expect(
    await verifyAdapterArtifacts(layoutModelRoot, activeAdapter.artifacts)
  ).toBe(true);
  expect(workerAdapter.adapterId).toBe(runtimeInfo.adapterId);
  expect(workerAdapter.fingerprint).toBe(runtimeInfo.fingerprint);

  let imageWorker: WorkerHandle | null =
    spawnProductionWorker(layoutImageWorker);
  let textWorker: WorkerHandle | null = null;
  try {
    const imageReady = await sendAndWait(
      imageWorker,
      {
        type: "init",
        adapter: workerAdapter,
        execution: { intraOpNumThreads: 1, provider: "cpu" },
      },
      (message) => message.type === "ready" || message.type === "init-error"
    );
    expect(imageReady.error).toBeUndefined();
    expect(imageReady.adapterId).toBe(runtimeInfo.adapterId);
    expect(imageReady.fingerprint).toBe(runtimeInfo.fingerprint);

    const imageResult = await sendAndWait(
      imageWorker,
      { type: "embed", photos: [{ id: 1, path: testImagePath }] },
      (message) => message.type === "result"
    );
    expect(imageResult.adapterId).toBe(runtimeInfo.adapterId);
    expect(imageResult.fingerprint).toBe(runtimeInfo.fingerprint);
    expect(imageResult.results).toHaveLength(1);
    expect(imageResult.results?.[0]?.error).toBeUndefined();
    const imageVector = imageResult.results?.[0]?.vector;
    expectNormalizedVector(imageVector, 768);

    await stopWorker(imageWorker);
    imageWorker = null;

    textWorker = spawnProductionWorker(layoutTextWorker);
    const textReady = await sendAndWait(
      textWorker,
      { type: "init", adapter: workerAdapter },
      (message) => message.type === "ready" || message.type === "init-error"
    );
    expect(textReady.error).toBeUndefined();
    expect(textReady.adapterId).toBe(runtimeInfo.adapterId);
    expect(textReady.fingerprint).toBe(runtimeInfo.fingerprint);

    const textResult = await sendAndWait(
      textWorker,
      { type: "embed", requestId: 7, texts: ["a red square"] },
      (message) =>
        message.requestId === 7 &&
        (message.type === "result" || message.type === "error")
    );
    expect(textResult.error).toBeUndefined();
    expect(textResult.adapterId).toBe(runtimeInfo.adapterId);
    expect(textResult.fingerprint).toBe(runtimeInfo.fingerprint);
    expect(textResult.vectors).toHaveLength(1);
    const textVector = textResult.vectors?.[0];
    expectNormalizedVector(textVector, 768);

    return {
      adapterId: runtimeInfo.adapterId,
      fingerprint: runtimeInfo.fingerprint,
      imageVector: imageVector as number[],
      textVector: textVector as number[],
    };
  } finally {
    await stopWorker(imageWorker);
    await stopWorker(textWorker);
  }
}

let selectedLayoutResult: WorkerSmokeResult | null = null;

describe.sequential("SigLIP v1 production worker smoke", () => {
  beforeAll(async () => {
    tempRoot = await fsPromises.mkdtemp(
      path.join(os.tmpdir(), "ai-image-manager-siglip-smoke-")
    );
    testUserDataPath = path.join(tempRoot, "userData");
    testVectorPath = path.join(tempRoot, "vectors");
    await fsPromises.mkdir(testUserDataPath, { recursive: true });
    await fsPromises.mkdir(testVectorPath, { recursive: true });
    testImagePath = path.join(tempRoot, "synthetic-smoke.png");
    await sharp({
      create: {
        background: { alpha: 1, b: 32, g: 64, r: 192 },
        channels: 3,
        height: 48,
        width: 64,
      },
    })
      .png()
      .toFile(testImagePath);
  });

  afterAll(async () => {
    if (tempRoot) {
      await fsPromises.rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("loads current assets and returns identity-bound 768d L2 image/text vectors", async () => {
    selectedLayoutResult = await runProductionWorkerSmoke(
      workerRoot,
      modelRoot
    );
    expect(fs.existsSync(testUserDataPath)).toBe(true);
    expect(fs.existsSync(testVectorPath)).toBe(true);
  });

  it.runIf(Boolean(packagedResources))(
    "keeps packaged worker scripts and vectors consistent with source",
    async () => {
      const sourceWorkerRoot = path.join(projectRoot, "scripts");
      expect(fileSha256(imageWorkerPath)).toBe(
        fileSha256(path.join(sourceWorkerRoot, "embed-worker.mjs"))
      );
      expect(fileSha256(textWorkerPath)).toBe(
        fileSha256(path.join(sourceWorkerRoot, "text-embed-worker.mjs"))
      );

      const sourceResult = await runProductionWorkerSmoke(
        sourceWorkerRoot,
        path.join(projectRoot, "models")
      );
      expect(selectedLayoutResult).not.toBeNull();
      expect(sourceResult.adapterId).toBe(selectedLayoutResult?.adapterId);
      expect(sourceResult.fingerprint).toBe(selectedLayoutResult?.fingerprint);
      expect(
        cosineSimilarity(
          sourceResult.imageVector,
          selectedLayoutResult?.imageVector ?? []
        )
      ).toBeGreaterThan(0.999_999);
      expect(
        cosineSimilarity(
          sourceResult.textVector,
          selectedLayoutResult?.textVector ?? []
        )
      ).toBeGreaterThan(0.999_999);
    }
  );
});
