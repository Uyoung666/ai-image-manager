// Public API — re-exports from split modules.
// Existing imports from "@/services/ai-embedder" can be changed to "@/services/ai".

export { embedAllPhotos } from "./embedder";
export { checkAiHealth, getAiReadiness } from "./health";
export type { AiHealthStatus, AiReadiness } from "./health";
export {
  ensureLocalModel,
  getEmbeddingProgress,
  isAiModelLoaded,
  loadModel,
  stopEmbedding,
} from "./model-loader";
export { searchByImage, searchByText } from "./search";
export type { EmbedProgress, EmbedProgressCallback } from "./state";
export { batchSuggestTags, CANDIDATE_TAGS, suggestTags } from "./tag-suggester";
export { embedText } from "./text-embedder";
export {
  deletePhotoVectors,
  getPhotoVectors,
  initVectorDB,
  isVectorDBInitialized,
} from "./vector-db";
export { ZH_TO_EN_SEARCH } from "./zh-en-dict";
