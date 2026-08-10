/**
 * Isolated DirectML probe for the active SigLIP vision ONNX model.
 *
 * DirectML can terminate the native ONNX Runtime process for an unsupported
 * graph. This worker therefore owns only the probe session; the Electron main
 * process treats an unexpected exit as a normal CPU-fallback result.
 */

import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);

function loadOrt() {
  try {
    return require("onnxruntime-node");
  } catch {
    const projectRoot = path.resolve(import.meta.dirname, "..");
    return require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
}

async function handleProbe(message) {
  const startedAt = Date.now();
  if (process.platform !== "win32" || process.arch !== "x64") {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: "SigLIP DirectML embedding requires Windows x64",
      probeTimeMs: Date.now() - startedAt,
    });
    process.exit(0);
    return;
  }

  const modelPath = String(message.modelPath || "");
  const inputName = String(message.inputName || "pixel_values");
  const imageSize = Number(message.imageSize || 224);
  if (!(modelPath && fs.existsSync(modelPath))) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: `Model not found: ${modelPath}`,
      probeTimeMs: Date.now() - startedAt,
    });
    process.exit(0);
    return;
  }

  try {
    const { InferenceSession, Tensor } = loadOrt();
    const session = await InferenceSession.create(modelPath, {
      executionProviders: ["dml"],
      enableMemPattern: false,
      executionMode: "sequential",
      graphOptimizationLevel: "basic",
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
      logSeverityLevel: 3,
    });

    // Session creation alone is insufficient: run one real inference so a
    // provider/model combination that crashes during execution is rejected.
    const pixels = new Tensor(
      "float32",
      new Float32Array(3 * imageSize * imageSize),
      [1, 3, imageSize, imageSize]
    );
    const output = await session.run({ [inputName]: pixels });
    for (const value of Object.values(output)) {
      value?.dispose?.();
    }
    await session.release?.();

    process.send?.({
      type: "result",
      dmlAvailable: true,
      probeTimeMs: Date.now() - startedAt,
    });
  } catch (error) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: error instanceof Error ? error.message : String(error),
      probeTimeMs: Date.now() - startedAt,
    });
  }
  process.exit(0);
}

process.on("message", (message) => {
  if (message?.type === "probe") {
    handleProbe(message);
  }
});
