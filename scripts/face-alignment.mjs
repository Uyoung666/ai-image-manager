/**
 * Face alignment utilities (pure functions, unit-testable).
 *
 * Replicates OpenCV's FaceRecognizerSF alignCrop semantics:
 *   1. solveSimilarityTransform — Umeyama-style least-squares similarity
 *      transform (rotation + uniform scale + translation, reflection-aware),
 *      matching cv::getSimilarityTransformMatrix in OpenCV's face_recognize.cpp.
 *   2. warpSimilarity — inverse-map bilinear sampling, matching
 *      cv::warpAffine(..., INTER_LINEAR) on a 112x112 output.
 *
 * Pure JS — no sharp / no OpenCV dependency.
 */

// ArcFace-standard 5-point target landmarks for a 112x112 aligned crop.
// Order matches YuNet output: [right eye, left eye, nose tip, right mouth corner, left mouth corner].
export const ARCFACE_TARGET_POINTS = [
  [38.2946, 51.6963], // right eye
  [73.5318, 51.5014], // left eye
  [56.0252, 71.7366], // nose tip
  [41.5493, 92.3655], // right mouth corner
  [70.7299, 92.2041], // left mouth corner
];

/**
 * 2x2 SVD: M = U * diag(s) * Vt.
 * Closed-form eigen decomposition of M^T M. s is sorted descending.
 * @param {number} m00
 * @param {number} m01
 * @param {number} m10
 * @param {number} m11
 * @returns {{u: number[][], s: number[], vt: number[][]}}
 */
export function svd2x2(m00, m01, m10, m11) {
  // E = M^T M (symmetric 2x2)
  const e00 = m00 * m00 + m10 * m10;
  const e01 = m00 * m01 + m10 * m11;
  const e11 = m01 * m01 + m11 * m11;

  const trace = e00 + e11;
  const det = e00 * e11 - e01 * e01;
  const disc = Math.sqrt(Math.max(0, trace * trace - 4 * det));
  const lam1 = (trace + disc) / 2; // larger eigenvalue
  const lam2 = (trace - disc) / 2; // smaller eigenvalue
  const s1 = Math.sqrt(Math.max(0, lam1));
  const s2 = Math.sqrt(Math.max(0, lam2));

  // Eigenvectors of E. Handle the (near-)diagonal case robustly.
  let v1x, v1y, v2x, v2y;
  if (Math.abs(e01) > 1e-12) {
    // v1 for lam1: (E01, lam1 - E00)
    v1x = e01;
    v1y = lam1 - e00;
    const n1 = Math.hypot(v1x, v1y) || 1;
    v1x /= n1;
    v1y /= n1;
    // v2 orthogonal (symmetric E => v2 = (-v1y, v1x))
    v2x = -v1y;
    v2y = v1x;
  } else {
    v1x = 1;
    v1y = 0;
    v2x = 0;
    v2y = 1;
  }

  // U = M V Sigma^-1 (columns of U are M*v_i / sigma_i)
  const u1x = s1 > 1e-12 ? (m00 * v1x + m01 * v1y) / s1 : 1;
  const u1y = s1 > 1e-12 ? (m10 * v1x + m11 * v1y) / s1 : 0;
  const u2x = s2 > 1e-12 ? (m00 * v2x + m01 * v2y) / s2 : 0;
  const u2y = s2 > 1e-12 ? (m10 * v2x + m11 * v2y) / s2 : 1;

  // Contract: M = u * diag(s) * vt. Columns of u are left singular vectors;
  // rows of vt are right singular vectors (V^T).
  return {
    u: [
      [u1x, u2x],
      [u1y, u2y],
    ],
    s: [s1, s2],
    vt: [
      [v1x, v1y],
      [v2x, v2y],
    ],
  };
}

function det2(m) {
  return m[0][0] * m[1][1] - m[0][1] * m[1][0];
}

function matMul2(a, b) {
  return [
    [
      a[0][0] * b[0][0] + a[0][1] * b[1][0],
      a[0][0] * b[0][1] + a[0][1] * b[1][1],
    ],
    [
      a[1][0] * b[0][0] + a[1][1] * b[1][0],
      a[1][0] * b[0][1] + a[1][1] * b[1][1],
    ],
  ];
}

/**
 * Solve a 2D similarity transform mapping src -> dst in the least-squares sense.
 * Equivalent to cv::getSimilarityTransformMatrix (Umeyama with reflection handling).
 *
 * @param {number[][]} src  Array of N points [x, y] (source landmarks).
 * @param {number[][]} dst  Array of N points [x, y] (target landmarks).
 * @returns {{a:number,b:number,c:number,d:number,tx:number,ty:number}}
 *   2x3 affine matrix M where dst = M * [x,y,1]^T.
 */
