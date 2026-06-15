// Public API — re-exports from split modules.
// Existing imports from "@/services/ai-embedder" can be changed to "@/services/ai".

export { cleanupPartialEmbedding, embedAllPhotos } from "./embedder";
export type { AiHealthStatus, AiReadiness } from "./health";
export { checkAiHealth, getAiReadiness } from "./health";
export {
  cancelEmbedding,
  ensureLocalModel,
  getEmbeddingProgress,
  isAiModelLoaded,
  loadModel,
  pauseEmbedding,
  resumeEmbedding,
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
export {
  addWrittenPhotoId,
  addWrittenPhotoIds,
  getWrittenPhotoIds,
  isPaused,
  poolCancelled,
  setCurrentProgress,
  setEmbeddingModel,
  setIsEmbedding,
  setIsModelLoaded,
  setLocalModelPath,
  setPoolCancelled,
  setWasAutoRepaired,
  wasAutoRepaired,
} from "./state";
export { batchSuggestTags, CANDIDATE_TAGS, suggestTags } from "./tag-suggester";
export { embedText } from "./text-embedder";
export {
  buildPhotoIdFilter,
  cleanupOrphanVectors,
  cleanupStaleBackups,
  closeVectorDB,
  deletePhotoVectors,
  ensureVectorIndex,
  getPhotoVectors,
  initVectorDB,
  isVectorDBInitialized,
  rebuildVectorDB,
  resetAllAiProcessedFlags,
  validateVectorDB,
} from "./vector-db";
export type { DictCategory, DictEntry } from "./zh-en-dict";
export { CHAR_DECOMPOSE, ZH_TO_EN_SEARCH } from "./zh-en-dict";
