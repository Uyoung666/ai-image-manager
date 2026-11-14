import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { createLogger } from "@/utils/logger";
import { embedAllPhotos, ignoreActiveEmbeddingFailure } from "./ai/embedder";
import { planEmbeddingRetries } from "./ai/embedding-refresh-retries";
import { pauseEmbedding } from "./ai/model-loader";
import {
  getAiControlState,
  isAiIndexResetting,
  isModelLoaded,
  isVectorDBReady,
} from "./ai/state";
import { getSetting, setSetting } from "./settings-manager";

export interface AutoIndexStatus {
  failedPhotos: number;
  reason?: "model" | "vector-db" | "busy" | "scan" | "failed";
  state: "idle" | "queued" | "running" | "paused" | "blocked" | "error";
}

const log = createLogger("ai-index-scheduler");
const STOP_KEY = "ai.autoIndexStopped";
let stopped = true;
let held = false;
let pending = false;
let firstRequest = 0;
let timer: ReturnType<typeof setTimeout> | undefined;
let active: Promise<void> | undefined;
let automaticController: AbortController | undefined;
let scanBusy: () => boolean = () => false;
let failedPhotos = 0;
let fatal = false;
let manualRetryRequested = false;
let status: AutoIndexStatus = { state: "idle", failedPhotos: 0 };

function publish(
  state: AutoIndexStatus["state"],
  reason?: AutoIndexStatus["reason"]
) {
  const next = { state, reason, failedPhotos };
  if (JSON.stringify(next) === JSON.stringify(status)) {
    return;
  }
  status = next;
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ai-status-changed");
  }
}

export function getAutoIndexStatus(): AutoIndexStatus {
  return { ...status };
}

function schedule(delay: number) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    drain().catch((error) => {
      fatal = true;
      log.error({ error }, "AI scheduling failed");
      publish("error");
    });
  }, delay);
  timer.unref?.();
}

export function requestAutoIndex(source: string): void {
  if (stopped) {
    return;
  }
  pending = true;
  firstRequest ||= Date.now();
  log.info({ source }, "AI index requested");
  if (held || active || fatal) {
    return;
  }
  publish("queued");
  schedule(Math.max(0, Math.min(1000, 5000 - (Date.now() - firstRequest))));
}

/** A deliberate per-photo retry can also recheck failed AI dependencies. */
export function requestAutoIndexPhotoRetry(photoId: number): void {
  ignoreActiveEmbeddingFailure(photoId);
  fatal = false;
  manualRetryRequested = Boolean(active);
  requestAutoIndex("manual-photo-retry");
}

async function drain(): Promise<void> {
  if (stopped || held || active || !pending || fatal) {
    return;
  }
  let reason: AutoIndexStatus["reason"];
  if (scanBusy()) {
    reason = "scan";
  } else if (getAiControlState() !== "idle" || isAiIndexResetting) {
    reason = "busy";
  } else if (!isModelLoaded) {
    reason = "model";
  } else if (!isVectorDBReady) {
    reason = "vector-db";
  }
  if (reason) {
    publish("blocked", reason);
    schedule(1000);
    return;
  }
  pending = false;
  firstRequest = 0;
  const db = getDatabase();
  const plan = planEmbeddingRetries(db, Date.now());
  failedPhotos = plan.failedPhotoCount;
  if (plan.hasWork) {
    publish("running");
  }
  automaticController = new AbortController();
  active = runAutomatic(db, plan, automaticController.signal);
  await active;
}

function scheduleNextRun(retryAt: number): void {
  if (stopped || held || fatal) {
    return;
  }
  if (pending) {
    schedule(0);
  } else if (Number.isFinite(retryAt)) {
    pending = true;
    schedule(Math.max(0, retryAt - Date.now()));
  }
}

function settleStatus(): void {
  if (held) {
    publish("paused");
  } else if (fatal) {
    publish("error");
  } else if (failedPhotos) {
    publish("error", "failed");
  } else {
    publish("idle");
  }
}

async function runAutomatic(
  db: ReturnType<typeof getDatabase>,
  plan: ReturnType<typeof planEmbeddingRetries>,
  signal: AbortSignal
): Promise<void> {
  const started = Date.now();
  const retired = () => signal.aborted || stopped || db !== getDatabase();
  let embeddingRetryAt = plan.retryAt ?? Number.POSITIVE_INFINITY;
  let faceRetryAt: number | undefined;
  try {
    if (plan.hasWork) {
      let completed = false;
      await embedAllPhotos(
        (progress) => {
          for (const win of BrowserWindow.getAllWindows()) {
            win.webContents.send("ai-progress", progress);
          }
        },
        {
          excludePhotoIds: plan.excludePhotoIds,
          onCompleted: (retryAt) => {
            completed = true;
            embeddingRetryAt = Math.min(
              embeddingRetryAt,
              retryAt ?? Number.POSITIVE_INFINITY
            );
          },
        }
      );
      if (retired()) {
        return;
      }
      if (
        !(completed || manualRetryRequested) &&
        getAiControlState() === "idle"
      ) {
        fatal = true;
        return;
      }
      failedPhotos = planEmbeddingRetries(db, Date.now()).failedPhotoCount;
    }
    if (!retired() && getAiControlState() === "idle") {
      const { refreshChangedPhotoFaces } = await import(
        "./library-face-refresh"
      );
      faceRetryAt = await refreshChangedPhotoFaces(signal);
    }
  } catch (error) {
    if (!retired()) {
      fatal = !manualRetryRequested;
      log.error({ error }, "Automatic AI indexing failed");
    }
  } finally {
    active = undefined;
    automaticController = undefined;
    manualRetryRequested = false;
    log.info(
      {
        elapsedMs: Date.now() - started,
        embedded: plan.hasWork,
        failed: failedPhotos,
      },
      "Automatic AI indexing settled"
    );
    if (!stopped && db === getDatabase()) {
      settleStatus();
      scheduleNextRun(
        Math.min(embeddingRetryAt, faceRetryAt ?? Number.POSITIVE_INFINITY)
      );
    }
  }
}

export function startAutoIndexScheduler(isScanning: () => boolean): void {
  stopped = false;
  held = getSetting(STOP_KEY) === "true";
  fatal = false;
  manualRetryRequested = false;
  failedPhotos = 0;
  scanBusy = isScanning;
  publish(held ? "paused" : "idle");
  requestAutoIndex("startup");
}

/** Called only by explicit user controls, never by shutdown. */
export function setAutoIndexStopped(value: boolean): void {
  setSetting(STOP_KEY, String(value));
  held = value;
  clearTimeout(timer);
  if (value) {
    automaticController?.abort();
    publish("paused");
  } else {
    fatal = false;
    requestAutoIndex("manual-resume");
  }
}

export function notifyAutoIndexReady(): void {
  fatal = false;
  requestAutoIndex("dependencies-ready");
}

export async function stopAutoIndexScheduler(): Promise<void> {
  stopped = true;
  automaticController?.abort();
  pending = false;
  firstRequest = 0;
  clearTimeout(timer);
  if (active) {
    pauseEmbedding();
  }
  await active;
}
