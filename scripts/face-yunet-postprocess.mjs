/**
 * YuNet post-processing (pure functions, unit-testable).
 *
 * Replicates OpenCV's FaceDetectorYNImpl::postProcess in face_detect.cpp:
 *   - three FPN scales (strides 8/16/32), anchor-free decode
 *   - score = sqrt(clamp(cls) * clamp(obj))
 *   - bbox via exp() on regression offsets
 *   - 5 landmarks as grid offset * stride
 *   - score thresholding during decode + standard NMS (dnn::NMSBoxes)
 *
 * The ONNX model does NOT include NMS — it must be applied externally.
 */

export const YUNET_STRIDES = [8, 16, 32];

/**
 * Decode raw YuNet outputs into candidate faces (pre-NMS).
 *
 * @param {Object<string,{dims:number[],data:Float32Array}>} outputs
 *   onnxruntime run result keyed by output name (cls_8..kps_32).
 * @param {number} inputSize  Square input edge (e.g. 640).
 * @param {number} scoreThreshold  Minimum face score during decode.
 * @returns {Array<{x1:number,y1:number,w:number,h:number,score:number,landmarks:number[][]}>}
 */
export function decodeYuNet(outputs, inputSize, scoreThreshold) {
  const faces = [];

  for (const stride of YUNET_STRIDES) {
    const cols = Math.round(inputSize / stride);
    const rows = Math.round(inputSize / stride);
    const cls = outputs[`cls_${stride}`]?.data;
    const obj = outputs[`obj_${stride}`]?.data;
    const bbox = outputs[`bbox_${stride}`]?.data;
    const kps = outputs[`kps_${stride}`]?.data;
    if (!cls || !obj || !bbox || !kps) {
      continue;
    }

    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const idx = r * cols + c;
        const clsScore = Math.min(Math.max(cls[idx], 0), 1);
        const objScore = Math.min(Math.max(obj[idx], 0), 1);
        const score = Math.sqrt(clsScore * objScore);
        if (score < scoreThreshold) {
          continue;
        }

        const cx = (c + bbox[idx * 4 + 0]) * stride;
        const cy = (r + bbox[idx * 4 + 1]) * stride;
        const w = Math.exp(bbox[idx * 4 + 2]) * stride;
        const h = Math.exp(bbox[idx * 4 + 3]) * stride;

        const landmarks = [];
        for (let n = 0; n < 5; n++) {
          landmarks.push([
            (kps[idx * 10 + 2 * n] + c) * stride,
            (kps[idx * 10 + 2 * n + 1] + r) * stride,
          ]);
        }

        faces.push({
          x1: cx - w / 2,
          y1: cy - h / 2,
          w,
          h,
          score,
          landmarks,
        });
      }
    }
  }
  return faces;
}

/**
 * Standard greedy NMS over candidate faces (matches cv::dnn::NMSBoxes).
 * @param {Array<{x1,y1,w,h,score}>} faces
 * @param {number} nmsThreshold IoU threshold.
 * @param {number} topK  Keep at most topK after suppression.
 * @returns {number[]} kept indices (sorted by score desc).
 */
export function nmsBoxes(faces, nmsThreshold, topK = 5000) {
  const order = faces
    .map((_, i) => i)
    .sort((a, b) => faces[b].score - faces[a].score);
  const kept = [];
  const suppressed = new Set();

  for (let pos = 0; pos < order.length; pos++) {
    const i = order[pos];
    if (suppressed.has(i)) {
      continue;
    }
    kept.push(i);
    for (let pos2 = pos + 1; pos2 < order.length; pos2++) {
      const j = order[pos2];
      if (suppressed.has(j)) {
        continue;
      }
      const ix1 = Math.max(faces[i].x1, faces[j].x1);
      const iy1 = Math.max(faces[i].y1, faces[j].y1);
      const ix2 = Math.min(faces[i].x1 + faces[i].w, faces[j].x1 + faces[j].w);
      const iy2 = Math.min(faces[i].y1 + faces[i].h, faces[j].y1 + faces[j].h);
      const inter = Math.max(0, ix2 - ix1) * Math.max(0, iy2 - iy1);
      if (inter <= 0) {
        continue;
      }
      const areaA = faces[i].w * faces[i].h;
      const areaB = faces[j].w * faces[j].h;
      const iou = inter / (areaA + areaB - inter + 1e-6);
      if (iou > nmsThreshold) {
        suppressed.add(j);
      }
    }
    if (kept.length >= topK) {
      break;
    }
  }
  return kept;
}

/**
 * Full post-pipeline: decode -> NMS. Returns faces sorted by score desc.
 * @returns {Array<{x1,y1,w,h,score,landmarks}>}
 */
export function postProcessYuNet(outputs, inputSize, { scoreThreshold, nmsThreshold, topK = 5000 }) {
  const candidates = decodeYuNet(outputs, inputSize, scoreThreshold);
  const keep = nmsBoxes(candidates, nmsThreshold, topK);
  return keep.map((i) => candidates[i]);
}
