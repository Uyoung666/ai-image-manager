import { describe, it, expect } from "vitest";
import {
  ARCFACE_TARGET_POINTS,
  solveSimilarityTransform,
  warpSimilarity,
  svd2x2,
} from "../../../scripts/face-alignment.mjs";

const applyAffine = (
  T: { a: number; b: number; c: number; d: number; tx: number; ty: number },
  p: number[]
) => [
  T.a * p[0] + T.b * p[1] + T.tx,
  T.c * p[0] + T.d * p[1] + T.ty,
];

describe("svd2x2", () => {
  it("recovers singular values of a diagonal matrix", () => {
    const { s } = svd2x2(4, 0, 0, 3);
    expect(s[0]).toBeCloseTo(4, 9);
    expect(s[1]).toBeCloseTo(3, 9);
  });

  it("reconstructs the input matrix via U * diag(s) * Vt", () => {
    const m00 = 2, m01 = 1, m10 = -1, m11 = 3;
    const { u, s, vt } = svd2x2(m00, m01, m10, m11);
    // U * diag(s) * Vt
    const r00 = (u[0][0] * s[0] * vt[0][0] + u[0][1] * s[1] * vt[1][0]);
    const r01 = (u[0][0] * s[0] * vt[0][1] + u[0][1] * s[1] * vt[1][1]);
    const r10 = (u[1][0] * s[0] * vt[0][0] + u[1][1] * s[1] * vt[1][0]);
    const r11 = (u[1][0] * s[0] * vt[0][1] + u[1][1] * s[1] * vt[1][1]);
    expect(r00).toBeCloseTo(m00, 9);
    expect(r01).toBeCloseTo(m01, 9);
    expect(r10).toBeCloseTo(m10, 9);
    expect(r11).toBeCloseTo(m11, 9);
    // singular values sorted descending
    expect(s[0]).toBeGreaterThanOrEqual(s[1]);
  });
});

describe("solveSimilarityTransform", () => {
  it("recovers a known similarity transform exactly", () => {
    const scale = 2;
    const ang = (30 * Math.PI) / 180;
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    // M = s * [[cos, -sin],[sin, cos]]
    const T = {
      a: scale * cosA,
      b: -scale * sinA,
      c: scale * sinA,
      d: scale * cosA,
      tx: 10,
      ty: -5,
    };
    const src = [
      [20, 30],
      [80, 40],
      [50, 120],
      [10, 90],
      [120, 150],
    ];
    const dst = src.map((p) => applyAffine(T, p));

    const est = solveSimilarityTransform(src, dst);
    expect(est.a).toBeCloseTo(T.a, 8);
    expect(est.b).toBeCloseTo(T.b, 8);
    expect(est.c).toBeCloseTo(T.c, 8);
    expect(est.d).toBeCloseTo(T.d, 8);
    expect(est.tx).toBeCloseTo(T.tx, 6);
    expect(est.ty).toBeCloseTo(T.ty, 6);
  });

  it("projects ArcFace target points back onto themselves", () => {
    // identity transform over the canonical target set
    const est = solveSimilarityTransform(ARCFACE_TARGET_POINTS, ARCFACE_TARGET_POINTS);
    expect(est.a).toBeCloseTo(1, 8);
    expect(est.d).toBeCloseTo(1, 8);
    expect(est.b).toBeCloseTo(0, 8);
    expect(est.c).toBeCloseTo(0, 8);
    expect(est.tx).toBeCloseTo(0, 6);
    expect(est.ty).toBeCloseTo(0, 6);
  });

  it("maps strictly-similar landmarks onto the 112x112 target within 1px", () => {
    // Source = target scaled 2x, rotated 5°, translated (50, 30) — exactly similar.
    const scale = 2;
    const ang = (5 * Math.PI) / 180;
    const T0 = {
      a: scale * Math.cos(ang),
      b: -scale * Math.sin(ang),
      c: scale * Math.sin(ang),
      d: scale * Math.cos(ang),
      tx: 50,
      ty: 30,
    };
    const src = ARCFACE_TARGET_POINTS.map((p) => applyAffine(T0, p));
    const est = solveSimilarityTransform(src, ARCFACE_TARGET_POINTS);
    const mapped = src.map((p) => applyAffine(est, p));
    for (let i = 0; i < 5; i++) {
      expect(Math.abs(mapped[i][0] - ARCFACE_TARGET_POINTS[i][0])).toBeLessThan(1);
      expect(Math.abs(mapped[i][1] - ARCFACE_TARGET_POINTS[i][1])).toBeLessThan(1);
    }
  });

  it("throws on degenerate input (fewer than 2 points / zero variance)", () => {
    expect(() => solveSimilarityTransform([[1, 1]], [[2, 2]])).toThrow();
    expect(() =>
      solveSimilarityTransform(
        [
          [5, 5],
          [5, 5],
          [5, 5],
        ],
        [
          [1, 1],
          [2, 2],
          [3, 3],
        ]
      )
    ).toThrow();
  });
});

describe("warpSimilarity", () => {
  it("identity transform preserves pixel values (no interpolation change)", () => {
    const size = 8;
    // gradient source
    const raw = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 3;
        raw[o] = x * 10;
        raw[o + 1] = y * 10;
        raw[o + 2] = 128;
      }
    }
    const T = { a: 1, b: 0, c: 0, d: 1, tx: 0, ty: 0 };
    const out = warpSimilarity(raw, size, size, T, size);
    expect(out.length).toBe(size * size * 3);
    for (let i = 0; i < out.length; i++) {
      expect(out[i]).toBe(raw[i]);
    }
  });

  it("translates the crop by sampling the correct source region", () => {
    const size = 8;
    const raw = new Uint8Array(size * size * 3);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const o = (y * size + x) * 3;
        raw[o] = x; // R = x coordinate
      }
    }
    // shift output by (+2,+0): out pixel jx samples source (jx - 2)
    const T = { a: 1, b: 0, c: 0, d: 1, tx: 2, ty: 0 };
    const out = warpSimilarity(raw, size, size, T, size);
    // out(3,0).R should equal source x=1
    expect(out[(0 * size + 3) * 3]).toBe(1);
    expect(out[(0 * size + 2) * 3]).toBe(0);
  });

  it("returns black crop for degenerate transform", () => {
    const raw = new Uint8Array(8 * 8 * 3).fill(100);
    const T = { a: 0, b: 0, c: 0, d: 0, tx: 0, ty: 0 }; // zero det
    const out = warpSimilarity(raw, 8, 8, T, 8);
    expect(out.every((v: number) => v === 0)).toBe(true);
  });
});
