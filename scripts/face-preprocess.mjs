/**
 * Face preprocessing utilities (pure functions, unit-testable).
 *
 * Both YuNet and SFace expect raw 0-255 pixel values — normalization happens
 * inside the ONNX graphs (confirmed via onnxruntime inputMetadata + OpenCV
 * blobFromImage semantics). This module only handles channel-order layout:
 *   - YuNet expects BGR  (OpenCV blobFromImage with default swapRB=false)
 *   - SFace expects RGB   (OpenCV blobFromImage with swapRB=true)
 */

/**
 * Convert an interleaved RGB Uint8 buffer into a float32 NCHW tensor (0-255).
 * @param {Uint8Array} rgb  RGB interleaved, length = w*h*3.
 * @param {number} w
 * @param {number} h
 * @param {{swapRB?: boolean}} [opts]  swapRB=true turns RGB -> BGR (YuNet).
 * @returns {Float32Array} length 3*w*h, layout [C][Y][X].
 */
export function rgbToNCHW(rgb, w, h, { swapRB = false } = {}) {
  const pixels = w * h;
  const out = new Float32Array(3 * pixels);
  const rIdx = swapRB ? 2 : 0;
  const gIdx = 1;
  const bIdx = swapRB ? 0 : 2;

  for (let i = 0; i < pixels; i++) {
    const s = i * 3;
    out[i] = rgb[s + rIdx]; // channel 0
    out[pixels + i] = rgb[s + gIdx]; // channel 1
    out[2 * pixels + i] = rgb[s + bIdx]; // channel 2
  }
  return out;
}
