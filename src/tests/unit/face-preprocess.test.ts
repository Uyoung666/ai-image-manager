import { describe, expect, it } from "vitest";
import { rgbToNCHW } from "../../../scripts/face-preprocess.mjs";

describe("rgbToNCHW", () => {
  it("produces RGB NCHW layout by default", () => {
    // 2x1 pixel image
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const out = rgbToNCHW(rgb, 2, 1);
    expect(out.length).toBe(3 * 2 * 1);
    // channel 0 = R
    expect(out[0]).toBe(10);
    expect(out[1]).toBe(40);
    // channel 1 = G
    expect(out[2]).toBe(20);
    expect(out[3]).toBe(50);
    // channel 2 = B
    expect(out[4]).toBe(30);
    expect(out[5]).toBe(60);
  });

  it("swaps to BGR when swapRB is set (YuNet)", () => {
    const rgb = new Uint8Array([10, 20, 30, 40, 50, 60]);
    const out = rgbToNCHW(rgb, 2, 1, { swapRB: true });
    expect(out[0]).toBe(30); // B
    expect(out[1]).toBe(60);
    expect(out[2]).toBe(20); // G
    expect(out[3]).toBe(50);
    expect(out[4]).toBe(10); // R
    expect(out[5]).toBe(40);
  });

  it("handles a larger buffer with correct NCHW indexing", () => {
    // 2x2 image
    const w = 2;
    const h = 2;
    const rgb = new Uint8Array(w * h * 3);
    for (let i = 0; i < rgb.length; i++) {
      rgb[i] = i;
    }
    const out = rgbToNCHW(rgb, w, h);
    const pixels = w * h;
    // pixel (0,0) = R rgb[0]
    expect(out[0]).toBe(rgb[0]);
    // pixel (1,1) = R rgb[(3)*3]
    expect(out[3]).toBe(rgb[9]);
    // G channel offset by pixels
    expect(out[pixels]).toBe(rgb[1]);
    // B channel
    expect(out[2 * pixels]).toBe(rgb[2]);
  });
});
