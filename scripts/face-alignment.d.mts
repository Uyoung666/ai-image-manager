export type Affine2x3 = {
  a: number;
  b: number;
  c: number;
  d: number;
  tx: number;
  ty: number;
};

/** ArcFace-standard 5-point target landmarks for a 112x112 aligned crop. */
export const ARCFACE_TARGET_POINTS: number[][];

/** 2x2 SVD: M = u * diag(s) * vt. */
export function svd2x2(
  m00: number,
  m01: number,
  m10: number,
  m11: number
): { u: number[][]; s: number[]; vt: number[][] };

/** Least-squares similarity transform mapping src -> dst (Umeyama). */
export function solveSimilarityTransform(
  src: number[][],
  dst: number[][]
): Affine2x3;

/** Inverse-map bilinear warp of a raw RGB frame into an outSize x outSize crop. */
export function warpSimilarity(
  rawRgb: Uint8Array,
  imgW: number,
  imgH: number,
  T: Affine2x3,
  outSize?: number
): Uint8Array;
