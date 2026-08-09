/**
 * GPU capability detection service (main process).
 *
 * Forks a lightweight gpu-probe.mjs worker to check DirectML availability.
 * Caches the result in app_settings so detection only runs once.
 * Notifies the renderer via webContents.send so the UI can show a
 * one-time onboarding dialog for users whose GPU supports DirectML.
 */

import { fork } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow } from "electron";
import { captureWorkerOutput } from "@/services/diagnostics/worker-output";
import { getSetting, setSetting } from "@/services/settings-manager";
import { createLogger } from "@/utils/logger";

const log = createLogger("gpu-detector");

// ── Types ────────────────────────────────────────────────────────────

export interface GpuProbeResult {
  dmlAvailable: boolean;
  error?: string;
  gpuName?: string;
  probeTimeMs: number;
}

// ── Path resolution (matches face-detector / worker-pool conventions) ──

export function findModelsDir(): string {
  if (app.isPackaged) {
    const bundled = path.join(process.resourcesPath, "models-release");
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "models");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "models");
  if (fs.existsSync(alt)) {
    return alt;
  }
  return path.join(cwd, "models");
}

function findProbeScript(): string {
  if (app.isPackaged) {
    const unpacked = path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "scripts",
      "gpu-probe.mjs"
    );
    if (fs.existsSync(unpacked)) {
      return unpacked;
    }
    const bundled = path.join(
      process.resourcesPath,
      "scripts",
      "gpu-probe.mjs"
    );
    if (fs.existsSync(bundled)) {
      return bundled;
    }
  }
  const cwd = process.cwd();
  const candidate = path.join(cwd, "scripts", "gpu-probe.mjs");
  if (fs.existsSync(candidate)) {
    return candidate;
  }
  const alt = path.join(app.getAppPath(), "scripts", "gpu-probe.mjs");
  if (fs.existsSync(alt)) {
    return alt;
  }
  throw new Error("gpu-probe.mjs not found");
}

// ── Detection ────────────────────────────────────────────────────────

const PROBE_TIMEOUT_MS = 15_000;

/**
 * Fork the gpu-probe worker and wait for its DML availability verdict.
 * The parent enforces a 15 s timeout — if the worker hangs (driver issue),
 * we return dmlAvailable=false rather than blocking indefinitely.
 */
export function probeGpuCapability(modelsDir: string): Promise<GpuProbeResult> {
  const scriptPath = findProbeScript();

  return new Promise((resolve) => {
    let resolved = false;

    const child = fork(scriptPath, [], {
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      timeout: PROBE_TIMEOUT_MS,
    });
    captureWorkerOutput(child, "gpu-probe-worker");

    const timeout = setTimeout(() => {
      if (resolved) {
        return;
      }
      resolved = true;
      child.kill();
      resolve({
        dmlAvailable: false,
        error: "Detection timed out after 15s",
        probeTimeMs: PROBE_TIMEOUT_MS,
      });
    }, PROBE_TIMEOUT_MS);

    child.on(
      "message",
      (msg: {
        type?: string;
        dmlAvailable?: boolean;
        gpuName?: string;
        error?: string;
        probeTimeMs?: number;
      }) => {
        if (msg?.type === "result" && !resolved) {
          resolved = true;
          clearTimeout(timeout);
          resolve({
            dmlAvailable: msg.dmlAvailable === true,
            gpuName: msg.gpuName,
            error: msg.error,
            probeTimeMs: msg.probeTimeMs ?? 0,
          });
        }
      }
    );

    child.on("exit", () => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timeout);
        resolve({
          dmlAvailable: false,
          error: "Probe worker exited unexpectedly",
          probeTimeMs: 0,
        });
      }
    });

    child.send({ type: "probe", modelsDir });
  });
}

// ── Settings cache helpers ───────────────────────────────────────────

/** Persist probe result so we don't re-detect on every launch. */
export function cacheDetectionResult(result: GpuProbeResult): void {
  setSetting(
    "gpu.detected",
    JSON.stringify({ ...result, timestamp: Date.now() })
  );
}

/** Read the cached probe result, if any. */
export function getCachedDetection(): GpuProbeResult | null {
  const raw = getSetting("gpu.detected");
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as GpuProbeResult & { timestamp?: number };
    // Reject cached results that picked up a virtual adapter
    // (e.g. MuMu Virtual Display Adapter from Android emulators).
    if (parsed.gpuName && isVirtualGpuName(parsed.gpuName)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

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

function isVirtualGpuName(name: string): boolean {
  return VIRTUAL_GPU_PATTERNS.some((p) => p.test(name));
}

// ── Prompt gating ───────────────────────────────────────────────────

/**
 * Should we show the "GPU detected — enable now?" onboarding dialog?
 *
 * Conditions:
 *   1. User has NOT already seen the dialog (gpu.promptShown is absent).
 *   2. User has NOT explicitly chosen a GPU preference
 *      (gpu.enabled is absent — meaning they never toggled it).
 *   3. The cached probe says DML is available.
 */
export function shouldPromptUser(): boolean {
  if (getSetting("gpu.promptShown") === "true") {
    return false;
  }
  if (getSetting("gpu.enabled") !== null) {
    return false; // user chose
  }
  const cached = getCachedDetection();
  return cached?.dmlAvailable === true;
}

export function markPromptShown(): void {
  setSetting("gpu.promptShown", "true");
}

// ── Orchestration: called on startup ────────────────────────────────

/**
 * Run once after background services are up.  Probes GPU (or reads the
 * cache), persists the result, and sends the appropriate IPC event to
 * every open renderer window so the UI can decide whether to show the
 * onboarding dialog.
 */
export async function probeAndNotifyIfNeeded(): Promise<void> {
  let result = getCachedDetection();

  if (!result) {
    const modelsDir = findModelsDir();
    result = await probeGpuCapability(modelsDir);
    cacheDetectionResult(result);
    log.info(
      { dmlAvailable: result.dmlAvailable, gpuName: result.gpuName },
      "GPU detection complete"
    );
  }

  const shouldPrompt = shouldPromptUser();

  for (const win of BrowserWindow.getAllWindows()) {
    if (shouldPrompt) {
      win.webContents.send("gpu:prompt-user", result);
    } else {
      win.webContents.send("gpu:detection-done", result);
    }
  }
}
