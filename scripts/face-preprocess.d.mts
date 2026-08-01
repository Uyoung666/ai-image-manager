/** Convert interleaved RGB into float32 NCHW (0-255); swapRB=true yields BGR. */
export function rgbToNCHW(
  rgb: Uint8Array,
  w: number,
  h: number,
  opts?: { swapRB?: boolean }
): Float32Array;
