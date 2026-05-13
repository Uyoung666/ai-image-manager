// Public API — re-exports from split modules.
// Existing imports from "@/services/ai-embedder" can be changed to "@/services/ai".

export { embedAllPhotos } from "./embedder";
export type { AiHealthStatus, AiReadiness } from "./health";
export { checkAiHealth, getAiReadiness } from "./health";
export {
  ensureLocalModel,
  getEmbeddingProgress,
  isAiModelLoaded,
  loadModel,
  stopEmbedding,
} from "./model-loader";
export type { ParsedQuery, ScoringOptions } from "./query-parser";
export {
  extractTemporalContext,
  generateSearchPrompts,
  parseChineseQuery,
} from "./query-parser";
export { searchByImage, searchByText } from "./search";
export type { EmbedProgress, EmbedProgressCallback } from "./state";
export { batchSuggestTags, CANDIDATE_TAGS, suggestTags } from "./tag-suggester";
export { embedText } from "./text-embedder";
export {
  buildPhotoIdFilter,
  deletePhotoVectors,
  ensureVectorIndex,
  getPhotoVectors,
  initVectorDB,
  isVectorDBInitialized,
} from "./vector-db";
export type { DictCategory, DictEntry } from "./zh-en-dict";
export { CHAR_DECOMPOSE, ZH_TO_EN_SEARCH } from "./zh-en-dict";
