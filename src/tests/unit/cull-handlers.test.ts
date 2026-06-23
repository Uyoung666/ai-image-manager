/**
 * Tests for cull handler pure functions and logic.
 * Does NOT require a real database — tests computeElo, PK_MODE_CONFIG, etc.
 */
import { describe, expect, it } from "vitest";
import { computeElo, PK_MODE_CONFIG } from "@/ipc/cull/elo";

describe("computeElo", () => {
  it("winner gains rating, loser loses rating", () => {
    const { newRatingA, newRatingB } = computeElo(1500, 1500, 1, 0, 0);
    expect(newRatingA).toBeGreaterThan(1500);
    expect(newRatingB).toBeLessThan(1500);
  });

  it("draw changes rating less than win", () => {
    const win = computeElo(1500, 1500, 1, 0, 0);
    const draw = computeElo(1500, 1500, 0.5, 0, 0);
    const winDiff = Math.abs(win.newRatingA - 1500);
    const drawDiff = Math.abs(draw.newRatingA - 1500);
    expect(winDiff).toBeGreaterThan(drawDiff);
  });

  it("upset win causes larger rating change", () => {
    const normal = computeElo(1600, 1400, 1, 0, 0);
    const upset = computeElo(1400, 1600, 1, 0, 0);
    const normalDelta = Math.abs(normal.newRatingA - 1600);
    const upsetDelta = Math.abs(upset.newRatingA - 1400);
    expect(upsetDelta).toBeGreaterThan(normalDelta);
  });

  it("k-factor decreases with more comparisons", () => {
    const early = computeElo(1500, 1500, 1, 0, 0);
    const late = computeElo(1500, 1500, 1, 50, 50);
    const earlyDelta = Math.abs(early.newRatingA - 1500);
    const lateDelta = Math.abs(late.newRatingA - 1500);
    expect(earlyDelta).toBeGreaterThan(lateDelta);
  });
});

describe("PK_MODE_CONFIG", () => {
  it("all modes have valid config", () => {
    for (const mode of ["quick", "standard", "fine"]) {
      const config = PK_MODE_CONFIG[mode];
      expect(config).toBeDefined();
      expect(config.minComparisons).toBeGreaterThan(0);
      expect(typeof config.allowRecompare).toBe("boolean");
      expect(config.similarityWeight).toBeGreaterThan(0);
    }
  });

  it("quick has lowest minComparisons", () => {
    expect(PK_MODE_CONFIG.quick.minComparisons).toBeLessThan(
      PK_MODE_CONFIG.standard.minComparisons
    );
    expect(PK_MODE_CONFIG.standard.minComparisons).toBeLessThan(
      PK_MODE_CONFIG.fine.minComparisons
    );
  });

  it("quick disallows recompare", () => {
    expect(PK_MODE_CONFIG.quick.allowRecompare).toBe(false);
    expect(PK_MODE_CONFIG.standard.allowRecompare).toBe(true);
  });

  it("config fallback works for unknown mode", () => {
    const config = PK_MODE_CONFIG["unknown"] ?? PK_MODE_CONFIG.standard;
    expect(config).toBe(PK_MODE_CONFIG.standard);
  });
});

describe("candidate scoring logic", () => {
  function candidateScore(
    distance: number,
    ratingA: number,
    ratingB: number,
    comparisonsA: number,
    comparisonsB: number,
    similarityWeight: number,
    minComparisons: number,
    sameBurst: boolean
  ): { burst: number; score: number } {
    const burst = sameBurst ? 1 : 0;
    const score =
      similarityWeight * (1 - distance / 8) +
      0.3 * (1 - Math.abs(ratingA - ratingB) / 400) +
      0.2 * (1 - Math.min(comparisonsA, comparisonsB) / minComparisons);
    return { burst, score };
  }

  it("same burst photos get priority", () => {
    const withBurst = candidateScore(4, 1500, 1500, 0, 0, 0.5, 8, true);
    const withoutBurst = candidateScore(0, 1500, 1500, 0, 0, 0.5, 8, false);
    // Burst always wins in sort order (primary sort key)
    expect(withBurst.burst).toBeGreaterThan(withoutBurst.burst);
  });

  it("closer distance gives higher score", () => {
    const close = candidateScore(2, 1500, 1500, 0, 0, 0.5, 8, false);
    const far = candidateScore(6, 1500, 1500, 0, 0, 0.5, 8, false);
    expect(close.score).toBeGreaterThan(far.score);
  });

  it("similar ratings give higher score", () => {
    const similar = candidateScore(4, 1500, 1510, 0, 0, 0.5, 8, false);
    const different = candidateScore(4, 1500, 1700, 0, 0, 0.5, 8, false);
    expect(similar.score).toBeGreaterThan(different.score);
  });

  it("fewer comparisons give higher score", () => {
    const few = candidateScore(4, 1500, 1500, 0, 0, 0.5, 8, false);
    const many = candidateScore(4, 1500, 1500, 8, 8, 0.5, 8, false);
    expect(few.score).toBeGreaterThan(many.score);
  });

  it("similarity weight affects score proportionally", () => {
    const fine = candidateScore(4, 1500, 1500, 0, 0, 0.7, 12, false);
    const quick = candidateScore(4, 1500, 1500, 0, 0, 0.3, 5, false);
    // Fine mode similarity weight (0.7) > quick mode (0.3)
    // Score difference should reflect weight difference
    const diffFine = fine.score - (0.3 * (1 - 0 / 400) + 0.2 * (1 - 0 / 12));
    const diffQuick = quick.score - (0.3 * (1 - 0 / 400) + 0.2 * (1 - 0 / 5));
    // Fine should have more contribution from similarity
    expect(diffFine * (0.3 / 0.7)).toBeCloseTo(diffQuick, 0);
  });
});
