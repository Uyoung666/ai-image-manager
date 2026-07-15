// Public API — re-exports from split modules.
// Existing imports from "@/services/ai-embedder" can be changed to "@/services/ai".

export { cleanupPartialEmbedding, embedAllPhotos } from "./embedder";
export type { AiHealthStatus, AiReadiness } from "./health";
export { checkAiHealth, getAiReadiness } from "./health";
export {
  cancelEmbedding,
  copyModelsOnce,
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
export {
  isAiSearchReady,
  searchByImage,
  searchByText,
  warmupAiSearch,
} from "./search";
export type { EmbedProgress, EmbedProgressCallback } from "./state";
export {
  activeEmbeddingRunId,
  addPendingAutoTagPhotoIds,
  addWrittenPhotoId,
  addWrittenPhotoIds,
  addWrittenPhotoIdsForRun,
  aiControlState,
  beginAutoTagging,
  beginEmbeddingRun,
  clearWrittenPhotoIdsForRun,
  colorTable,
  drainPendingAutoTagPhotoIds,
  finishAutoTagging,
  finishAutoTaggingPhoto,
  finishEmbeddingRun,
  getAiControlState,
  getPendingAutoTagPhotoIds,
  getWrittenPhotoIds,
  getWrittenPhotoIdsForRun,
  isAutoTaggingActive,
  isAutoTaggingPhoto,
  isCurrentEmbeddingRun,
  isPaused,
  isRunWritable,
  poolCancelled,
  removePendingAutoTagPhotoIds,
  setAiControlState,
  setColorTable,
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
  backfillColorVectors,
  buildPhotoIdFilter,
  cleanupOrphanVectors,
  cleanupStaleBackups,
  closeVectorDB,
  deleteColorVectors,
  deletePhotoVectors,
  ensureVectorIndex,
  getPhotoVectors,
  initVectorDB,
  isVectorDBInitialized,
  rebuildVectorDB,
  resetAllAiProcessedFlags,
  searchByColorVector,
  upsertColorVector,
  upsertColorVectors,
  validateVectorDB,
} from "./vector-db";
export type { DictCategory, DictEntry } from "./zh-en-dict";
export { CHAR_DECOMPOSE, ZH_TO_EN_SEARCH } from "./zh-en-dict";
