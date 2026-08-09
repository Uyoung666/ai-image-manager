export interface YuNetRawOutput {
  data: Float32Array;
  dims: number[];
}

export interface YuNetFace {
  h: number;
  landmarks: number[][];
  score: number;
  w: number;
  x1: number;
  y1: number;
}

export const YUNET_STRIDES: number[];

/** Decode raw YuNet FPN outputs into candidate faces (pre-NMS). */
export function decodeYuNet(
  outputs: Record<string, YuNetRawOutput>,
  inputSize: number,
  scoreThreshold: number
): YuNetFace[];

/** Greedy NMS over candidate faces; returns kept indices sorted by score. */
export function nmsBoxes(
  faces: Pick<YuNetFace, "x1" | "y1" | "w" | "h" | "score">[],
  nmsThreshold: number,
  topK?: number
): number[];

/** decode + NMS; returns faces sorted by score desc. */
export function postProcessYuNet(
  outputs: Record<string, YuNetRawOutput>,
  inputSize: number,
  opts: { scoreThreshold: number; nmsThreshold: number; topK?: number }
): YuNetFace[];
