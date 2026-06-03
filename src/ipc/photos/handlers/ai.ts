import { os } from "@orpc/server";
import { eq } from "drizzle-orm";
import { getDatabase } from "@/db";
import { photos } from "@/db/schema";
import {
  batchSuggestTags,
  checkAiHealth,
  embedAllPhotos,
  getAiReadiness,
  getEmbeddingProgress,
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

export const getAiProgress = os.handler(() => {
  return getEmbeddingProgress();
});

export const getAiStatus = os.handler(async () => {
  return getAiReadiness();
});

export const getAiHealth = os.handler(async () => {
  return checkAiHealth();
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
