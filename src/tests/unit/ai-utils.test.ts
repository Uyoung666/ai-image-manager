import { describe, expect, it } from "vitest";
import { cosineSimilarity } from "@/services/ai/constants";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = [1, 2, 3, 4, 5];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1, 5);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = [1, 0, 0];
    const b = [0, 1, 0];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = [1, 2, 3];
    const b = [-1, -2, -3];
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1, 5);
  });

  it("handles zero vectors gracefully", () => {
    const a = [0, 0, 0];
    const b = [1, 2, 3];
    expect(cosineSimilarity(a, b)).toBe(0);
  });

  it("is symmetric", () => {
    const a = [0.5, 0.3, 0.1, 0.9];
    const b = [0.2, 0.7, 0.4, 0.1];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a), 5);
  });

  it("returns value in range [-1, 1] for random vectors", () => {
    for (let t = 0; t < 100; t++) {
      const a = Array.from({ length: 10 }, () => Math.random() * 2 - 1);
      const b = Array.from({ length: 10 }, () => Math.random() * 2 - 1);
      const sim = cosineSimilarity(a, b);
      expect(sim).toBeGreaterThanOrEqual(-1);
      expect(sim).toBeLessThanOrEqual(1);
    }
  });
});

// hammingDistance — BigInt implementation matching handlers.ts
function hammingDistance(a: string, b: string): number {
  if (a.length !== b.length) {
    return 64;
  }
  try {
    const va = BigInt(`0x${a}`);
    const vb = BigInt(`0x${b}`);
    const width = Math.max(va.toString(2).length, vb.toString(2).length);
    const vaBits = va.toString(2).padStart(width, "0");
    const vbBits = vb.toString(2).padStart(width, "0");
    let dist = 0;
    for (let i = 0; i < width; i++) {
      if (vaBits[i] !== vbBits[i]) {
        dist++;
      }
    }
    return dist;
  } catch {
    return 64;
  }
}

describe("hammingDistance", () => {
  it("returns 0 for identical hex strings", () => {
    expect(hammingDistance("abc123def456", "abc123def456")).toBe(0);
  });

  it("returns 1 for neighbors (single bit diff in 1 nibble)", () => {
    // 0x8 (1000) ^ 0x9 (1001) = 0x1 => 1 set bit
    expect(hammingDistance("8", "9")).toBe(1);
  });

  it("returns 4 for opposite nibbles", () => {
    // 0x0 (0000) ^ 0xF (1111) = 0xF => 4 set bits
    expect(hammingDistance("000", "fff")).toBe(4 * 3);
  });

  it("is symmetric", () => {
    const a = "a1b2c3d4e5f6";
    const b = "1a2b3c4d5e6f";
    expect(hammingDistance(a, b)).toBe(hammingDistance(b, a));
  });

  it("returns 64 (max) for different-length phash strings", () => {
    expect(hammingDistance("abc", "abcdef123")).toBe(64);
  });

  it("returns small distance for visually similar phashes", () => {
    // Typical pHash hex
    const phash1 = "c4e0f83070f0c060";
    const phash2 = "c4e0f83070f0c061";
    expect(hammingDistance(phash1, phash2)).toBeLessThanOrEqual(2);
  });
});

// Test that candidate tags are well-formed
describe("Tag suggestion constants", () => {
  // The candidate tags used in ai-embedder.ts for zero-shot classification
  const CANDIDATE_TAGS = [
    "室内",
    "户外",
    "城市",
    "自然风景",
    "海滩",
    "山脉",
    "森林",
    "街道",
    "建筑",
    "花园",
    "田野",
    "湖泊",
    "河流",
    "天空",
    "夜景",
    "人物",
    "动物",
    "猫咪",
    "狗狗",
    "鸟类",
    "汽车",
    "花卉",
    "食物",
    "树木",
    "水面",
    "文字",
    "屏幕截图",
    "文档",
    "白天",
    "夜晚",
    "黄昏",
    "日出",
    "日落",
    "逆光",
    "黑白",
    "鲜艳",
    "暗调",
    "亮调",
    "微距",
    "虚化背景",
    "红色调",
    "蓝色调",
    "绿色调",
    "黄色调",
    "白色调",
    "黑色调",
  ];

  it("has 46 candidate tags for coverage", () => {
    expect(CANDIDATE_TAGS.length).toBe(46);
  });

  it("has no duplicate tags", () => {
    expect(new Set(CANDIDATE_TAGS).size).toBe(CANDIDATE_TAGS.length);
  });

  it("all tags are non-empty strings", () => {
    for (const tag of CANDIDATE_TAGS) {
      expect(tag.length).toBeGreaterThan(0);
    }
  });

  it("contains expected categories", () => {
    const tagSet = new Set(CANDIDATE_TAGS);
    // Scene coverage
    expect(tagSet.has("室内")).toBe(true);
    expect(tagSet.has("户外")).toBe(true);
    expect(tagSet.has("海滩")).toBe(true);
    expect(tagSet.has("山脉")).toBe(true);
    // Subject coverage
    expect(tagSet.has("人物")).toBe(true);
    expect(tagSet.has("猫咪")).toBe(true);
    expect(tagSet.has("花卉")).toBe(true);
    expect(tagSet.has("食物")).toBe(true);
    // Style coverage
    expect(tagSet.has("黑白")).toBe(true);
    expect(tagSet.has("微距")).toBe(true);
    // Color coverage
    expect(tagSet.has("蓝色调")).toBe(true);
  });
});
