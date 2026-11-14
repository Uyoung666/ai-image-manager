import { eq } from "drizzle-orm";
import { powerMonitor } from "electron";
import { getDatabase } from "@/db";
import { folders } from "@/db/schema";
import { selectLibraryRoots } from "@/utils/library-roots";
import { createLogger } from "@/utils/logger";
import { waitForEmbeddingTasks } from "./ai/embedder";
import { pauseEmbedding } from "./ai/model-loader";
import {
  activeEmbeddingRunId,
  clearWrittenPhotoIdsForRun,
  drainPendingAutoTagPhotoIds,
  finishEmbeddingRun,
  setAiControlState,
  setCurrentProgress,
} from "./ai/state";
import {
  startAutoIndexScheduler,
  stopAutoIndexScheduler,
} from "./ai-index-scheduler";
import { enqueueImport, isImportQueueBusy, stopImports } from "./import-queue";
import {
  isIndexing,
  setWatcherReconciliationCallback,
  startWatching,
  stopWatching,
} from "./indexer";
import { notifyLibraryChange } from "./library-change";
import {
  observeLibraryPhoto,
  startLibraryContentRefresh,
  stopLibraryContentRefresh,
} from "./library-content-refresh";
import {
  isLibraryForegroundBusy,
  waitForLibraryForegroundIdle,
} from "./library-foreground";
import {
  startLibraryHashBackfill,
  stopLibraryHashBackfill,
} from "./library-moves";
import { reconcileLibrarySources } from "./library-source";

const log = createLogger("library-reconciliation");
const RECONCILIATION_DELAY_MS = 1000;
// Give initial previews I/O capacity while watchers and offline-root checks start.
const STARTUP_RECONCILIATION_DELAY_MS = 3000;
let stopped = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let checking: ReturnType<typeof setTimeout> | undefined;
let startupScheduledAt: number | undefined;
let explicitCheck: Promise<void> | undefined;
let explicitController: AbortController | undefined;

function checkExplicitSources(): void {
  if (explicitCheck) {
    return;
  }
  const controller = new AbortController();
  explicitController = controller;
  explicitCheck = (async () => {
    if (
      !(await waitForLibraryForegroundIdle(
        () => !(stopped || controller.signal.aborted),
        controller.signal
      ))
    ) {
      return;
    }
    let changed = false;
    const summary = await reconcileLibrarySources({
      explicitOnly: true,
      signal: controller.signal,
      onAvailable: async (photo) => {
        if (await observeLibraryPhoto(photo.id, photo.path)) {
          changed = true;
        }
      },
    });
    if (!stopped && (changed || summary.changed)) {
      notifyLibraryChange(null, changed ? "update" : "status");
    }
  })()
    .catch((error: unknown) => {
      log.warn({ error }, "Library source check failed");
    })
    .finally(() => {
      explicitCheck = undefined;
      explicitController = undefined;
    });
}

function enqueueRoots(startupStartedAt?: number): void {
  if (stopped) {
    return;
  }
  const roots = selectLibraryRoots(
    getDatabase()
      .select({ path: folders.path })
      .from(folders)
      .where(eq(folders.explicitOnly, false))
      .all()
  );
  for (const root of roots) {
    try {
      enqueueImport(root.path, "background");
    } catch (error) {
      log.warn(
        { error, folderPath: root.path },
        "Library root unavailable; deferred until next check"
      );
    }
  }
  log.info(
    {
      roots: roots.length,
      ...(startupStartedAt === undefined
        ? {}
        : { startupToEnqueueMs: performance.now() - startupStartedAt }),
    },
    "Library reconciliation queued"
  );
  checkExplicitSources();
  waitForRound();
}

function waitForRound(): void {
  clearTimeout(timer);
  timer = setTimeout(() => {
    if (stopped) {
      return;
    }
    if (isImportQueueBusy() || isIndexing()) {
      waitForRound();
      return;
    }
    timer = setTimeout(
      () => {
        restartWatches();
        enqueueRoots();
      },
      (45 + Math.random() * 30) * 60_000
    );
    timer.unref?.();
  }, 1000);
  timer.unref?.();
}

function restartWatches(): void {
  startWatching(notifyLibraryChange);
}

function resume(): void {
  // Keep the startup deadline bounded even if watcher readiness keeps arriving.
  if (stopped || (startupScheduledAt !== undefined && checking)) {
    return;
  }
  clearTimeout(checking);
  checking = setTimeout(
    () => {
      checking = undefined;
      const startupStartedAt = startupScheduledAt;
      startupScheduledAt = undefined;
      restartWatches();
      enqueueRoots(startupStartedAt);
    },
    startupScheduledAt === undefined
      ? RECONCILIATION_DELAY_MS
      : STARTUP_RECONCILIATION_DELAY_MS
  );
  checking.unref?.();
}

export function startLibraryReconciliation(): void {
  stopped = false;
  startupScheduledAt = performance.now();
  const isBusy = () =>
    isLibraryForegroundBusy() || isImportQueueBusy() || isIndexing();
  startAutoIndexScheduler(isBusy);
  startLibraryContentRefresh();
  startLibraryHashBackfill(() => startupScheduledAt !== undefined || isBusy());
  setWatcherReconciliationCallback(resume);
  powerMonitor.on("resume", resume);
  // The shared check also covers roots whose watcher never becomes ready.
  resume();
  restartWatches();
}

export async function stopLibraryReconciliation(): Promise<void> {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(checking);
  checking = undefined;
  startupScheduledAt = undefined;
  explicitController?.abort();
  powerMonitor.removeListener("resume", resume);
  setWatcherReconciliationCallback();
  pauseEmbedding();
  const aiStop = stopAutoIndexScheduler();
  await stopImports();
  await stopWatching();
  await explicitCheck;
  await stopLibraryHashBackfill();
  await stopLibraryContentRefresh();
  await aiStop;
  await waitForEmbeddingTasks();
  if (activeEmbeddingRunId > 0) {
    clearWrittenPhotoIdsForRun(activeEmbeddingRunId);
    finishEmbeddingRun(activeEmbeddingRunId, "idle");
  }
  drainPendingAutoTagPhotoIds();
  setAiControlState("idle");
  setCurrentProgress({
    phase: "idle",
    processed: 0,
    total: 0,
    currentFile: "",
  });
}
