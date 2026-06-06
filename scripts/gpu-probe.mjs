/**
 * GPU capability probe worker.
 *
 * Lightweight one-shot worker that probes DirectML GPU availability.
 * Uses the smallest available ONNX model (ultraface-320.onnx, ~300KB)
 * via onnxruntime-node to test whether the DML execution provider works.
 *
 * IPC Protocol:
 *   Parent → { type: "probe", modelsDir: "..." }
 *   Worker → { type: "result", dmlAvailable, gpuName?, error?, probeTimeMs }
 *   Worker exits with code 0.
 *
 * Timeout is enforced by the parent — this worker has no self-timeout.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

// ── GPU name detection (best-effort, no extra dependencies) ──────────

const VIRTUAL_GPU_PATTERNS = [
  /virtual/i,
  /mumu/i,
  /remote\s*display/i,
  /basic\s*display/i,
  /hyper-?v/i,
  /vmware/i,
  /virtualbox/i,
  /citrix/i,
  /parsec/i,
  /software/i,
  /indirect\s*display/i,
];

function isRealGpu(name) {
  return !VIRTUAL_GPU_PATTERNS.some((p) => p.test(name));
}

function getGpuName() {
  const allNames = [];

  // wmic is fast and available on all supported Windows versions.
  try {
    const raw = execFileSync(
      "wmic",
      ["path", "Win32_VideoController", "get", "name", "/format:csv"],
      { timeout: 5000, encoding: "utf-8" }
    );
    for (const line of raw.trim().split("\n")) {
      const name = line.split(",")[1]?.trim();
      if (name && name !== "Name") {
        allNames.push(name);
      }
    }
  } catch {
    /* fall through to PowerShell */
  }

  if (allNames.length === 0) {
    try {
      const raw = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name",
        ],
        { timeout: 5000, encoding: "utf-8" }
      );
      for (const line of raw.trim().split("\n")) {
        const name = line.trim();
        if (name) {
          allNames.push(name);
        }
      }
    } catch {
      /* fall through */
    }
  }

  // Return the first real GPU, filtering out virtual adapters
  for (const name of allNames) {
    if (isRealGpu(name)) {
      return name;
    }
  }

  // If all were filtered out, fall back to the first name (better than nothing)
  return allNames[0] || null;
}

// ── onnxruntime-node lazy-load (same pattern as face-worker / embed-worker) ──

let _ort = null;
function loadOrt() {
  if (_ort) {
    return _ort;
  }
  const require = createRequire(import.meta.url);
  try {
    _ort = require("onnxruntime-node");
  } catch {
    // Fallback: packaged builds may alias node_modules elsewhere.
    const projectRoot = path.resolve(import.meta.dirname, "..");
    _ort = require(path.join(projectRoot, "node_modules", "onnxruntime-node"));
  }
  return _ort;
}

// ── Probe handler ────────────────────────────────────────────────────

async function handleProbe(modelsDir) {
  const probeStart = Date.now();

  const faceModel = path.join(modelsDir, "face", "ultraface-320.onnx");

  if (!fs.existsSync(faceModel)) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: `Model not found: ${faceModel}`,
      probeTimeMs: Date.now() - probeStart,
    });
    process.exit(0);
    return;
  }

  try {
    const { InferenceSession } = await loadOrt();

    // DML-only session — if this throws, DML is unavailable (JS-catchable).
    const session = await InferenceSession.create(faceModel, {
      executionProviders: ["dml"],
      logSeverityLevel: 3,
    });

    const gpuName = getGpuName();

    // Release session resources before exiting.
    try {
      await session.release?.();
    } catch {
      /* best-effort */
    }

    process.send?.({
      type: "result",
      dmlAvailable: true,
      gpuName: gpuName || "DirectML Compatible GPU",
      probeTimeMs: Date.now() - probeStart,
    });
  } catch (err) {
    process.send?.({
      type: "result",
      dmlAvailable: false,
      error: err.message || String(err),
      probeTimeMs: Date.now() - probeStart,
    });
  }

  process.exit(0);
}

// ── Message loop ─────────────────────────────────────────────────────

process.on("message", (msg) => {
  if (msg?.type === "probe") {
    handleProbe(msg.modelsDir);
  }
});
