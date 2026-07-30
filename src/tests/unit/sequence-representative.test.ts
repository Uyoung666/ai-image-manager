import { describe, expect, it } from "vitest";
import {
  analyzeSequenceLuma,
  recommendSequenceRepresentative,
  type SequenceRepresentativeCandidate,
  type SequenceRepresentativeImageMetrics,
} from "@/services/sequence-representative";

function candidate(
  id: number,
  overrides: Partial<SequenceRepresentativeCandidate> = {}
): SequenceRepresentativeCandidate {
  return {
    height: 2000,
    id,
    isFavorite: false,
    path: `photo-${id}.jpg`,
    width: 3000,
    ...overrides,
  };
}

function metrics(
  overrides: Partial<SequenceRepresentativeImageMetrics> = {}
): SequenceRepresentativeImageMetrics {
  return {
    exposure: 0.9,
    information: 0.6,
    sharpness: 0.6,
    ...overrides,
  };
}

describe("sequence representative quality analysis", () => {
  it("scores sharp detail above a blurred flat frame", () => {
    const width = 12;
    const height = 12;
    const sharpPixels = Uint8Array.from(
      { length: width * height },
      (_, index) =>
        ((index % width) + Math.floor(index / width)) % 2 ? 32 : 224
    );
    const blurredPixels = new Uint8Array(width * height).fill(128);

    const sharpResult = analyzeSequenceLuma(sharpPixels, width, height);
    const blurredResult = analyzeSequenceLuma(blurredPixels, width, height);

    expect(sharpResult.sharpness).toBeGreaterThan(blurredResult.sharpness);
    expect(sharpResult.information).toBeGreaterThan(blurredResult.information);
  });

  it("scores a normally exposed frame above an overexposed frame", () => {
    const normallyExposed = analyzeSequenceLuma(
      new Uint8Array(100).fill(128),
      10,
      10
    );
    const overexposed = analyzeSequenceLuma(
      new Uint8Array(100).fill(255),
      10,
      10
    );

    expect(normallyExposed.exposure).toBe(1);
    expect(overexposed.exposure).toBe(0);
  });
});

describe("sequence representative recommendation", () => {
  it("prefers the sharper, better exposed successful candidate", async () => {
    const result = await recommendSequenceRepresentative(
      [candidate(1), candidate(2)],
      {
        analyzeCandidate: async (entry) =>
          entry.id === 1
            ? metrics({ exposure: 0.2, sharpness: 0.1 })
            : metrics({ exposure: 1, sharpness: 0.95 }),
      }
    );

    expect(result?.recommendedPhotoId).toBe(2);
    expect(result?.reasonKeys).toContain(
      "sequence.representative.reason.sharp"
    );
    expect(result?.reasonKeys).toContain(
      "sequence.representative.reason.balancedExposure"
    );
  });

  it("uses favorite and optional user signals when visual quality is equal", async () => {
    const result = await recommendSequenceRepresentative(
      [
        candidate(1),
        candidate(2, { isFavorite: true }),
        candidate(3, { manualPreference: 1, rating: 5 }),
      ],
      { analyzeCandidate: async () => metrics() }
    );

    expect(result?.recommendedPhotoId).toBe(2);
    expect(result?.candidates[1].reasonKeys).toContain(
      "sequence.representative.reason.favorite"
    );
    expect(result?.candidates[2].reasonKeys).toEqual(
      expect.arrayContaining([
        "sequence.representative.reason.highRating",
        "sequence.representative.reason.manualPreference",
      ])
    );
  });

  it("skips one failed file and preserves a per-candidate failure result", async () => {
    const result = await recommendSequenceRepresentative(
      [candidate(1), candidate(2)],
      {
        analyzeCandidate: (entry) => {
          if (entry.id === 1) {
            return Promise.reject(new Error("broken image"));
          }
          return Promise.resolve(metrics());
        },
      }
    );

    expect(result?.recommendedPhotoId).toBe(2);
    expect(result?.candidates[0]).toMatchObject({
      metrics: null,
      reasonKeys: ["sequence.representative.reason.analysisFailed"],
      score: 0,
    });
  });

  it("falls back to the first input when every file fails", async () => {
    const result = await recommendSequenceRepresentative(
      [candidate(7, { isFavorite: false }), candidate(3, { isFavorite: true })],
      {
        analyzeCandidate: () => Promise.reject(new Error("unreadable")),
      }
    );

    expect(result?.recommendedPhotoId).toBe(7);
    expect(result?.reasonKeys).toEqual([
      "sequence.representative.reason.stableFallback",
    ]);
  });

  it("limits concurrency and keeps input order as a deterministic tie-breaker", async () => {
    let active = 0;
    let maximumActive = 0;
    const result = await recommendSequenceRepresentative(
      [candidate(9), candidate(4), candidate(6), candidate(2)],
      {
        concurrency: 2,
        analyzeCandidate: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          await Promise.resolve();
          active -= 1;
          return metrics();
        },
      }
    );

    expect(maximumActive).toBeLessThanOrEqual(2);
    expect(result?.recommendedPhotoId).toBe(9);
    expect(result?.candidates.map((entry) => entry.id)).toEqual([9, 4, 6, 2]);
  });
});
