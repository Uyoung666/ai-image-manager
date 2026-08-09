import { eq, inArray } from "drizzle-orm";
import { BrowserWindow } from "electron";
import { getDatabase } from "@/db";
import { exifData, folders, photos, photoTags } from "@/db/schema";
import { invalidateCountCache } from "@/ipc/photos/handlers/listing";
import { invalidateIndexStatsCache } from "@/ipc/photos/handlers/stats";
import { getAiControlState } from "@/services/ai/state";
import { deletePhotoVectors, embedAllPhotos } from "@/services/ai-embedder";
import { reloadFolderMatcher } from "@/services/folder-matcher";
import {
  scanFolder as scanFolderService,
  stopScanning as stopScanningService,
  watchFolder,
} from "@/services/indexer";
import { deletePhotoThumbnails } from "@/services/thumbnailer";
import { importPathKey, normalizeImportFolderPath } from "@/utils/import-path";

// ── Types ──────────────────────────────────────────────────────────

export type ImportTaskStatus =
  | "queued"
  | "scanning"
  | "embedding"
  | "done"
  | "failed"
  | "cancelled";

export interface ImportTask {
  error?: string;
  folderPath: string;
  /** Unique id — timestamp of enqueue. */
  id: number;
  /** Number of photos newly indexed by this task. */
  newPhotoCount?: number;
  /** Result from scanFolderService, set once scanning completes. */
  photoCount?: number;
  /** 1-based position in queue (only meaningful while status === "queued"). */
  position: number;
  /** Number of supported files that could not be indexed. */
  skipped?: number;
  status: ImportTaskStatus;
}

export interface ImportQueueStatus {
  /** The task currently being processed, if any. */
  current: ImportTask | null;
  /** History — all completed / failed / cancelled tasks. */
  history: ImportTask[];
  pending: ImportTask[];
}

// ── State ───────────────────────────────────────────────────────────

const queue: ImportTask[] = [];
const history: ImportTask[] = [];
let current: ImportTask | null = null;
let running = false;
let nextId = 1;
let aiEmbeddingPending = false;
let aiEmbeddingRunning = false;

function broadcast(): void {
  const status: ImportQueueStatus = {
    pending: queue.map((t, i) => ({ ...t, position: i + 1 })),
    current: current ? { ...current } : null,
    history: history.slice(-20),
  };

  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("import-queue-status", status);
  }
}

function dequeueTask(): ImportTask | null {
  const task = queue.shift();
  if (!task) {
    return null;
  }
  for (let i = 0; i < queue.length; i++) {
    queue[i].position = i + 1;
  }
  return task;
}

// ── Cancel cleanup ──────────────────────────────────────────────────

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: Cancellation cleanup must remove photos, vectors, thumbnails, and folders in one lifecycle path.
function cleanupCancelledImport(
  folderId: number,
  newPhotoIds: number[],
  folderExisted: boolean,
  createdFolderIds: number[]
): void {
  const db = getDatabase();

  if (newPhotoIds.length > 0) {
    const records = db
      .select({ id: photos.id, path: photos.path })
      .from(photos)
      .where(inArray(photos.id, newPhotoIds))
      .all();

    db.transaction(() => {
      db.delete(exifData).where(inArray(exifData.photoId, newPhotoIds)).run();
      db.delete(photoTags).where(inArray(photoTags.photoId, newPhotoIds)).run();
      db.delete(photos).where(inArray(photos.id, newPhotoIds)).run();
    });

    for (const r of records) {
      deletePhotoThumbnails(r.path);
    }
    deletePhotoVectors(newPhotoIds).catch(() => {
      /* best-effort */
    });
  }

  if (!folderExisted) {
    const descendantIds: number[] = [];
    const visited = new Set<number>([folderId]);
    const bfsQueue = [folderId];

    while (bfsQueue.length > 0) {
      const cur = bfsQueue.shift();
      if (cur == null) {
        break;
      }
      const children = db
        .select({ id: folders.id })
        .from(folders)
        .where(eq(folders.parentId, cur))
        .all();
      for (const child of children) {
        if (visited.has(child.id)) {
          continue;
        }
        visited.add(child.id);
        descendantIds.push(child.id);
        bfsQueue.push(child.id);
      }
    }

    for (const fid of descendantIds) {
      db.delete(folders).where(eq(folders.id, fid)).run();
    }
    db.delete(folders).where(eq(folders.id, folderId)).run();
    reloadFolderMatcher();
  } else if (createdFolderIds.length > 0) {
    for (const fid of [...createdFolderIds].reverse()) {
      const hasPhotos = db
        .select({ id: photos.id })
        .from(photos)
        .where(eq(photos.folderId, fid))
        .get();
      if (!hasPhotos) {
        db.delete(folders).where(eq(folders.id, fid)).run();
      }
    }
    reloadFolderMatcher();
  }
}

// ── Phase runners ───────────────────────────────────────────────────

