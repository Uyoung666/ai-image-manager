import { describe, expect, it } from "vitest";
import {
  buildSyntheticWorkload,
  parseStressArguments,
  resolveStressExitCode,
  summarizeMemoryTrend,
  summarizeMemoryTrends,
} from "../../../scripts/run-ai-index-stress.mjs";

describe("AI index synthetic stress plan", () => {
  it("defaults to an explicitly synthetic 500-item cyclic workload", () => {
    const options = parseStressArguments([]);
    const workload = buildSyntheticWorkload(
      ["source-a.png", "source-b.png"],
      options.count,
      "missing.png",
      null
    );

    expect(options.count).toBe(500);
    expect(workload).toHaveLength(500);
    expect(workload.slice(0, 4)).toEqual([
      { id: 1, path: "source-a.png", sourceIndex: 0 },
      { id: 2, path: "source-b.png", sourceIndex: 1 },
      { id: 3, path: "source-a.png", sourceIndex: 0 },
      { id: 4, path: "source-b.png", sourceIndex: 1 },
    ]);
  });

  it("only accepts the designed 500-1000 item stress range", () => {
    expect(() => parseStressArguments(["--count", "499"])).toThrow(
      "between 500 and 1000"
    );
    expect(() => parseStressArguments(["--count", "1001"])).toThrow(
      "between 500 and 1000"
    );
    expect(parseStressArguments(["--count", "1000"]).count).toBe(1000);
  });

  it("only allows item errors when explicitly requested", () => {
    expect(parseStressArguments([]).allowErrors).toBe(false);
    expect(parseStressArguments(["--allow-errors"]).allowErrors).toBe(true);
    expect(
      resolveStressExitCode({
        controls: { allowErrors: false },
        status: "completed-with-errors",
      })
    ).toBe(1);
    expect(
      resolveStressExitCode({
        controls: { allowErrors: true },
        status: "completed-with-errors",
      })
    ).toBe(0);
    expect(
      resolveStressExitCode({
        controls: { allowErrors: false },
        status: "complete",
      })
    ).toBe(0);
  });

  it("injects a deterministic failed logical item without changing source order", () => {
    const workload = buildSyntheticWorkload(
      ["source-a.png", "source-b.png"],
      500,
      "missing.png",
      3
    );

    expect(workload[2]).toEqual({
      id: 3,
      path: "missing.png",
      sourceIndex: 0,
    });
    expect(workload[3]?.path).toBe("source-b.png");
  });

  it("reports first, last, peak, and RSS slope without reviewing full-run warmup", () => {
    expect(
      summarizeMemoryTrend([
        { completed: 0, totalRssBytes: 100 },
        { completed: 100, totalRssBytes: 220 },
        { completed: 200, totalRssBytes: 300 },
      ])
    ).toEqual({
      assessment:
        "full-run-upward-rss-trend-includes-warmup-no-leak-conclusion",
      firstRssBytes: 100,
      lastRssBytes: 300,
      leakReviewRecommended: false,
      peakRssBytes: 300,
      rssDeltaBytes: 200,
      rssSlopeBytesPer100Items: 100,
      sampleCount: 3,
    });
  });

  it("separates ORT warmup growth from a flat steady-state trend", () => {
    const trend = summarizeMemoryTrends([
      { completed: 0, totalRssBytes: 100 },
      { completed: 100, totalRssBytes: 220 },
      { completed: 200, totalRssBytes: 300 },
      { completed: 300, totalRssBytes: 300 },
      { completed: 400, totalRssBytes: 300 },
    ]);

    expect(trend.warmupCutoff).toEqual({
      completedLogicalItems: 200,
      sampleIndex: 2,
      skippedSegmentCount: 2,
      strategy: "skip-first-segments-use-cutoff-sample-as-steady-baseline",
    });
    expect(trend.fullRun).toMatchObject({
      assessment:
        "full-run-upward-rss-trend-includes-warmup-no-leak-conclusion",
      leakReviewRecommended: false,
      rssDeltaBytes: 200,
      rssSlopeBytesPer100Items: 48,
    });
    expect(trend.steadyState).toMatchObject({
      assessment: "no-upward-rss-trend-observed-not-proof-of-no-leak",
      leakReviewRecommended: false,
      rssDeltaBytes: 0,
      rssSlopeBytesPer100Items: 0,
      sampleCount: 3,
    });
  });

  it("recommends leak review only for sustained steady-state growth", () => {
    const trend = summarizeMemoryTrends([
      { completed: 0, totalRssBytes: 100 },
      { completed: 100, totalRssBytes: 220 },
      { completed: 200, totalRssBytes: 300 },
      { completed: 300, totalRssBytes: 320 },
      { completed: 400, totalRssBytes: 340 },
    ]);

    expect(trend.fullRun.leakReviewRecommended).toBe(false);
    expect(trend.steadyState).toMatchObject({
      assessment: "steady-state-upward-rss-trend-observed-review-required",
      leakReviewRecommended: true,
      rssDeltaBytes: 40,
      rssSlopeBytesPer100Items: 20,
      sampleCount: 3,
    });
  });
});
