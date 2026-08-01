export interface YuNetRawOutput {
  dims: number[];
  data: Float32Array;
}

export interface YuNetFace {
  x1: number;
  y1: number;
  w: number;
  h: number;
  score: number;
  landmarks: number[][];
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
  faces: Array<Pick<YuNetFace, "x1" | "y1" | "w" | "h" | "score">>,
  nmsThreshold: number,
  topK?: number
): number[];

/** decode + NMS; returns faces sorted by score desc. */
export function postProcessYuNet(
  outputs: Record<string, YuNetRawOutput>,
  inputSize: number,
  opts: { scoreThreshold: number; nmsThreshold: number; topK?: number }
): YuNetFace[];
