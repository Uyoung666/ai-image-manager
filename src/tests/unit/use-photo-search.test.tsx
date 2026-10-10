import { act, render, renderHook, waitFor } from "@testing-library/react";
import { StrictMode, useEffect, useRef } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { searchPhotos } from "@/actions/photo-search";
import { usePhotoSearch } from "@/hooks/use-photo-search";

const mocks = vi.hoisted(() => ({
  cancelPhotoSearch: vi.fn(),
  searchPhotos: vi.fn(),
}));

vi.mock("@/actions/photo-search", () => mocks);

type SearchResponse = Awaited<ReturnType<typeof searchPhotos>>;

const completeResponse: SearchResponse = {
  completion: "complete",
  results: [],
  total: 0,
  totalExact: true,
};

const cancelledResponse: SearchResponse = {
  completion: "cancelled",
  incompleteReason: "cancelled",
  results: [],
  total: 0,
  totalExact: false,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function DrillDown({
  onResult,
}: {
  onResult: (response: SearchResponse) => void;
}) {
  const consumed = useRef(false);
  const { runSearch } = usePhotoSearch();
  useEffect(() => {
    if (consumed.current) {
      return;
    }
    consumed.current = true;
    runSearch({ colorHex: "2458d3", limit: 100 }).then(onResult);
  }, [onResult, runSearch]);
  return null;
}

beforeEach(() => {
  mocks.searchPhotos.mockReset();
  mocks.cancelPhotoSearch.mockReset().mockResolvedValue({ cancelled: true });
});

describe("photo search request lifetime", () => {
  it("keeps the first drill-down request alive across StrictMode effect replay", async () => {
    const request = deferred<SearchResponse>();
    const onResult = vi.fn();
    mocks.searchPhotos.mockReturnValue(request.promise);
    mocks.cancelPhotoSearch.mockImplementation(() => {
      request.resolve(cancelledResponse);
      return Promise.resolve({ cancelled: true });
    });

    render(
      <StrictMode>
        <DrillDown onResult={onResult} />
      </StrictMode>
    );
    await act(async () => {
      await Promise.resolve();
    });

    expect(mocks.searchPhotos).toHaveBeenCalledExactlyOnceWith({
      colorHex: "2458d3",
      limit: 100,
      requestId: expect.any(String),
    });
    expect(mocks.cancelPhotoSearch).not.toHaveBeenCalled();

    await act(async () => {
      request.resolve(completeResponse);
      await request.promise;
    });
    expect(onResult).toHaveBeenCalledExactlyOnceWith(completeResponse);
  });

  it("cancels an unfinished request after a real unmount", async () => {
    const request = deferred<SearchResponse>();
    mocks.searchPhotos.mockReturnValue(request.promise);
    const { result, unmount } = renderHook(() => usePhotoSearch(), {
      wrapper: StrictMode,
    });
    const response = result.current.runSearch({ colorHex: "2458d3" });
    const requestId = mocks.searchPhotos.mock.calls[0][0].requestId;

    unmount();
    await waitFor(() =>
      expect(mocks.cancelPhotoSearch).toHaveBeenCalledExactlyOnceWith(requestId)
    );
    request.resolve(cancelledResponse);
    await expect(response).resolves.toEqual(cancelledResponse);
  });

  it("immediately cancels the old request when a new search starts", async () => {
    const first = deferred<SearchResponse>();
    const second = deferred<SearchResponse>();
    mocks.searchPhotos
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const { result } = renderHook(() => usePhotoSearch());
    const oldResponse = result.current.runSearch({ colorHex: "2458d3" });
    const firstRequestId = mocks.searchPhotos.mock.calls[0][0].requestId;
    const newResponse = result.current.runSearch({ colorHex: "ff0000" });
    const secondRequestId = mocks.searchPhotos.mock.calls[1][0].requestId;

    expect(secondRequestId).not.toBe(firstRequestId);
    expect(mocks.cancelPhotoSearch).toHaveBeenCalledExactlyOnceWith(
      firstRequestId
    );

    first.resolve(cancelledResponse);
    second.resolve(completeResponse);
    await expect(oldResponse).resolves.toEqual(cancelledResponse);
    await expect(newResponse).resolves.toEqual(completeResponse);
    result.current.cancelPending();
    expect(mocks.cancelPhotoSearch).toHaveBeenCalledTimes(1);
  });

  it("preserves explicit cancellation and ignores finished requests on unmount", async () => {
    const request = deferred<SearchResponse>();
    mocks.searchPhotos.mockReturnValue(request.promise);
    const { result, unmount } = renderHook(() => usePhotoSearch());
    const response = result.current.runSearch({ query: "beach" });
    const requestId = mocks.searchPhotos.mock.calls[0][0].requestId;

    result.current.cancelPending();
    expect(mocks.cancelPhotoSearch).toHaveBeenCalledExactlyOnceWith(requestId);
    request.resolve(cancelledResponse);
    await response;
    unmount();
    await Promise.resolve();
    expect(mocks.cancelPhotoSearch).toHaveBeenCalledTimes(1);
  });
});
