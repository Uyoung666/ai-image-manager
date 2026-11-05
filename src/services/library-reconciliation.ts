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

const log = createLogger("library-reconciliation");
let stopped = true;
let timer: ReturnType<typeof setTimeout> | undefined;
let checking: ReturnType<typeof setTimeout> | undefined;

function enqueueRoots(): void {
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
  log.info({ roots: roots.length }, "Library reconciliation queued");
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
  if (stopped) {
    return;
  }
  clearTimeout(checking);
  checking = setTimeout(() => {
    restartWatches();
    enqueueRoots();
  }, 1000);
  checking.unref?.();
}

export function startLibraryReconciliation(): void {
  stopped = false;
  startAutoIndexScheduler(() => isImportQueueBusy() || isIndexing());
  setWatcherReconciliationCallback(resume);
  powerMonitor.on("resume", resume);
  restartWatches();
  // Also reconcile roots whose watcher cannot reach ready.
  enqueueRoots();
}

export async function stopLibraryReconciliation(): Promise<void> {
  stopped = true;
  clearTimeout(timer);
  clearTimeout(checking);
  powerMonitor.removeListener("resume", resume);
  setWatcherReconciliationCallback();
  pauseEmbedding();
  const aiStop = stopAutoIndexScheduler();
  await stopImports();
  await stopWatching();
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