async function runScanPhase(task: ImportTask): Promise<boolean> {
  const result = await scanFolderService(task.folderPath, (progress) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("scan-progress", progress);
    }
  });

  if (result.cancelled) {
    cleanupCancelledImport(
      result.folderId,
      result.newPhotoIds,
      result.folderExisted,
      result.createdFolderIds
    );
    task.status = "cancelled";
    history.push(task);
    return false;
  }

  task.photoCount = result.photoIds.length;
  task.newPhotoCount = result.newPhotoIds.length;
  task.skipped = result.skipped;

  watchFolder(task.folderPath, (photoId, event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("file-change", { type: event, photoId });
    }
  });

  if (result.newPhotoIds.length > 0) {
    aiEmbeddingPending = true;
  }

  return true;
}

async function runEmbedPhase(): Promise<number> {
  try {
    return await embedAllPhotos((aiProgress) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send("ai-progress", aiProgress);
      }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[ImportQueue] AI embedding failed: ${message}`);
    return 0;
  } finally {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-embedding-done");
      win.webContents.send("ai-status-changed");
    }
  }
}

function runPendingAiEmbedding(): void {
  if (
    running ||
    current ||
    queue.length > 0 ||
    aiEmbeddingRunning ||
    !aiEmbeddingPending
  ) {
    return;
  }

  // A manual/repair embedding run may already own the worker. Keep this
  // import-triggered request pending and run it after that owner releases it.
  if (getAiControlState() !== "idle") {
    setTimeout(runPendingAiEmbedding, 1000);
    return;
  }

  aiEmbeddingPending = false;
  aiEmbeddingRunning = true;
  runEmbedPhase().then(() => {
    aiEmbeddingRunning = false;
    runPendingAiEmbedding();
  });
}

// ── Consumer ───────────────────────────────────────────────────────

async function processNext(): Promise<void> {
  if (running) {
    return;
  }

  const task = dequeueTask();
  if (!task) {
    running = false;
    current = null;
    broadcast();
    runPendingAiEmbedding();
    return;
  }

  running = true;
  task.status = "scanning";
  current = task;
  broadcast();

  try {
    const ok = await runScanPhase(task);
    if (!ok) {
      return;
    }
    task.status = "done";
    import("@/services/advanced-exif")
      .then(({ scheduleAdvancedExifEnrichment }) =>
        scheduleAdvancedExifEnrichment(1000)
      )
      .catch(() => undefined);
    history.push(task);
  } catch (err: unknown) {
    task.status = "failed";
    task.error = err instanceof Error ? err.message : String(err);
    history.push(task);
  } finally {
    // Flush IPC-level COUNT cache so the frontend sees accurate totals
    // immediately after import finishes — no stale counts from before
    // the task started.
    invalidateCountCache();
    invalidateIndexStatsCache();
    current = null;
    running = false;
    broadcast();
    processNext();
  }
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Enqueue a folder for import.
 * Returns immediately with the queued task — the frontend is unblocked.
 */
export function enqueueImport(folderPath: string): ImportTask {
  const resolved = normalizeImportFolderPath(folderPath);
  const resolvedKey = importPathKey(resolved);

  const duplicate = queue.find(
    (t) => importPathKey(t.folderPath) === resolvedKey
  );
  if (duplicate) {
    return duplicate;
  }
  if (
    current &&
    importPathKey(current.folderPath) === resolvedKey &&
    current.status === "scanning"
  ) {
    return current;
  }

  const task: ImportTask = {
    id: nextId++,
    folderPath: resolved,
    status: "queued",
    position: queue.length + 1,
  };

  queue.push(task);
  broadcast();

  if (!running) {
    // 延迟到下一 tick，确保 task 以 "queued" 状态返回给调用者
    setImmediate(() => processNext());
  }

  return task;
}

/** Cancel all queued (not-yet-started) tasks. The currently-running task is not affected. */
export function cancelQueuedImports(): ImportTask[] {
  const cancelled = queue.splice(0, queue.length);
  for (const t of cancelled) {
    t.status = "cancelled";
    history.push(t);
  }
  broadcast();
  return cancelled;
}

/** Cancel the currently-running task and clear the queue. */
export function cancelAllImports(): void {
  cancelQueuedImports();
  if (
    current &&
    (current.status === "scanning" || current.status === "embedding")
  ) {
    stopScanningService();
  }
}

/** Cancel only the currently scanning folder. Pending imports continue. */
export function cancelCurrentImport(): boolean {
  if (!current || current.status !== "scanning") {
    return false;
  }
  stopScanningService();
  return true;
}

/** Get the full queue snapshot. */
export function getImportQueueStatus(): ImportQueueStatus {
  return {
    pending: queue.map((t, i) => ({ ...t, position: i + 1 })),
    current: current ? { ...current } : null,
    history: history.slice(-20),
  };
}

/** Check whether a folder path is currently being imported or queued. */
export function isFolderImporting(folderPath: string): boolean {
  let resolved: string;
  try {
    resolved = normalizeImportFolderPath(folderPath);
  } catch {
    return false;
  }
  const resolvedKey = importPathKey(resolved);
  if (
    current &&
    importPathKey(current.folderPath) === resolvedKey &&
    (current.status === "queued" ||
      current.status === "scanning" ||
      current.status === "embedding")
  ) {
    return true;
  }
  return queue.some((t) => importPathKey(t.folderPath) === resolvedKey);
}