export function solveSimilarityTransform(src, dst) {
  const n = src.length;
  if (n < 2 || src.length !== dst.length) {
    throw new Error(
      `solveSimilarityTransform: need >=2 matched points, got ${n}`
    );
  }

  let mx = 0;
  let my = 0;
  let Mx = 0;
  let My = 0;
  for (let i = 0; i < n; i++) {
    mx += src[i][0];
    my += src[i][1];
    Mx += dst[i][0];
    My += dst[i][1];
  }
  mx /= n;
  my /= n;
  Mx /= n;
  My /= n;

  let sigmaSrc2 = 0;
  let c00 = 0;
  let c01 = 0;
  let c10 = 0;
  let c11 = 0;
  for (let i = 0; i < n; i++) {
    const sx = src[i][0] - mx;
    const sy = src[i][1] - my;
    const dx = dst[i][0] - Mx;
    const dy = dst[i][1] - My;
    sigmaSrc2 += sx * sx + sy * sy;
    // C = (1/n) * sum(dst_c * src_c^T)
    c00 += dx * sx;
    c01 += dx * sy;
    c10 += dy * sx;
    c11 += dy * sy;
  }
  sigmaSrc2 /= n;
  c00 /= n;
  c01 /= n;
  c10 /= n;
  c11 /= n;

  if (sigmaSrc2 < 1e-12) {
    throw new Error(
      "solveSimilarityTransform: degenerate source points (all identical)"
    );
  }

  // SVD of C
  const { u, s, vt } = svd2x2(c00, c01, c10, c11);

  // Reflection handling: flip last singular value if det(UV^T) < 0
  const uvt = matMul2(u, vt);
  const d0 = 1;
  let d1 = 1;
  if (det2(uvt) < 0) {
    d1 = -1;
  }

  // R = U * diag(d0,d1) * Vt  (rotation, possibly with reflection)
  const duv = matMul2(u, [
    [d0, 0],
    [0, d1],
  ]);
  const r = matMul2(duv, vt);

  // Scale = trace(diag(s) * diag(d0,d1)) / sigmaSrc2
  const scale = (s[0] * d0 + s[1] * d1) / sigmaSrc2;

  const a = scale * r[0][0];
  const b = scale * r[0][1];
  const c = scale * r[1][0];
  const d = scale * r[1][1];
  const tx = Mx - (a * mx + b * my);
  const ty = My - (c * mx + d * my);

  return { a, b, c, d, tx, ty };
}

/**
 * Warp a full-frame raw RGB buffer into an outSize x outSize aligned crop
 * using the given affine transform, with inverse-map bilinear sampling
 * (equivalent to cv::warpAffine INTER_LINEAR).
 *
 * @param {Uint8Array} rawRgb  Interleaved RGB buffer of the full image.
 * @param {number} imgW         Source image width.
 * @param {number} imgH         Source image height.
 * @param {{a,b,c,d,tx,ty}} T  2x3 affine (forward) transform.
 * @param {number} outSize      Output edge length (e.g. 112).
 * @returns {Uint8Array} outSize*outSize*3 interleaved RGB, pixels clamped to source bounds.
 */
export function warpSimilarity(rawRgb, imgW, imgH, T, outSize = 112) {
  const { a, b, c, d, tx, ty } = T;
  const det = a * d - b * c;
  const out = new Uint8Array(outSize * outSize * 3);

  if (Math.abs(det) < 1e-12 || !Number.isFinite(det)) {
    return out; // degenerate transform -> black crop
  }

  const invA = d / det;
  const invB = -b / det;
  const invC = -c / det;
  const invD = a / det;

  const xMax = imgW - 1;
  const yMax = imgH - 1;

  for (let jy = 0; jy < outSize; jy++) {
    for (let jx = 0; jx < outSize; jx++) {
      // Inverse map: source coords for this output pixel
      const sx = invA * (jx - tx) + invB * (jy - ty);
      const sy = invC * (jx - tx) + invD * (jy - ty);

      const x0 = Math.min(Math.max(Math.floor(sx), 0), xMax);
      const y0 = Math.min(Math.max(Math.floor(sy), 0), yMax);
      const x1 = Math.min(x0 + 1, xMax);
      const y1 = Math.min(y0 + 1, yMax);
      const fx = Math.max(0, Math.min(sx - x0, 1));
      const fy = Math.max(0, Math.min(sy - y0, 1));

      const o = (jy * outSize + jx) * 3;
      for (let ch = 0; ch < 3; ch++) {
        const p00 = rawRgb[(y0 * imgW + x0) * 3 + ch];
        const p10 = rawRgb[(y0 * imgW + x1) * 3 + ch];
        const p01 = rawRgb[(y1 * imgW + x0) * 3 + ch];
        const p11 = rawRgb[(y1 * imgW + x1) * 3 + ch];
        const v =
          p00 * (1 - fx) * (1 - fy) +
          p10 * fx * (1 - fy) +
          p01 * (1 - fx) * fy +
          p11 * fx * fy;
        out[o + ch] = Math.round(v);
      }
    }
  }
  return out;
}
