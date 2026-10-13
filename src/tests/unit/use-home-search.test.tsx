import { act, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeSearch } from "@/features/home/use-home-search";
import type { Photo, SearchResponse } from "@/types/photo";

const mocks = vi.hoisted(() => ({
  cancelPending: vi.fn(),
  getPreview: vi.fn(),
  imageSearch: vi.fn(),
  runSearch: vi.fn(),
}));

vi.mock("@/hooks/use-photo-search", () => ({ usePhotoSearch: () => mocks }));
vi.mock("@/actions/image-search", () => ({
  imageSearchActions: {
    getPreview: mocks.getPreview,
    search: mocks.imageSearch,
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(
  id: number,
  extra: Partial<SearchResponse> = {}
): SearchResponse {
  return {
    completion: "complete",
    results: [{ id } as Photo],
    total: 1,
    totalExact: true,
    ...extra,
  };
}

function setup() {
  const options = {
    clearDashboardReturnTarget: vi.fn(),
    filter: {
      appliedSearch: null,
      applySearch: vi.fn(),
      clearSearch: vi.fn(),
    },
    navigate: vi.fn(),
    saveBrowseSession: vi.fn(),
    setDrillDownFilters: vi.fn(),
    setShowDrillBanner: vi.fn(),
  };
  const hook = renderHook(
    () => useHomeSearch(options as Parameters<typeof useHomeSearch>[0]),
    { wrapper: StrictMode }
  );
  return { ...hook, options };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.runSearch.mockReset();
  mocks.imageSearch.mockReset();
  mocks.getPreview.mockReset().mockResolvedValue({
    dataUrl: "data:image/png;base64,preview",
    exists: true,
  });
});

describe("home search orchestration", () => {
  it("keeps the latest generation when an older identical query finishes last", async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    const third = deferred<SearchResponse>();
    mocks.runSearch
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(third.promise);
    const { result } = setup();
    let pending!: Promise<void>[];
    act(() => {
      pending = [
        result.current.handleSearch("A"),
        result.current.handleSearch("B"),
        result.current.handleSearch("A"),
      ];
    });
    await act(async () => {
      third.resolve(response(3));
      await pending[2];
      second.resolve(response(2, { completion: "partial" }));
      first.resolve(response(1, { hasMore: true, total: 100 }));
      await Promise.all(pending);
    });
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([3]);
    expect(result.current.searchExactTotal).toBe(1);
    expect(result.current.searchIncomplete).toBe(false);
    expect(result.current.searchHasMore).toBe(false);
    expect(result.current.searchLoading).toBe(false);
  });

  it("does not restore results or continuation metadata after clearing a pending page", async () => {
    const page = deferred<SearchResponse>();
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "page-2" })
      )
      .mockReturnValueOnce(page.promise);
    const { result, options } = setup();
    await act(() => result.current.handleSearch("photo"));
    act(() => result.current.loadMoreSearchResults());
    expect(mocks.runSearch).toHaveBeenLastCalledWith({
      cursor: "page-2",
      limit: 100,
      query: "photo",
    });
    act(() => result.current.resetHomeSearchState());
    await act(async () => {
      page.resolve(response(2, { completion: "partial", hasMore: true }));
      await page.promise;
    });
    expect(result.current.searchResults).toBeNull();
    expect(result.current.searchExactTotal).toBeNull();
    expect(result.current.searchHasMore).toBe(false);
    expect(result.current.isFetchingSearchNextPage).toBe(false);
    expect(options.saveBrowseSession).toHaveBeenLastCalledWith(
      "home-search",
      expect.objectContaining({ searchMode: null, imageSearchPath: null })
    );
  });

  it("keeps image results and clears text completion state when modes change", async () => {
    const text = deferred<SearchResponse>();
    mocks.runSearch.mockReturnValue(text.promise);
    mocks.imageSearch.mockResolvedValue({ results: [{ id: 9 }] });
    const { result, options } = setup();
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.handleSearch("text");
    });
    await act(() => result.current.handleImageSearch("D:/reference.png"));
    await act(async () => {
      text.resolve(response(1, { completion: "partial", hasMore: true }));
      await pending;
    });
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([9]);
    expect(result.current.searchIncomplete).toBe(false);
    expect(result.current.imageSearchPreviewDataUrl).toContain("preview");
    expect(options.filter.applySearch).toHaveBeenLastCalledWith({
      filters: {},
      imagePath: "D:/reference.png",
      mode: "image",
      query: "",
    });
  });

  it("preserves committed results and marks an expired cursor as incomplete", async () => {
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "expired" })
      )
      .mockResolvedValueOnce({ cursorExpired: true, results: [] });
    const { result } = setup();
    await act(() => result.current.handleSearch("photo"));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchIncomplete).toBe(true));
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([1]);
    expect(result.current.searchHasMore).toBe(false);
    expect(result.current.searchExactTotal).toBeNull();
  });
});
