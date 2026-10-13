import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useHomeBatchFavorite } from "@/features/home/use-home-batch-favorite";
import type { Photo } from "@/types/photo";

const mocks = vi.hoisted(() => ({ setPhotoFavorites: vi.fn() }));
vi.mock("@/actions/photo-favorites", () => mocks);

function options() {
  return {
    applyFavoriteState: vi.fn(),
    displayedSequenceMode: "sequences" as const,
    selectedIds: new Set([1, 2]),
    selectionReady: true,
    sequenceQuerySourceKey: "folder-1",
    sequenceSelection: {
      allFavorite: false,
      resolvedPhotos: [],
      resolvePhotos: vi.fn(),
      updateFavorites: vi.fn(),
    },
    visibleSelectionIds: [1, 2],
  };
}

beforeEach(() => mocks.setPhotoFavorites.mockReset().mockResolvedValue({}));

describe("home batch favorite", () => {
  it("abandons resolved members when the scope changes during resolution", async () => {
    let resolve!: (photos: Photo[]) => void;
    const initial = options();
    initial.sequenceSelection.resolvePhotos.mockReturnValue(
      new Promise<Photo[]>((done) => {
        resolve = done;
      })
    );
    const { result, rerender } = renderHook(
      (props) => useHomeBatchFavorite(props),
      { initialProps: initial }
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current();
    });
    rerender({ ...initial, sequenceQuerySourceKey: "folder-2" });
    await act(async () => {
      resolve([{ id: 1 }, { id: 2 }] as Photo[]);
      await pending;
    });
    expect(mocks.setPhotoFavorites).not.toHaveBeenCalled();
    expect(initial.applyFavoriteState).not.toHaveBeenCalled();
  });

  it("does not apply an incomplete or out-of-scope member set", async () => {
    const initial = options();
    initial.sequenceSelection.resolvePhotos
      .mockRejectedValueOnce(new Error("member unavailable"))
      .mockResolvedValueOnce([{ id: 1 }, { id: 99 }]);
    const { result } = renderHook(() => useHomeBatchFavorite(initial));
    await act(() => result.current());
    await act(() => result.current());
    expect(mocks.setPhotoFavorites).not.toHaveBeenCalled();
  });

  it("applies a complete resolved batch once and updates its visible state", async () => {
    const initial = options();
    initial.sequenceSelection.resolvePhotos.mockResolvedValue([
      { id: 1, isFavorite: true },
      { id: 2, isFavorite: false },
    ]);
    const { result } = renderHook(() => useHomeBatchFavorite(initial));
    await act(() => result.current());
    expect(mocks.setPhotoFavorites).toHaveBeenCalledExactlyOnceWith(
      [1, 2],
      true
    );
    expect(initial.applyFavoriteState).toHaveBeenCalledExactlyOnceWith(
      [1, 2],
      true
    );
  });
});
