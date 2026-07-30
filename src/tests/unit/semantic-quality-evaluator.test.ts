import { describe, expect, it } from "vitest";
// @ts-expect-error The read-only benchmark intentionally remains a plain Node script.
import { evaluateSemanticRun } from "../../../scripts/evaluate-semantic-quality.mjs";

describe("semantic quality evaluator", () => {
  it("calculates precision, recall, nDCG, counts, errors, and P95 read-only", () => {
    const report = evaluateSemanticRun(
      {
        version: 1,
        errorCategoryByContentHash: { camera: "camera" },
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
            latencyMs: 260,
            results: ["bike-1", "camera", "bike-2"],
          },
        ],
      }
    );

    expect(report.macro.precisionAt20).toBeCloseTo(2 / 3);
    expect(report.macro.recallAt50).toBe(1);
    expect(report.macro.ndcgAt50).toBeGreaterThan(0);
    expect(report.macro.returned).toBe(3);
    expect(report.macro.p95LatencyMs).toBe(260);
    expect(report.errorCategories).toEqual({ camera: 1 });
  });
});
