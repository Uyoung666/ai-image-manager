import { describe, it, expect } from "vitest";
import {
  decodeYuNet,
  nmsBoxes,
  postProcessYuNet,
} from "../../../scripts/face-yunet-postprocess.mjs";

// Build a minimal fake output set for a given input size.
function fakeOutputs(
  inputSize: number,
  buildFn?: (
    name: string,
    data: Float32Array,
    rows: number,
    cols: number,
    stride: number
  ) => void
): Record<string, { dims: number[]; data: Float32Array }> {
  const outputs: Record<string, { dims: number[]; data: Float32Array }> = {};
  for (const stride of [8, 16, 32]) {
    const cols = Math.round(inputSize / stride);
    const rows = Math.round(inputSize / stride);
    const n = rows * cols;
    for (const prefix of ["cls", "obj", "bbox", "kps"]) {
      const outLen = prefix === "bbox" ? n * 4 : prefix === "kps" ? n * 10 : n;
      const data = new Float32Array(outLen);
      const name = `${prefix}_${stride}`;
      outputs[name] = { dims: [], data };
      buildFn?.(name, data, rows, cols, stride);
    }
  }
  return outputs;
}

describe("decodeYuNet", () => {
  it("decodes a single high-score face at stride 8", () => {
    const inputSize = 640;
    const outputs = fakeOutputs(inputSize, (name, data, rows, cols, stride) => {
      const c = 40; // grid col
      const r = 30; // grid row
      const idx = r * cols + c;
      if (name === `cls_${stride}`) {
        data[idx] = 0.81; // cls
      }
      if (name === `obj_${stride}`) {
        data[idx] = 1.0; // obj
      }
      if (name === `bbox_${stride}`) {
        // offsets: cx=0, cy=0, w=1, h=1 -> center at (c*stride, r*stride), size stride
        data[idx * 4 + 0] = 0;
        data[idx * 4 + 1] = 0;
        data[idx * 4 + 2] = 0; // exp(0)*stride = stride
        data[idx * 4 + 3] = 0;
      }
      if (name === `kps_${stride}`) {
        data[idx * 10 + 0] = 0; // landmark 0 x offset
        data[idx * 10 + 1] = 0; // landmark 0 y offset
      }
    });

    const faces = decodeYuNet(outputs, inputSize, 0.5);
    // score = sqrt(0.81 * 1.0) = 0.9 >= 0.5 -> kept, all 3 scales have it but only stride 8 populated
    const stride8 = faces.filter((f) => f.w === 8 && f.h === 8);
    expect(stride8.length).toBe(1);
    expect(stride8[0].score).toBeCloseTo(0.9, 6);
    // center at (40*8, 30*8) = (320, 240), size 8
    expect(stride8[0].x1).toBeCloseTo(320 - 4, 6);
    expect(stride8[0].y1).toBeCloseTo(240 - 4, 6);
    // landmark 0 at (c*stride, r*stride)
    expect(stride8[0].landmarks[0][0]).toBeCloseTo(320, 6);
    expect(stride8[0].landmarks[0][1]).toBeCloseTo(240, 6);
  });

  it("filters faces below the score threshold during decode", () => {
    const inputSize = 320;
    const outputs = fakeOutputs(inputSize, (name, data, rows, cols, stride) => {
      const idx = 0;
      if (name === `cls_${stride}`) {
        data[idx] = 0.1;
      }
      if (name === `obj_${stride}`) {
        data[idx] = 0.1; // score = 0.1
      }
    });
    const faces = decodeYuNet(outputs, inputSize, 0.5);
    expect(faces.length).toBe(0);
  });

  it("handles missing outputs gracefully", () => {
    const faces = decodeYuNet({}, 320, 0.5);
    expect(faces).toEqual([]);
  });
});

describe("nmsBoxes", () => {
  it("suppresses overlapping boxes keeping the highest score", () => {
    const faces = [
      { x1: 0, y1: 0, w: 100, h: 100, score: 0.9 },
      { x1: 10, y1: 10, w: 100, h: 100, score: 0.8 }, // high IoU with first
      { x1: 300, y1: 300, w: 50, h: 50, score: 0.85 }, // separate
    ];
    const keep = nmsBoxes(faces, 0.3, 5000);
    expect(keep).toHaveLength(2);
    expect(keep[0]).toBe(0); // highest score kept
    expect(keep).toContain(2);
    expect(keep).not.toContain(1);
  });

  it("respects topK cap", () => {
    const faces = [];
    for (let i = 0; i < 10; i++) {
      faces.push({ x1: i * 200, y1: 0, w: 50, h: 50, score: 1 - i * 0.05 });
    }
    const keep = nmsBoxes(faces, 0.3, 3);
    expect(keep).toHaveLength(3);
  });

  it("returns empty for empty input", () => {
    expect(nmsBoxes([], 0.3, 5000)).toEqual([]);
  });
});

describe("postProcessYuNet", () => {
  it("runs decode + NMS end to end", () => {
    const inputSize = 640;
    const outputs = fakeOutputs(inputSize, (name, data, rows, cols, stride) => {
      if (stride !== 16) return;
      const idx = 5 * cols + 5; // (r=5, c=5) — valid within 40x40 grid
      if (name === "cls_16") data[idx] = 1;
      if (name === "obj_16") data[idx] = 1;
      if (name === "bbox_16") {
        data[idx * 4 + 0] = 0;
        data[idx * 4 + 1] = 0;
        data[idx * 4 + 2] = 0;
        data[idx * 4 + 3] = 0;
      }
    });
    const result = postProcessYuNet(outputs, inputSize, {
      scoreThreshold: 0.5,
      nmsThreshold: 0.3,
    });
    expect(result.length).toBe(1);
    expect(result[0].w).toBe(16);
    expect(result[0].score).toBeCloseTo(1, 9);
    expect(result[0].landmarks).toHaveLength(5);
  });
});
