// Shared mutable state across AI sub-modules.
// Centralised here so that split modules can read/write the same singletons.

export interface EmbedProgress {
  currentFile: string;
  downloadPercent?: number;
  error?: string;
  loadingStartedAt?: number | null;
  phase: "idle" | "loading" | "embedding" | "complete" | "error" | "repairing";
  processed: number;
  /** 非空时表示这是一次自动修复引起的重新索引，值为修复原因 */
  repairReason?: string;
  total: number;
}

export type EmbedProgressCallback = (progress: EmbedProgress) => void;

export interface EmbeddingModel {
  embedImage: (imagePath: string) => Promise<number[]>;
  embedText: (text: string) => Promise<number[]>;
}

export let vectordb: any = null;
export let photoTable: any = null;
export let isModelLoaded = false;
export let isVectorDBReady = false;
export let embeddingModel: EmbeddingModel | null = null;
export let isEmbedding = false;
export let poolCancelled = false;
export let isPaused = false;
/** 本次嵌入会话中已成功写入的 photo_id 集合，用于取消时精确回滚 */
export let writtenPhotoIds: Set<number> = new Set();
/** 全局 AbortController，用于跨模块传递取消信号 */
export let abortController: AbortController | null = null;
/** 向量数据库是否在本次启动中由自动修复流程重建过 */
export let wasAutoRepaired = false;
export let currentProgress: EmbedProgress = {
  processed: 0,
  total: 0,
  phase: "idle",
  currentFile: "",
};
export let _localModelPath: string | null = null;

export function setVectordb(v: any): void {
  vectordb = v;
}
export function setPhotoTable(t: any): void {
  photoTable = t;
}
export function setIsModelLoaded(v: boolean): void {
  isModelLoaded = v;
}
export function setIsVectorDBReady(v: boolean): void {
  isVectorDBReady = v;
}
export function setEmbeddingModel(m: EmbeddingModel | null): void {
  embeddingModel = m;
}
export function setIsEmbedding(v: boolean): void {
  isEmbedding = v;
}
export function setPoolCancelled(v: boolean): void {
  poolCancelled = v;
}
export function setIsPaused(v: boolean): void {
  isPaused = v;
}
export function setWrittenPhotoIds(ids: Set<number>): void {
  writtenPhotoIds = ids;
}
export function addWrittenPhotoId(id: number): void {
  writtenPhotoIds.add(id);
}
export function addWrittenPhotoIds(ids: number[]): void {
  for (const id of ids) {
    writtenPhotoIds.add(id);
  }
}
export function getWrittenPhotoIds(): Set<number> {
  return writtenPhotoIds;
}
export function setAbortController(c: AbortController | null): void {
  abortController = c;
}
export function getAbortController(): AbortController | null {
  return abortController;
}
export function setWasAutoRepaired(v: boolean): void {
  wasAutoRepaired = v;
}
export function setCurrentProgress(p: EmbedProgress): void {
  currentProgress = p;
}
export function setLocalModelPath(p: string | null): void {
  _localModelPath = p;
}
