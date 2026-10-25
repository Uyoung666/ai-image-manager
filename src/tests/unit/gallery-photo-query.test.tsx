import { ORPCError } from "@orpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhotos } from "@/hooks/usePhotos";
import {
  clearGalleryContexts,
  getGalleryPhotoSourceKey,
} from "@/utils/gallery-data-source";

const state = vi.hoisted(() => ({
  revision: 1,
  ids: [1, 2],
  page: vi.fn(),
}));
vi.mock("@/actions/photo-listing", () => ({
  photoListingActions: {
    page: state.page,
    byIds: vi.fn(async () => []),
  },
}));

function pageResponse(
  ids = state.ids,
  revision = state.revision,
  nextCursor: string | null = null,
  geometryRevision = 1
) {
  return {
    items: ids.map((id) => ({
      id,
      path: `C:/fixture/${id}.jpg`,
      filename: `${id}.jpg`,
      width: 100,
      height: 100,
      isFavorite: true,
      thumbnailPath: null,
    })),
    revision,
    geometryRevision,
    total: nextCursor ? 4 : ids.length,
    totalAll: nextCursor ? 4 : ids.length,
    nextCursor,
    queryMs: 1,
  };
}
vi.mock("@/contexts/ScrollPositionContext", () => ({
  useScrollPosition: () => ({
    getScrollPosition: () => undefined,
    saveScrollPosition: vi.fn(),
  }),
}));
let client: QueryClient;
function Wrapper({ children }: { children: ReactNode }) {
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
beforeEach(() => {
  state.revision = 1;
  state.ids = [1, 2];
  state.page.mockReset().mockImplementation(async () => pageResponse());
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});
afterEach(() => {
  client.clear();
  clearGalleryContexts();
});
describe("gallery query generations", () => {
  it("replaces the favorite membership source even when dimensions did not change", async () => {
    const { result } = renderHook(() => usePhotos({ favoriteOnly: true }), {
      wrapper: Wrapper,
    });
    await waitFor(() =>
      expect(
        result.current.data?.pages[0]?.items.map((photo) => photo.id)
      ).toEqual([1, 2])
    );
    const previous = getGalleryPhotoSourceKey(
      result.current.data?.pages[0]?.items[0] ?? {}
    );
    expect(previous).toBeDefined();
    state.revision = 2;
    state.ids = [2, 3];
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["photos"] });
    });
    await waitFor(() =>
      expect(
        result.current.data?.pages[0]?.items.map((photo) => photo.id)
      ).toEqual([2, 3])
    );
    expect(
      getGalleryPhotoSourceKey(result.current.data?.pages[0]?.items[0] ?? {})
    ).not.toBe(previous);
  });
  it("retains ordinary gallery geometry for favorite-only content changes", async () => {
    const { result } = renderHook(() => usePhotos({}), { wrapper: Wrapper });
    await waitFor(() =>
      expect(result.current.data?.pages[0]?.items).toHaveLength(2)
    );
    const previous = getGalleryPhotoSourceKey(
      result.current.data?.pages[0]?.items[0] ?? {}
    );
    expect(previous).toBeDefined();
    state.revision = 2;
    await act(async () => {
      await client.invalidateQueries({ queryKey: ["photos"] });
    });
    expect(
      getGalleryPhotoSourceKey(result.current.data?.pages[0]?.items[0] ?? {})
    ).toBe(previous);
  });

  for (const [name, error] of [
    [
      "structured RPC error",
      new ORPCError("GALLERY_CURSOR_EXPIRED", {
        status: 409,
        message: "The listing changed",
      }),
    ],
    ["legacy message", new Error("GALLERY_CURSOR_EXPIRED")],
  ] as const) {
    it(`recovers from a ${name} without retrying the expired cursor`, async () => {
      client = new QueryClient({
        defaultOptions: { queries: { retry: 1, retryDelay: 0 } },
      });
      state.page
        .mockResolvedValueOnce(pageResponse([1, 2], 1, "old-cursor", 1))
        .mockRejectedValueOnce(error)
        .mockResolvedValueOnce(pageResponse([1, 2], 2, "fresh-cursor", 2))
        .mockResolvedValueOnce(pageResponse([3, 4], 2, null, 2));
      const { result } = renderHook(() => usePhotos({}), {
        wrapper: Wrapper,
      });
      await waitFor(() => expect(result.current.hasNextPage).toBe(true));
      const previous = getGalleryPhotoSourceKey(
        result.current.data?.pages[0]?.items[0] ?? {}
      );
      await act(async () => {
        await result.current.fetchNextPage();
      });
      await waitFor(() =>
        expect(result.current.data?.pages[0]?.revision).toBe(2)
      );
      expect(state.page).toHaveBeenCalledTimes(3);
      expect(state.page.mock.calls.map(([input]) => input.cursor)).toEqual([
        null,
        "old-cursor",
        null,
      ]);
      expect(
        getGalleryPhotoSourceKey(result.current.data?.pages[0]?.items[0] ?? {})
      ).not.toBe(previous);
      await act(async () => {
        await result.current.fetchNextPage();
      });
      await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
      expect(
        result.current.data?.pages.flatMap((page) =>
          page.items.map((photo) => photo.id)
        )
      ).toEqual([1, 2, 3, 4]);
      expect(state.page.mock.calls[3][0].cursor).toBe("fresh-cursor");
      expect(result.current.error).toBeNull();
      expect(result.current.hasNextPage).toBe(false);
    });
  }

  it("keeps configured retries for a transient page failure", async () => {
    const error = new Error("Temporary failure");
    const retry = vi.fn((failureCount: number) => failureCount < 1);
    client = new QueryClient({
      defaultOptions: { queries: { retry, retryDelay: 0 } },
    });
    const reset = vi.spyOn(client, "resetQueries");
    state.page
      .mockResolvedValueOnce(pageResponse([1, 2], 1, "next-page"))
      .mockRejectedValueOnce(error)
      .mockResolvedValueOnce(pageResponse([3, 4]));
    const { result } = renderHook(() => usePhotos({}), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.data?.pages).toHaveLength(2));
    expect(retry).toHaveBeenCalledWith(0, error);
    expect(state.page).toHaveBeenCalledTimes(3);
    expect(reset).not.toHaveBeenCalled();
    expect(result.current.error).toBeNull();
  });

  it("retains loaded pages and the visible error when an unrelated failure is final", async () => {
    const reset = vi.spyOn(client, "resetQueries");
    const error = new ORPCError("INTERNAL_SERVER_ERROR");
    state.page
      .mockResolvedValueOnce(pageResponse([1, 2], 1, "next-page"))
      .mockRejectedValueOnce(error);
    const { result } = renderHook(() => usePhotos({}), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.hasNextPage).toBe(true));
    await act(async () => {
      await result.current.fetchNextPage();
    });
    await waitFor(() => expect(result.current.error).toBe(error));
    expect(result.current.data?.pages).toHaveLength(1);
    expect(state.page).toHaveBeenCalledTimes(2);
    expect(reset).not.toHaveBeenCalled();
  });
});
