import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import {
  batchSuggestTags,
  cancelEmbedding,
  checkAiHealth,
  cleanupPartialEmbedding,
  embedAllPhotos,
  getAiReadiness,
  getEmbeddingProgress,
  pauseEmbedding,
  rebuildVectorDB,
  resetAllAiProcessedFlags,
  resumeEmbedding,
  setCurrentProgress,
  setIsEmbedding,
  setWasAutoRepaired,
  stopEmbedding,
} from "@/services/ai-embedder";

export const startAiIndexing = os.handler(() => {
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
  cancelEmbedding();
  // Clean up any partially embedded data from the current session.
  // This covers both the case where embedAllPhotos is still running
  // (cancel flag will trigger cleanup inside the loop) and the case
  // where it was already paused (cleanup must happen here explicitly).
  await cleanupPartialEmbedding();
  // Reset progress to idle so the UI shows the start button again.
  setCurrentProgress({
    processed: 0,
    total: 0,
    phase: "idle",
    currentFile: "",
    downloadPercent: undefined,
  });
  setIsEmbedding(false);
  return { cancelled: true };
});

export const pauseAiIndexing = os.handler(() => {
  pauseEmbedding();
  return { paused: true };
});

export const resumeAiIndexing = os.handler(() => {
  resumeEmbedding();
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

export const getAiStatus = os.handler(async () => {
  return getAiReadiness();
});

export const getAiHealth = os.handler(async () => {
  return checkAiHealth();
});

/**
 * 重建向量数据库并重置所有 AI 索引标志。
 * 用于修复 LanceDB 索引损坏导致的搜索闪退问题。
 * 调用方应随后调用 startAiIndexing 以自动重新索引。
 */
export const resetAiIndex = os.handler(async () => {
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

  const result = await batchSuggestTags(indexed);
  return { ...result, total: indexed.length };
});
