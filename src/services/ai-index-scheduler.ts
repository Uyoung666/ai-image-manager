import { and, eq, isNull } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import { createLogger } from "@/utils/logger";
import { embedAllPhotos } from "./ai/embedder";
import { pauseEmbedding } from "./ai/model-loader";
import {
  currentProgress,
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
let scanBusy: () => boolean = () => false;
const failedIds = new Set<number>();
let fatal = false;
let status: AutoIndexStatus = { state: "idle", failedPhotos: 0 };

function publish(
  state: AutoIndexStatus["state"],
  reason?: AutoIndexStatus["reason"]
) {
  const next = { state, reason, failedPhotos: failedIds.size };
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

function pendingRows() {
  return getDatabase()
    .select({ id: photos.id })
    .from(photos)
    .where(and(eq(photos.isAiProcessed, false), isNull(photos.deletedAt)))
    .all();
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
  const started = Date.now();
  const attempted = pendingRows().filter((row) => !failedIds.has(row.id));
  if (attempted.length === 0) {
    publish(
      failedIds.size ? "error" : "idle",
      failedIds.size ? "failed" : undefined
    );
    return;
  }
  publish("running");
  active = runAutomatic(attempted, started);
  await active;
}

function settleStatus(): void {
  if (held) {
    publish("paused");
  } else if (fatal) {
    publish("error");
  } else if (failedIds.size) {
    publish("error", "failed");
  } else {
    publish("idle");
  }
}

async function runAutomatic(
  attempted: { id: number }[],
  started: number
): Promise<void> {
  try {
    await embedAllPhotos(
      (progress) => {
        for (const win of BrowserWindow.getAllWindows()) {
          win.webContents.send("ai-progress", progress);
        }
      },
      { excludePhotoIds: new Set(failedIds) }
    );
    if (!(held || stopped) && getAiControlState() === "idle") {
      recordFailures(attempted);
    }
  } catch (error) {
    fatal = true;
    log.error({ error }, "Automatic AI indexing failed");
  } finally {
    active = undefined;
    log.info(
      {
        elapsedMs: Date.now() - started,
        attempted: attempted.length,
        failed: failedIds.size,
      },
      "Automatic AI indexing settled"
    );
    settleStatus();
    if (pending && !stopped && !held && !fatal) {
      schedule(0);
    }
  }
}

function recordFailures(attempted: { id: number }[]): void {
  fatal =
    currentProgress.phase === "error" &&
    !currentProgress.failureSummary?.failed;
  if (fatal) {
    return;
  }
  const remaining = new Set(pendingRows().map((row) => row.id));
  for (const row of attempted) {
    if (remaining.has(row.id)) {
      failedIds.add(row.id);
    }
  }
}

export function startAutoIndexScheduler(isScanning: () => boolean): void {
  stopped = false;
  held = getSetting(STOP_KEY) === "true";
  fatal = false;
  failedIds.clear();
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
    publish("paused");
  } else {
    fatal = false;
    failedIds.clear();
    requestAutoIndex("manual-resume");
  }
}

export function notifyAutoIndexReady(): void {
  fatal = false;
  requestAutoIndex("dependencies-ready");
}

export async function stopAutoIndexScheduler(): Promise<void> {
  stopped = true;
  pending = false;
  firstRequest = 0;
  clearTimeout(timer);
  if (active) {
    pauseEmbedding();
  }
  await active;
}
