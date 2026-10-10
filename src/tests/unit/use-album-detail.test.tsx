import { useQuery } from "@tanstack/react-query";
import {
  act,
  render,
  renderHook,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ getAlbum: vi.fn(), error: vi.fn() }));
vi.mock("@/ipc/manager", () => ({
  ipc: { client: { albums: { getAlbum: mocks.getAlbum } } },
}));
vi.mock("sonner", () => ({ toast: { error: mocks.error } }));

import { useAlbumDetail } from "@/hooks/useAlbumDetail";
import { QueryProvider, queryClient } from "@/providers/QueryProvider";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function album(id = 1, isSmart = true, ids = [1, 2]) {
  return {
    id,
    isSmart,
    name: `Album ${id}`,
    coverPhotoId: ids[0] ?? null,
    description: null,
    matchCount: ids.length,
    photos: ids.map((photoId) => ({ id: photoId })),
  };
}

function changeTags() {
  act(() => {
    window.dispatchEvent(new CustomEvent("tags-changed"));
  });
}

function completeAi(channel: string) {
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { source: window, data: { channel } })
    );
  });
}

beforeEach(() => {
  mocks.getAlbum.mockReset();
  mocks.error.mockReset();
  queryClient.clear();
});
afterEach(() => {
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("album detail refresh", () => {
  it("refreshes smart members and cover while keeping content during a request", async () => {
    const next = deferred<ReturnType<typeof album>>();
    mocks.getAlbum
      .mockResolvedValueOnce(album())
      .mockReturnValueOnce(next.promise);
    const { result } = renderHook(() => useAlbumDetail(1));
    await waitFor(() => expect(result.current.album).toEqual(album()));
    changeTags();
    expect(result.current.album).toEqual(album());
    expect(result.current.loading).toBe(false);
    await act(() => {
      next.resolve(album(1, true, [2]));
      return next.promise;
    });
    expect(result.current.album).toEqual(album(1, true, [2]));
  });

  it("does not reload a manual album after tags change", async () => {
    mocks.getAlbum.mockResolvedValue(album(1, false));
    const { result } = renderHook(() => useAlbumDetail(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    changeTags();
    completeAi("ai-tags-done");
    expect(mocks.getAlbum).toHaveBeenCalledTimes(1);
  });

  it.each([
    "ai-tags-done",
    "ai-embedding-done",
  ])("refreshes after %s", async (channel) => {
    mocks.getAlbum
      .mockResolvedValueOnce(album())
      .mockResolvedValueOnce(album(1, true, []));
    const { result } = renderHook(() => useAlbumDetail(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    completeAi(channel);
    await waitFor(() => expect(result.current.album?.photos).toEqual([]));
  });

  it("ignores a delayed refresh after a newer tag mutation", async () => {
    const old = deferred<ReturnType<typeof album>>();
    mocks.getAlbum
      .mockResolvedValueOnce(album())
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(album(1, true, []));
    const { result } = renderHook(() => useAlbumDetail(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    changeTags();
    changeTags();
    await waitFor(() => expect(result.current.album?.photos).toEqual([]));
    await act(() => {
      old.resolve(album());
      return old.promise;
    });
    expect(result.current.album?.photos).toEqual([]);
  });

  it("replaces an initial request that predates a tag mutation", async () => {
    const old = deferred<ReturnType<typeof album>>();
    mocks.getAlbum
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(album(1, true, []));
    const { result } = renderHook(() => useAlbumDetail(1));
    changeTags();
    await waitFor(() => expect(result.current.album?.photos).toEqual([]));
    await act(() => {
      old.resolve(album());
      return old.promise;
    });
    expect(result.current.album?.photos).toEqual([]);
  });

  it("ignores an old album response after switching albums", async () => {
    const old = deferred<ReturnType<typeof album>>();
    mocks.getAlbum
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce(album(2));
    const { result, rerender } = renderHook(useAlbumDetail, {
      initialProps: 1,
    });
    rerender(2);
    await waitFor(() => expect(result.current.album?.id).toBe(2));
    await act(() => {
      old.resolve(album(1));
      return old.promise;
    });
    expect(result.current.album?.id).toBe(2);
  });

  it("keeps photos and reports a failed refresh", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.getAlbum
      .mockResolvedValueOnce(album())
      .mockRejectedValueOnce(new Error("fixture failure"));
    const { result } = renderHook(() => useAlbumDetail(1));
    await waitFor(() => expect(result.current.loading).toBe(false));
    changeTags();
    await waitFor(() =>
      expect(mocks.error).toHaveBeenCalledWith("加载失败，请重试")
    );
    expect(result.current.album).toEqual(album());
    expect(result.current.loading).toBe(false);
  });

  it("ignores a previous album's action completing after navigation or unmount", async () => {
    mocks.getAlbum
      .mockResolvedValueOnce(album(1))
      .mockResolvedValueOnce(album(2));
    const { result, rerender, unmount } = renderHook(useAlbumDetail, {
      initialProps: 1,
    });
    await waitFor(() => expect(result.current.album?.id).toBe(1));
    const oldRefresh = result.current.loadAlbum;
    rerender(2);
    await waitFor(() => expect(result.current.album?.id).toBe(2));
    await act(oldRefresh);
    expect(result.current.album?.id).toBe(2);
    const currentRefresh = result.current.loadAlbum;
    unmount();
    await act(currentRefresh);
    expect(mocks.getAlbum).toHaveBeenCalledTimes(2);
  });

  it("survives StrictMode replay and removes subscriptions on unmount", async () => {
    const old = deferred<ReturnType<typeof album>>();
    mocks.getAlbum
      .mockReturnValueOnce(old.promise)
      .mockResolvedValue(album(1, true, []));
    const { result, unmount } = renderHook(() => useAlbumDetail(1), {
      wrapper: StrictMode,
    });
    await waitFor(() => expect(result.current.album?.photos).toEqual([]));
    await act(() => {
      old.resolve(album());
      return old.promise;
    });
    expect(result.current.album?.photos).toEqual([]);
    unmount();
    changeTags();
    completeAi("ai-tags-done");
    expect(mocks.getAlbum).toHaveBeenCalledTimes(2);
  });
});

describe("album list invalidation", () => {
  it("marks an inactive list stale for immediate return from another page", async () => {
    queryClient.setQueryData(["albums"], [{ coverPhotoId: 1 }]);
    render(
      <QueryProvider>
        <div />
      </QueryProvider>
    );
    changeTags();
    await waitFor(() =>
      expect(queryClient.getQueryState(["albums"])?.isInvalidated).toBe(true)
    );
  });

  it.each([
    "tags-changed",
    "ai-tags-done",
    "ai-embedding-done",
  ])("refreshes an active list on %s", async (channel) => {
    const load = vi
      .fn()
      .mockResolvedValueOnce("old cover")
      .mockResolvedValueOnce("new cover");
    function List() {
      const { data } = useQuery({ queryKey: ["albums"], queryFn: load });
      return <div>{data}</div>;
    }
    render(
      <QueryProvider>
        <List />
      </QueryProvider>
    );
    await screen.findByText("old cover");
    if (channel === "tags-changed") {
      changeTags();
    } else {
      completeAi(channel);
    }
    await screen.findByText("new cover");
  });

  it("cancels an initial list request so its old cover cannot refill the cache", async () => {
    const old = deferred<string>();
    const load = vi
      .fn()
      .mockReturnValueOnce(old.promise)
      .mockResolvedValueOnce("new cover");
    function List() {
      const { data } = useQuery({ queryKey: ["albums"], queryFn: load });
      return <div>{data}</div>;
    }
    render(
      <QueryProvider>
        <List />
      </QueryProvider>
    );
    changeTags();
    await screen.findByText("new cover");
    await act(() => {
      old.resolve("old cover");
      return old.promise;
    });
    expect(screen.queryByText("old cover")).not.toBeInTheDocument();
  });
});
