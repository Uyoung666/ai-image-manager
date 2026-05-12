import { os } from "@orpc/server";
import {
  checkAiHealth,
  embedAllPhotos,
  getAiReadiness,
  getEmbeddingProgress,
  stopEmbedding,
} from "@/services/ai-embedder";

export const startAiIndexing = os.handler(() => {
  // Fire-and-forget: launch embedding in background, poll progress via getAiProgress
  embedAllPhotos()
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
