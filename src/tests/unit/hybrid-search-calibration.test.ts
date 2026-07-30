import { describe, expect, it } from "vitest";
// @ts-expect-error The read-only benchmark intentionally remains a plain Node script.
import { calibrateHybridSearch } from "../../../scripts/calibrate-hybrid-search.mjs";

describe("hybrid search calibration", () => {
  it("runs the fixed grid and reports semantic/tag/hybrid ablation", () => {
    const report = calibrateHybridSearch(
      {
        version: 1,
        queries: [
          {
            id: "bicycle",
            query: "自行车",
            category: "object",
            intent: "object",
            relevantContentHashes: ["bike-1", "bike-2"],
          },
        ],
      },
      {
        queries: [
          {
            id: "bicycle",
            candidates: [
              {
                contentHash: "bike-1",
                normalizedSemantic: 1,
                semanticAccepted: true,
              },
              {
                contentHash: "camera",
                normalizedSemantic: 0.8,
                semanticAccepted: true,
              },
              {
                contentHash: "bike-2",
                normalizedSemantic: 0.7,
                tagSupport: 0.82,
                autoTagConfidence: 0.8,
                supportEligible: true,
              },
            ],
          },
        ],
      }
    );

    expect(report.grid).toHaveLength(18);
    expect(report.selected.config).toEqual({
      semanticWeight: 0.7,
      tagWeight: 0.3,
      autoRescueThreshold: 0.75,
    });
    expect(report.selected.usedFallback).toBe(true);
    expect(report.ablation.hybrid.recallAt50).toBe(1);
    expect(report.ablation.semanticOnly.recallAt50).toBe(0.5);
    expect(report.ablation.tagOnly.recallAt50).toBe(0.5);
  });

  it("never lets an automatic tag rescue a candidate below the support gate", () => {
    const report = calibrateHybridSearch(
      {
        version: 1,
        queries: [
          {
            id: "bicycle",
            query: "自行车",
            category: "object",
            intent: "object",
            relevantContentHashes: ["bike"],
          },
        ],
      },
      {
        queries: [
          {
            id: "bicycle",
            candidates: [
              {
                contentHash: "camera",
                normalizedSemantic: 0.2,
                tagSupport: 1,
                autoTagConfidence: 0.99,
                supportEligible: false,
              },
              {
                contentHash: "bike",
                normalizedSemantic: 1,
                semanticAccepted: true,
              },
            ],
          },
        ],
      }
    );

    expect(report.selected.report.perQuery[0].returned).toBe(1);
    expect(report.selected.report.perQuery[0].precisionAt20).toBe(1);
  });
});
