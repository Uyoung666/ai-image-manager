import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import {
  activeEmbeddingRunId,
  aiControlState,
  batchSuggestTags,
  cancelEmbedding,
  checkAiHealth,
  cleanupPartialEmbedding,
  embedAllPhotos,
  finishEmbeddingRun,
  getAiReadiness,
  getEmbeddingProgress,
  isAutoTaggingActive,
  pauseEmbedding,
  rebuildVectorDB,
  resetAllAiProcessedFlags,
  resumeEmbedding,
  setAiControlState,
  setCurrentProgress,
  setWasAutoRepaired,
  stopEmbedding,
} from "@/services/ai-embedder";

export const startAiIndexing = os.handler(() => {
  if (aiControlState !== "idle") {
    return { busy: true, started: false, state: aiControlState };
  }
  embedAllPhotos((aiProgress) => {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", aiProgress);
    }
  })
    .then((count) => {
      console.log(`[AI] Embedding complete: ${count} photos processed`);
    })
    .catch((err) => {
      console.error("[AI] Embedding error:", err);
    });
  return { started: true };
});

export const stopAiIndexing = os.handler(() => {
  stopEmbedding();
  return { stopped: true };
});

export const cancelAiIndexing = os.handler(async () => {
  const runId = activeEmbeddingRunId;
  const stateBeforeCancel = aiControlState;
  cancelEmbedding();
  // Clean up any partially embedded data from the current session.
  // This covers both the case where embedAllPhotos is still running
  // (cancel flag will trigger cleanup inside the loop) and the case
  // where it was already paused (cleanup must happen here explicitly).
  await cleanupPartialEmbedding(runId);
  if (stateBeforeCancel === "paused" || stateBeforeCancel === "idle") {
    // No embedAllPhotos loop is still alive to settle this run.
    setCurrentProgress({
      processed: 0,
      total: 0,
      phase: "idle",
      currentFile: "",
      downloadPercent: undefined,
    });
    if (runId > 0) {
      finishEmbeddingRun(runId, "idle");
    } else {
      setAiControlState("idle");
    }
  }
  return { cancelled: true };
});

export const pauseAiIndexing = os.handler(() => {
  pauseEmbedding();
  return { paused: true };
});

export const resumeAiIndexing = os.handler(() => {
  if (!resumeEmbedding()) {
    return { resumed: false, state: aiControlState };
  }
  // Fire-and-forget: restart embedding
  embedAllPhotos((aiProgress) => {
    const { BrowserWindow } = require("electron");
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", aiProgress);
    }
  })
    .then((count) => {
      console.log(`[AI] Resume embedding complete: ${count} photos processed`);
    })
    .catch((err) => {
      console.error("[AI] Resume embedding error:", err);
    });
  return { resumed: true };
});

export const getAiProgress = os.handler(() => {
  return getEmbeddingProgress();
});

export const getAiStatus = os.handler(() => {
  return getAiReadiness();
});

export const getAiHealth = os.handler(() => {
  return checkAiHealth();
});

/**
 * 重建向量数据库并重置所有 AI 索引标志。
 * 用于修复 LanceDB 索引损坏导致的搜索闪退问题。
 * 调用方应随后调用 startAiIndexing 以自动重新索引。
 */
export const resetAiIndex = os.handler(async () => {
  if (aiControlState !== "idle" || isAutoTaggingActive()) {
    return {
      busy: true,
      success: false,
    };
  }
  const rebuildResult = await rebuildVectorDB();
  if (!rebuildResult.success) {
    return {
      success: false,
      error: rebuildResult.error ?? "Failed to rebuild vector database",
    };
  }

  const resetCount = resetAllAiProcessedFlags();
  setWasAutoRepaired(true);

  const { BrowserWindow } = require("electron");
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("ai-status-changed");
  }

  console.log(
    `[AI] Index reset: vector DB rebuilt, ${resetCount} isAiProcessedFlags cleared`
  );
  return { success: true };
});

export const batchGenerateTags = os.handler(async () => {
  if (aiControlState !== "idle" || isAutoTaggingActive()) {
    return { busy: true, skipped: 0, tagged: 0, total: 0 };
  }
  const db = getDatabase();
  const indexed = db
    .select({ id: photos.id })
    .from(photos)
    .where(eq(photos.isAiProcessed, true))
    .all()
    .map((p) => p.id);

  if (indexed.length === 0) {
    return { tagged: 0, skipped: 0, total: 0 };
  }

  const { BrowserWindow } = require("electron");
  const broadcastProgress = () => {
    const progress = getEmbeddingProgress();
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-progress", progress);
    }
  };
  setCurrentProgress({
    processed: 0,
    total: indexed.length,
    phase: "tagging",
    currentFile: "",
  });
  broadcastProgress();
  try {
    const result = await batchSuggestTags(
      indexed,
      (processed, total, photoId) => {
        setCurrentProgress({
          processed,
          total,
          phase: "tagging",
          currentFile: String(photoId),
        });
        broadcastProgress();
      }
    );
    setCurrentProgress({
      processed: indexed.length,
      total: indexed.length,
      phase: "complete",
      currentFile: "",
    });
    broadcastProgress();
    return { ...result, total: indexed.length };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setCurrentProgress({
      processed: getEmbeddingProgress().processed,
      total: indexed.length,
      phase: "tag-error",
      currentFile: "",
      error: message,
    });
    broadcastProgress();
    throw error;
  } finally {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send("ai-tags-done");
    }
  }
});
