import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSequenceSelectionPhotos } from "@/hooks/useSequenceSelectionPhotos";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock("@/actions/photo-sequences", () => ({ photoSequenceActions: { get } }));
const photos = [{ id: 1, isFavorite: true }] as Photo[];
const sequences = [{ id: 10, matchedPhotoIds: [1, 2] }] as PhotoSequence[];
const detail = {
  id: 10,
  members: [...photos, { id: 2, isFavorite: true }],
} as PhotoSequenceDetail;
beforeEach(() => {
  get.mockReset();
});

describe("sequence selection photo resolution", () => {
  it("waits for missing members before reporting all selected photos as favorite", async () => {
    let release: (value: PhotoSequenceDetail) => void = () => undefined;
    get.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const ids = new Set([1, 2]);
    const { result } = renderHook(() =>
      useSequenceSelectionPhotos(ids, photos, sequences)
    );
    expect(result.current.allFavorite).toBe(false);
    await act(async () => release(detail));
    expect(result.current.allFavorite).toBe(true);
    act(() => result.current.updateFavorites([2], false));
    expect(result.current.allFavorite).toBe(false);
  });

  it("rejects a late detail result when the selected scope changes", async () => {
    let release: (value: PhotoSequenceDetail) => void = () => undefined;
    get.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        })
    );
    const { result, rerender } = renderHook(
      ({ ids }) => useSequenceSelectionPhotos(ids, photos, sequences),
      {
        initialProps: { ids: new Set([2]) },
      }
    );
    rerender({ ids: new Set([1]) });
    await waitFor(() => expect(result.current.resolvedPhotos).toEqual(photos));
    await act(async () => release(detail));
    expect(result.current.resolvedPhotos).toEqual(photos);
  });

  it("keeps failed detail loading from returning an incomplete batch", async () => {
    get.mockRejectedValue(new Error("unavailable"));
    const ids = new Set([1, 2]);
    const { result } = renderHook(() =>
      useSequenceSelectionPhotos(ids, photos, sequences)
    );
    await act(async () => undefined);
    expect(result.current.allFavorite).toBe(false);
    await expect(result.current.resolvePhotos()).rejects.toThrow("unavailable");
  });
});
