import { describe, expect, it } from "vitest";
import type { SearchResponse } from "@/types/photo";
import {
  EMPTY_SEARCH_RESULT_METADATA,
  getSearchResultMetadata,
  getSearchWithoutTime,
  shouldRestoreSavedSearch,
} from "@/utils/search-state";

describe("relaxing search time constraints", () => {
  it("keeps the keyword and non-time filters, including midnight", () => {
    expect(
      getSearchWithoutTime("去年海边", {
        dateFrom: "2025-01-01",
        dateTo: "2025-12-31",
        dateMonth: "7",
        dateHour: "0",
        cameraModel: "Camera",
        isoMin: "100",
      })
    ).toEqual({
      query: "海边",
      filters: { cameraModel: "Camera", isoMin: "100" },
    });
  });
  it("removes dynamic time expressions while preserving quoted names", () => {
    expect(
      getSearchWithoutTime('"去年" 2024年3月 海边', { creator: "Jane" })
    ).toEqual({ query: '"去年"  海边', filters: { creator: "Jane" } });
    expect(getSearchWithoutTime("去年夏天的海边", {})).toEqual({
      query: "海边",
      filters: {},
    });
  });
  it("allows a pure time search to return to browsing", () => {
    expect(getSearchWithoutTime("去年", {})).toEqual({
      query: "",
      filters: {},
    });
  });
});

describe("search response metadata", () => {
  const semantic: NonNullable<SearchResponse["semantic"]> = {
    indexedPhotos: 4,
    required: true,
    state: "partial",
    topSimilarity: 0.1,
    totalPhotos: 8,
    used: true,
  };

  it("replaces partial metadata when a new complete exact query arrives", () => {
    const old = getSearchResultMetadata(
      { completion: "partial", results: [], semantic, total: 4 },
      "海边"
    );
    expect(old.incomplete).toBe(true);
    const next = getSearchResultMetadata(
      {
        completion: "complete",
        results: [],
        semantic: { ...semantic, required: false, used: false },
        total: 0,
        totalExact: true,
      },
      '"missing.jpg"'
    );
    expect(next).toEqual({
      ...EMPTY_SEARCH_RESULT_METADATA,
      exactTotal: 0,
      semantic: { ...semantic, required: false, used: false },
    });
  });

  it("uses the latest continuation metadata including exact count and score scale", () => {
    const response: SearchResponse = {
      completion: "complete",
      results: [],
      semantic: { ...semantic, state: "ready", topSimilarity: 0.2 },
      timeFilter: { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
      total: 105,
      totalExact: true,
    };
    const metadata = getSearchResultMetadata(response, "去年海边");
    expect(metadata.exactTotal).toBe(105);
    expect(metadata.incomplete).toBe(false);
    expect(metadata.semantic?.topSimilarity).toBe(0.2);
    expect(metadata.timeFilter).toEqual({
      ...response.timeFilter,
      keyword: "去年",
    });
  });

  it("does not turn cancellation into a complete no-match state", () => {
    expect(
      getSearchResultMetadata(
        { completion: "cancelled", results: [], total: 0, totalExact: false },
        "海边"
      )
    ).toMatchObject({ incomplete: true, exactTotal: null });
  });

  it("retains the backend semantic requirement for time and exact queries", () => {
    expect(
      getSearchResultMetadata(
        {
          completion: "complete",
          results: [],
          semantic: { ...semantic, required: false, used: false },
          total: 0,
          totalExact: true,
        },
        "去年"
      ).semantic?.required
    ).toBe(false);
  });

  it("does not require AI for a pure time response with no semantic metadata", () => {
    expect(
      getSearchResultMetadata(
        {
          completion: "complete",
          results: [],
          timeFilter: { dateFrom: "2025-01-01", dateTo: "2025-12-31" },
          total: 0,
          totalExact: true,
        },
        "去年"
      )
    ).toMatchObject({ semanticRequired: false, semantic: null });
  });

  it.each([
    "*.jpg",
    "#ff0000",
  ])("does not require AI for a complete nonsemantic response: %s", (query) => {
    expect(
      getSearchResultMetadata(
        {
          completion: "complete",
          results: [],
          semanticRequired: false,
          total: 0,
          totalExact: true,
        },
        query
      )
    ).toMatchObject({
      semanticRequired: false,
      incomplete: false,
      semantic: null,
    });
  });

  it("lets explicit semantic metadata override the response fallback", () => {
    expect(
      getSearchResultMetadata(
        {
          completion: "partial",
          results: [],
          semanticRequired: false,
          semantic,
          total: 0,
        },
        "去年海边"
      ).semanticRequired
    ).toBe(true);
  });
});

describe("saved search restoration", () => {
  it("does not restore an old search after a drill-down was consumed", () => {
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: true,
        hasDrillParams: true,
        restored: false,
      })
    ).toBe(false);
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: true,
        hasDrillParams: false,
        restored: false,
      })
    ).toBe(false);
  });

  it("restores only once when there is no active drill-down", () => {
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: false,
        hasDrillParams: false,
        restored: false,
      })
    ).toBe(true);
    expect(
      shouldRestoreSavedSearch({
        drillConsumed: false,
        hasDrillParams: false,
        restored: true,
      })
    ).toBe(false);
  });
});
