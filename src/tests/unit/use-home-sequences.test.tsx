import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type PreparedSearchSequences,
  useHomeSequenceQuery,
} from "@/features/home/use-home-sequence-query";
import type { PhotoSequence } from "@/types/photo-sequence";

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  t: (key: string) => key,
}));
vi.mock("@/actions/photo-sequences", () => ({ photoSequenceActions: mocks }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: mocks.t }),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function sequence(matchedPhotoIds: number[]): PhotoSequence {
  return {
    id: 10,
    matchedCount: matchedPhotoIds.length,
    matchedPhotoIds,
    memberPhotoIds: [1, 2, 3],
    photo: { id: 1 },
  } as PhotoSequence;
}

function options(folderId = 7) {
  return {
    filter: {
      activeFolderId: folderId,
      activeTagIds: [],
      favoriteOnly: false,
      tagMode: "or",
    } as Parameters<typeof useHomeSequenceQuery>[0]["filter"],
    isSearching: false,
    searchResultGeneration: 0,
    searchResultSourceKey: null as string | null,
    sequencePhotoIds: [] as number[],
  };
}

beforeEach(() => mocks.list.mockReset());

describe("home sequence query", () => {
  it("keeps confirmed ownership on a same-scope refresh failure but clears it on a failed folder change", async () => {
    mocks.list
      .mockResolvedValueOnce([sequence([1])])
      .mockRejectedValueOnce(new Error("same-scope refresh failed"))
      .mockRejectedValueOnce(new Error("new folder failed"));
    const { result, rerender } = renderHook(
      (props) => useHomeSequenceQuery(props),
      { initialProps: options(7) }
    );
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    act(() => result.current.setSequenceRefresh((value) => value + 1));
    await waitFor(() => expect(result.current.sequenceError).toBeTruthy());
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([1]);
    expect(result.current.sequenceViewReady).toBe(false);
    rerender(options(8));
    await waitFor(() => expect(result.current.sequenceError).toBeTruthy());
    expect(result.current.sequences).toEqual([]);
  });
  it("adopts prepared tag-refresh ownership immediately without another loading phase or request", async () => {
    mocks.list
      .mockResolvedValueOnce([sequence([1, 2])])
      .mockResolvedValueOnce([sequence([3])]);
    const initial = {
      ...options(),
      isSearching: true,
      searchResultGeneration: 1,
      searchResultSourceKey: "stable",
      sequencePhotoIds: [1, 2],
      preparedSearchSequences: null as PreparedSearchSequences | null,
    };
    const { result, rerender } = renderHook(
      (props) => useHomeSequenceQuery(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    const refreshed = {
      ...initial,
      searchResultGeneration: 2,
      sequencePhotoIds: [2],
      preparedSearchSequences: {
        generation: 2,
        photoIds: [2],
        sequences: [sequence([2])],
      },
    };
    rerender(refreshed);
    expect(result.current.sequenceViewReady).toBe(true);
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([2]);
    expect(mocks.list).toHaveBeenCalledTimes(1);
    rerender({ ...refreshed, sequencePhotoIds: [2, 3] });
    await waitFor(() => expect(mocks.list).toHaveBeenCalledTimes(2));
    expect(mocks.list).toHaveBeenLastCalledWith({
      scope: "members",
      photoIds: [3],
    });
  });
  it("discovers sequences across the complete filtered gallery", async () => {
    mocks.list.mockResolvedValue([sequence([1, 2, 3])]);
    const initial = options();
    const { result } = renderHook(() => useHomeSequenceQuery(initial));
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    expect(mocks.list).toHaveBeenCalledExactlyOnceWith({
      favoriteOnly: undefined,
      folderId: 7,
      scope: "gallery",
      tagIds: undefined,
      tagMode: "or",
    });
    expect(result.current.sequenceCount).toBe(1);
  });

  it("merges appended search matches in member order without fetching the prefix again", async () => {
    const appended = deferred<PhotoSequence[]>();
    mocks.list
      .mockResolvedValueOnce([sequence([1, 2])])
      .mockReturnValueOnce(appended.promise);
    const initial = {
      ...options(),
      isSearching: true,
      searchResultGeneration: 1,
      searchResultSourceKey: "generation-1",
      sequencePhotoIds: [1, 2],
    };
    const { result, rerender } = renderHook(
      (props) => useHomeSequenceQuery(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    rerender({ ...initial, sequencePhotoIds: [1, 2, 3] });
    expect(mocks.list).toHaveBeenLastCalledWith({
      photoIds: [3],
      scope: "members",
    });
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([1, 2]);
    await act(async () => {
      appended.resolve([sequence([3])]);
      await appended.promise;
    });
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([1, 2, 3]);
    expect(result.current.sequences[0].matchedCount).toBe(3);
  });

  it("rejects old folder results after switching the gallery scope", async () => {
    const old = deferred<PhotoSequence[]>();
    mocks.list.mockReturnValueOnce(old.promise).mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      (props) => useHomeSequenceQuery(props),
      { initialProps: options(7) }
    );
    rerender(options(8));
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    await act(async () => {
      old.resolve([sequence([1])]);
      await old.promise;
    });
    expect(result.current.sequences).toEqual([]);
    expect(result.current.sequenceCount).toBe(0);
  });

  it("retains confirmed sequences when an appended query fails", async () => {
    const appended = deferred<PhotoSequence[]>();
    mocks.list
      .mockResolvedValueOnce([sequence([1])])
      .mockReturnValueOnce(appended.promise);
    const initial = {
      ...options(),
      isSearching: true,
      searchResultGeneration: 1,
      searchResultSourceKey: "generation-1",
      sequencePhotoIds: [1],
    };
    const { result, rerender } = renderHook(
      (props) => useHomeSequenceQuery(props),
      { initialProps: initial }
    );
    await waitFor(() => expect(result.current.sequenceViewReady).toBe(true));
    rerender({ ...initial, sequencePhotoIds: [1, 2] });
    await act(async () => {
      appended.reject(new Error("offline"));
      await appended.promise.catch(() => undefined);
    });
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([1]);
    expect(result.current.sequenceError).toBeTruthy();
  });
});
