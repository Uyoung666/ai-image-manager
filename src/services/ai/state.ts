// Shared mutable state across AI sub-modules.
// Centralised here so that split modules can read/write the same singletons.

export interface EmbedProgress {
  currentFile: string;
  downloadPercent?: number;
  error?: string;
  loadingStartedAt?: number | null;
  phase: "idle" | "loading" | "embedding" | "complete" | "error";
  processed: number;
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
export function setCurrentProgress(p: EmbedProgress): void {
  currentProgress = p;
}
export function setLocalModelPath(p: string | null): void {
  _localModelPath = p;
}
