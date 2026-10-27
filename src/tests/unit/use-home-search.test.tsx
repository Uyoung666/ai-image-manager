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
  listSequences: vi.fn(),
  error: vi.fn(),
}));

vi.mock("@/hooks/use-photo-search", () => ({ usePhotoSearch: () => mocks }));
vi.mock("@/actions/photo-sequences", () => ({
  photoSequenceActions: { list: mocks.listSequences },
}));
vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: mocks.error } }));
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
  mocks.listSequences.mockReset().mockResolvedValue([]);
  mocks.imageSearch.mockReset();
  mocks.getPreview.mockReset().mockResolvedValue({
    dataUrl: "data:image/png;base64,preview",
    exists: true,
  });
});

describe("home search orchestration", () => {
  it("refreshes multiple loaded pages using the frozen session's stable cursor", async () => {
    mocks.runSearch
      .mockResolvedValueOnce(response(1, { hasMore: true, nextCursor: "old" }))
      .mockResolvedValueOnce(response(2, { hasMore: true, nextCursor: "old" }))
      .mockResolvedValueOnce(response(3, { hasMore: true, nextCursor: "old" }));
    const { result } = setup();
    await act(() => result.current.handleSearch("photo"));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchResults).toHaveLength(2));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchResults).toHaveLength(3));
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "fresh" })
      )
      .mockResolvedValueOnce(
        response(4, { hasMore: true, nextCursor: "fresh" })
      )
      .mockResolvedValueOnce(
        response(5, { hasMore: true, nextCursor: "fresh" })
      );
    act(() => result.current.refreshSearchAfterTags());
    await waitFor(() =>
      expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([
        1, 4, 5,
      ])
    );
    expect(mocks.error).not.toHaveBeenCalled();
    expect(
      mocks.runSearch.mock.calls.slice(3).map(([input]) => input.cursor ?? null)
    ).toEqual([null, "fresh", "fresh"]);
  });

  it("coalesces tag edits, rebuilds the loaded prefix and commits only after sequence ownership is ready", async () => {
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "old-2" })
      )
      .mockResolvedValueOnce(
        response(2, { hasMore: true, nextCursor: "old-3" })
      )
      .mockResolvedValueOnce(
        response(3, { hasMore: true, nextCursor: "old-4" })
      );
    const { result, options } = setup();
    await act(() => result.current.handleSearch("photo"));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchResults).toHaveLength(2));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchResults).toHaveLength(3));
    const key = result.current.searchResultSourceKey;
    const sequences = deferred<never[]>();
    mocks.listSequences.mockReturnValueOnce(sequences.promise);
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "fresh-2" })
      )
      .mockResolvedValueOnce(
        response(3, { hasMore: true, nextCursor: "fresh-3" })
      )
      .mockResolvedValueOnce(
        response(4, { hasMore: true, nextCursor: "fresh-4" })
      );
    act(() => {
      result.current.refreshSearchAfterTags();
      result.current.refreshSearchAfterTags();
      result.current.loadMoreSearchResults();
    });
    expect(mocks.runSearch).toHaveBeenCalledTimes(3);
    expect(result.current.searchLoading).toBe(false);
    expect(result.current.searchRefreshing).toBe(true);
    await waitFor(() =>
      expect(mocks.listSequences).toHaveBeenCalledWith({
        scope: "members",
        photoIds: [1, 3, 4],
      })
    );
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([
      1, 2, 3,
    ]);
    expect(result.current.searchResultSourceKey).toBe(key);
    await act(async () => {
      sequences.resolve([]);
      await sequences.promise;
    });
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([
      1, 3, 4,
    ]);
    expect(result.current.searchResultSourceKey).toBe(key);
    expect(result.current.searchRefreshing).toBe(false);
    expect(options.filter.applySearch).toHaveBeenCalledTimes(1);
    expect(
      mocks.runSearch.mock.calls.slice(3).map(([input]) => input.cursor ?? null)
    ).toEqual([null, "fresh-2", "fresh-3"]);
    mocks.runSearch.mockResolvedValueOnce(response(5));
    act(() => result.current.loadMoreSearchResults());
    await waitFor(() => expect(result.current.searchResults).toHaveLength(4));
    expect(mocks.runSearch).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: "fresh-4" })
    );
  });

  it("discards a delayed tag refresh when the user starts another search", async () => {
    const old = deferred<SearchResponse>();
    mocks.runSearch
      .mockResolvedValueOnce(response(1))
      .mockReturnValueOnce(old.promise);
    const { result } = setup();
    await act(() => result.current.handleSearch("old"));
    act(() => result.current.refreshSearchAfterTags());
    await waitFor(() => expect(mocks.runSearch).toHaveBeenCalledTimes(2));
    mocks.runSearch.mockResolvedValueOnce(response(9));
    await act(() => result.current.handleSearch("new"));
    const key = result.current.searchResultSourceKey;
    await act(async () => {
      old.resolve(response(2));
      await old.promise;
    });
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([9]);
    expect(result.current.searchResultSourceKey).toBe(key);
    expect(mocks.listSequences).not.toHaveBeenCalled();
  });

  it("keeps committed results and blocks stale pagination after a failed refresh, then retries", async () => {
    mocks.runSearch
      .mockResolvedValueOnce(
        response(1, { hasMore: true, nextCursor: "stale" })
      )
      .mockRejectedValueOnce(new Error("offline"));
    const { result } = setup();
    await act(() => result.current.handleSearch("photo"));
    const key = result.current.searchResultSourceKey;
    act(() => result.current.refreshSearchAfterTags());
    await waitFor(() => expect(mocks.error).toHaveBeenCalledOnce());
    expect(result.current.searchResults?.map((photo) => photo.id)).toEqual([1]);
    expect(result.current.searchResultSourceKey).toBe(key);
    expect(result.current.searchHasMore).toBe(false);
    mocks.runSearch.mockResolvedValueOnce(response(2));
    act(() => mocks.error.mock.calls[0][1].action.onClick());
    await waitFor(() => expect(result.current.searchResults?.[0]?.id).toBe(2));
    expect(result.current.searchResultSourceKey).toBe(key);
  });

  it("commits an empty refreshed result without changing its display identity", async () => {
    mocks.runSearch
      .mockResolvedValueOnce(response(1))
      .mockResolvedValueOnce(response(0, { results: [], total: 0 }));
    const { result } = setup();
    await act(() => result.current.handleSearch("photo"));
    const key = result.current.searchResultSourceKey;
    act(() => result.current.refreshSearchAfterTags());
    await waitFor(() => expect(result.current.searchResults).toEqual([]));
    expect(result.current.searchResultSourceKey).toBe(key);
    expect(result.current.searchExactTotal).toBe(0);
    expect(result.current.preparedSearchSequences?.sequences).toEqual([]);
  });

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
