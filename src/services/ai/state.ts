// Shared mutable state across AI sub-modules.
// Centralised here so that split modules can read/write the same singletons.

import type {
  Connection as LanceConnection,
  Table as LanceTable,
} from "@lancedb/lancedb";
import type { VectorCompatibility } from "./model-fingerprint";
import type { CalibrationStatus } from "./threshold-profile";

export interface ActiveEmbeddingRuntime {
  adapterId: string;
  calibrationStatus: CalibrationStatus;
  dimensions: number;
  displayName: string;
  fingerprint: string;
  modelId: string;
  revision: string;
  thresholdProfileId: string;
  vectorCompatibility: VectorCompatibility;
}

export interface EmbedProgress {
  currentFile: string;
  downloadPercent?: number;
  error?: string;
  loadingStartedAt?: number | null;
  phase:
    | "idle"
    | "loading"
    | "embedding"
    | "tagging"
    | "complete"
    | "error"
    | "tag-error"
    | "repairing";
  processed: number;
  /** 非空时表示这是一次自动修复引起的重新索引，值为修复原因 */
  repairReason?: string;
  total: number;
}

export type EmbedProgressCallback = (progress: EmbedProgress) => void;

export type AiControlState =
  | "idle"
  | "running"
  | "pausing"
  | "paused"
  | "cancelling";

export interface EmbeddingModel {
  embedImage: (imagePath: string) => Promise<number[]>;
  embedText: (text: string) => Promise<number[]>;
  embedTexts?: (texts: string[]) => Promise<number[][]>;
}

export let vectordb: LanceConnection | null = null;
export let photoTable: LanceTable | null = null;
/** LanceDB 颜色向量表（3D RGB），用于替代 SQLite closest_color_dist JS UDF */
export let colorTable: LanceTable | null = null;
export let isModelLoaded = false;
export let isVectorDBReady = false;
export let embeddingModel: EmbeddingModel | null = null;
export let isEmbedding = false;
export let poolCancelled = false;
export let isPaused = false;
export let aiControlState: AiControlState = "idle";
export let activeEmbeddingRunId = 0;
let nextEmbeddingRunId = 0;
/** 本次嵌入会话中已成功写入的 photo_id 集合，用于取消时精确回滚 */
export let writtenPhotoIds: Set<number> = new Set();
const writtenPhotoIdsByRun = new Map<number, Set<number>>();
const pendingAutoTagPhotoIds = new Set<number>();
const activeAutoTagPhotoIds = new Set<number>();
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
let activeEmbeddingRuntime: ActiveEmbeddingRuntime | null = null;

