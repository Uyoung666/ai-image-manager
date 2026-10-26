import { act, renderHook } from "@testing-library/react";
import { createElement, StrictMode, useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SearchResponse } from "@/types/photo";
import {
  EMPTY_SEARCH_RESULT_METADATA,
  getSearchResultMetadata,
  getSearchWithoutTime,
  scheduleSavedSearchRestore,
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

describe("saved search restoration scheduling", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("restores a ready session after the initial delay and only once", () => {
    const restore = vi.fn();
    scheduleSavedSearchRestore(
      { completed: false, generation: 0 },
      { getGeneration: () => 0, isReady: () => true, restore }
    );
    vi.advanceTimersByTime(299);
    expect(restore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restore).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(20_000);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("waits for AI status and restores at the next polling interval", () => {
    let ready = false;
    const restore = vi.fn();
    scheduleSavedSearchRestore(
      { completed: false, generation: 0 },
      { getGeneration: () => 0, isReady: () => ready, restore }
    );
    vi.advanceTimersByTime(550);
    expect(restore).not.toHaveBeenCalled();
    ready = true;
    vi.advanceTimersByTime(49);
    expect(restore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restore).toHaveBeenCalledOnce();
  });

  it("keeps the existing bounded wait when AI status never arrives", () => {
    const restore = vi.fn();
    scheduleSavedSearchRestore(
      { completed: false, generation: 0 },
      { getGeneration: () => 0, isReady: () => false, restore }
    );
    vi.advanceTimersByTime(10_299);
    expect(restore).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(restore).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    "a new search",
    "a search preset",
    "clearing search",
  ])("discards the saved session after %s advances its generation", () => {
    let generation = 0;
    let ready = false;
    const plan = { completed: false, generation };
    const restore = vi.fn();
    const options = {
      getGeneration: () => generation,
      isReady: () => ready,
      restore,
    };
    scheduleSavedSearchRestore(plan, options);
    vi.advanceTimersByTime(300);
    generation++;
    ready = true;
    vi.advanceTimersByTime(100);
    expect(restore).not.toHaveBeenCalled();
    expect(plan.completed).toBe(true);
    scheduleSavedSearchRestore(plan, options);
    vi.advanceTimersByTime(20_000);
    expect(restore).not.toHaveBeenCalled();
  });

  it("does not start a stale session superseded before the initial delay", () => {
    let generation = 0;
    const restore = vi.fn();
    scheduleSavedSearchRestore(
      { completed: false, generation },
      { getGeneration: () => generation, isReady: () => true, restore }
    );
    generation++;
    vi.advanceTimersByTime(300);
    expect(restore).not.toHaveBeenCalled();
  });

  it("cancels the active polling timer when its component unmounts", () => {
    let ready = false;
    const restore = vi.fn();
    const { unmount } = renderHook(() => {
      useEffect(
        () =>
          scheduleSavedSearchRestore(
            { completed: false, generation: 0 },
            { getGeneration: () => 0, isReady: () => ready, restore }
          ),
        []
      );
    });
    act(() => vi.advanceTimersByTime(300));
    unmount();
    ready = true;
    vi.advanceTimersByTime(20_000);
    expect(restore).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("restores the original plan once after StrictMode effect cleanup and replay", () => {
    const restore = vi.fn();
    const { result } = renderHook(
      () => {
        const plan = useRef({ completed: false, generation: 0 });
        useEffect(
          () =>
            scheduleSavedSearchRestore(plan.current, {
              getGeneration: () => 0,
              isReady: () => true,
              restore,
            }),
          []
        );
        return plan;
      },
      { wrapper: ({ children }) => createElement(StrictMode, null, children) }
    );
    expect(result.current.current.completed).toBe(false);
    act(() => vi.advanceTimersByTime(300));
    expect(restore).toHaveBeenCalledOnce();
    expect(result.current.current.completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
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
