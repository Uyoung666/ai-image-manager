import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePhotos } from "@/hooks/usePhotos";
import {
  clearGalleryContexts,
  getGalleryPhotoSourceKey,
} from "@/utils/gallery-data-source";

const state = vi.hoisted(() => ({ revision: 1, ids: [1, 2] }));
vi.mock("@/actions/photo-listing", () => ({
  photoListingActions: {
    page: vi.fn(async () => ({
      items: state.ids.map((id) => ({
        id,
        path: `C:/fixture/${id}.jpg`,
        filename: `${id}.jpg`,
        width: 100,
        height: 100,
        isFavorite: true,
        thumbnailPath: null,
      })),
      revision: state.revision,
      geometryRevision: 1,
      total: state.ids.length,
      totalAll: state.ids.length,
      nextCursor: null,
      queryMs: 1,
    })),
    byIds: vi.fn(async () => []),
  },
}));
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
});