export function setVectordb(v: LanceConnection | null): void {
  vectordb = v;
}
export function setPhotoTable(t: LanceTable | null): void {
  photoTable = t;
}
export function setColorTable(t: LanceTable | null): void {
  colorTable = t;
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
export function setAiControlState(v: AiControlState): void {
  aiControlState = v;
  isEmbedding = v === "running" || v === "pausing" || v === "cancelling";
  isPaused = v === "paused" || v === "pausing";
  poolCancelled = v === "pausing" || v === "paused" || v === "cancelling";
}
export function getAiControlState(): AiControlState {
  return aiControlState;
}
export function beginEmbeddingRun(): number {
  const runId = ++nextEmbeddingRunId;
  activeEmbeddingRunId = runId;
  writtenPhotoIds = new Set();
  writtenPhotoIdsByRun.set(runId, writtenPhotoIds);
  setAiControlState("running");
  poolCancelled = false;
  isPaused = false;
  isEmbedding = true;
  return runId;
}
export function isCurrentEmbeddingRun(runId: number): boolean {
  return activeEmbeddingRunId === runId;
}
export function isRunWritable(runId: number): boolean {
  return (
    activeEmbeddingRunId === runId &&
    aiControlState !== "cancelling" &&
    aiControlState !== "paused"
  );
}
export function finishEmbeddingRun(
  runId: number,
  nextState: AiControlState
): boolean {
  if (activeEmbeddingRunId !== runId) {
    return false;
  }
  setAiControlState(nextState);
  if (nextState === "idle") {
    activeEmbeddingRunId = 0;
  }
  return true;
}
export function setWrittenPhotoIds(ids: Set<number>): void {
  writtenPhotoIds = ids;
  if (activeEmbeddingRunId > 0) {
    writtenPhotoIdsByRun.set(activeEmbeddingRunId, ids);
  }
}
export function addWrittenPhotoId(id: number): void {
  writtenPhotoIds.add(id);
  if (activeEmbeddingRunId > 0) {
    addWrittenPhotoIdsForRun(activeEmbeddingRunId, [id]);
  }
}
export function addWrittenPhotoIds(ids: number[]): void {
  for (const id of ids) {
    writtenPhotoIds.add(id);
  }
  if (activeEmbeddingRunId > 0) {
    addWrittenPhotoIdsForRun(activeEmbeddingRunId, ids);
  }
}
export function getWrittenPhotoIds(): Set<number> {
  return writtenPhotoIds;
}
export function addWrittenPhotoIdsForRun(runId: number, ids: number[]): void {
  let runIds = writtenPhotoIdsByRun.get(runId);
  if (!runIds) {
    runIds = new Set();
    writtenPhotoIdsByRun.set(runId, runIds);
  }
  for (const id of ids) {
    runIds.add(id);
  }
  if (activeEmbeddingRunId === runId) {
    writtenPhotoIds = runIds;
  }
}
export function getWrittenPhotoIdsForRun(runId: number): Set<number> {
  return writtenPhotoIdsByRun.get(runId) ?? new Set();
}
export function clearWrittenPhotoIdsForRun(runId: number): void {
  writtenPhotoIdsByRun.delete(runId);
  if (activeEmbeddingRunId === runId || activeEmbeddingRunId === 0) {
    writtenPhotoIds = new Set();
  }
}
export function addPendingAutoTagPhotoIds(ids: number[]): void {
  for (const id of ids) {
    pendingAutoTagPhotoIds.add(id);
  }
}
export function removePendingAutoTagPhotoIds(ids: Iterable<number>): void {
  for (const id of ids) {
    pendingAutoTagPhotoIds.delete(id);
  }
}
export function drainPendingAutoTagPhotoIds(): number[] {
  const ids = [...pendingAutoTagPhotoIds];
  pendingAutoTagPhotoIds.clear();
  return ids;
}
export function getPendingAutoTagPhotoIds(): Set<number> {
  return new Set(pendingAutoTagPhotoIds);
}

export function beginAutoTagging(ids: number[]): void {
  for (const id of ids) {
    activeAutoTagPhotoIds.add(id);
  }
}

export function finishAutoTaggingPhoto(id: number): void {
  activeAutoTagPhotoIds.delete(id);
}

export function finishAutoTagging(ids: number[]): void {
  for (const id of ids) {
    activeAutoTagPhotoIds.delete(id);
  }
}

export function isAutoTaggingPhoto(id: number): boolean {
  return activeAutoTagPhotoIds.has(id);
}

export function isAutoTaggingActive(): boolean {
  return activeAutoTagPhotoIds.size > 0;
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

export function setActiveEmbeddingRuntime(
  runtime: ActiveEmbeddingRuntime
): void {
  activeEmbeddingRuntime = runtime;
}

export function getActiveEmbeddingRuntime(): ActiveEmbeddingRuntime | null {
  return activeEmbeddingRuntime;
}

export function setVectorCompatibility(
  compatibility: VectorCompatibility
): void {
  if (activeEmbeddingRuntime) {
    activeEmbeddingRuntime = {
      ...activeEmbeddingRuntime,
      vectorCompatibility: compatibility,
    };
  }
}
