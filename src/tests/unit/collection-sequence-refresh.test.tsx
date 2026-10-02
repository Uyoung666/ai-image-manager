import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useCollectionSequences } from "@/hooks/useCollectionSequences";
import type { Photo } from "@/types/photo";
import type { PhotoSequence } from "@/types/photo-sequence";

const { list, get } = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock("@/ipc/manager", () => ({
  ipc: { client: { photos: { listSequences: list, getSequence: get } } },
}));

const photos = [{ id: 1 }, { id: 2 }, { id: 3 }] as Photo[];
const sequences = [
  {
    id: 10,
    photo: photos[0],
    matchedPhoto: photos[0],
    matchedPhotoIds: [1, 2],
  },
] as PhotoSequence[];
const options = {
  onClearSelection: vi.fn(),
  onRemoveSelection: vi.fn(),
  storageKey: "sequence-refresh-test",
};

beforeEach(() => {
  list.mockReset();
  get.mockReset();
  localStorage.clear();
});

describe("collection sequence refresh", () => {
  it("preserves a known favorite flag when the collection omits it after navigation", async () => {
    list.mockResolvedValue(
      sequences.map((sequence) => ({
        ...sequence,
        photo: { ...sequence.photo, isFavorite: true },
        matchedPhoto: { ...sequence.matchedPhoto, isFavorite: true },
      }))
    );
    get.mockResolvedValue({
      id: 10,
      members: [
        { ...photos[0], isFavorite: true },
        { ...photos[1], isFavorite: false },
      ],
    });
    const { result, rerender } = renderHook(
      ({ items }) => useCollectionSequences({ ...options, photos: items }),
      { initialProps: { items: photos } }
    );
    await waitFor(() => expect(result.current.sequencesLoading).toBe(false));
    expect(result.current.sequences[0].photo.isFavorite).toBe(true);
    await act(async () => result.current.toggleExpand(10));
    expect(result.current.expandedSequence?.members[0].isFavorite).toBe(true);
    expect(result.current.expandedSequence?.members[1].isFavorite).toBe(false);
    await act(async () => result.current.openDetails(10));
    expect(result.current.selectedSequence?.members[0].isFavorite).toBe(true);
    await act(async () => result.current.openPlayback(10));
    expect(result.current.openSequence?.members[0].isFavorite).toBe(true);
    await act(async () => result.current.openDetails(10));
    rerender({
      items: photos.map((photo) => ({ ...photo, isFavorite: false })),
    });
    expect(result.current.sequences[0].photo.isFavorite).toBe(false);
    expect(result.current.sequences[0].matchedPhoto?.isFavorite).toBe(false);
    expect(result.current.expandedSequence?.members[0].isFavorite).toBe(false);
    expect(result.current.expandedSequenceComplete?.members[0].isFavorite).toBe(
      false
    );
    expect(result.current.selectedSequence?.members[0].isFavorite).toBe(false);
    expect(result.current.openSequence?.members[0].isFavorite).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });
  it("retains confirmed ownership on refresh failure and recovers on retry", async () => {
    const errorLog = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    list.mockResolvedValueOnce(sequences);
    const { result } = renderHook(() =>
      useCollectionSequences({ ...options, photos })
    );
    await waitFor(() => expect(result.current.sequencesLoading).toBe(false));
    list.mockRejectedValueOnce(new Error("failed"));
    act(() => result.current.refreshSequences());
    await waitFor(() => expect(result.current.sequencesError).toBe(true));
    expect(result.current.sequences).toEqual(sequences);
    expect(result.current.sequencesConfirmed).toBe(true);
    list.mockResolvedValueOnce([]);
    act(() => result.current.refreshSequences());
    await waitFor(() => expect(result.current.sequencesRefreshing).toBe(false));
    expect(result.current.sequences).toEqual([]);
    expect(result.current.sequencesError).toBe(false);
    errorLog.mockRestore();
  });
  it("keeps ownership when photo attributes or presentation order change", async () => {
    list.mockResolvedValue(sequences);
    const { result, rerender } = renderHook(
      ({ items }) => useCollectionSequences({ ...options, photos: items }),
      { initialProps: { items: photos } }
    );
    await waitFor(() => expect(result.current.sequencesLoading).toBe(false));
    rerender({
      items: [...photos]
        .reverse()
        .map((photo) => ({ ...photo, isFavorite: true })),
    });
    expect(result.current.sequences[0].matchedPhotoIds).toEqual([1, 2]);
    expect(result.current.sequences[0].photo.isFavorite).toBe(true);
    expect(result.current.sequences[0].matchedPhoto?.isFavorite).toBe(true);
    expect(result.current.sequencesLoading).toBe(false);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("preserves the confirmed collection during an explicit refresh", async () => {
    list.mockResolvedValueOnce(sequences);
    const { result } = renderHook(() =>
      useCollectionSequences({ ...options, photos })
    );
    await waitFor(() => expect(result.current.sequencesLoading).toBe(false));
    let release: (value: PhotoSequence[]) => void = () => undefined;
    list.mockImplementationOnce(
      () =>
        new Promise<PhotoSequence[]>((resolve) => {
          release = resolve;
        })
    );
    act(() => result.current.refreshSequences());
    expect(result.current.sequences).toEqual(sequences);
    expect(result.current.sequencesLoading).toBe(false);
    await act(async () => release([]));
    expect(result.current.sequences).toEqual([]);
  });

  it("rejects an old response after the collection changes", async () => {
    let release: (value: PhotoSequence[]) => void = () => undefined;
    list.mockImplementationOnce(
      () =>
        new Promise<PhotoSequence[]>((resolve) => {
          release = resolve;
        })
    );
    list.mockResolvedValueOnce([]);
    const { result, rerender } = renderHook(
      ({ items }) => useCollectionSequences({ ...options, photos: items }),
      { initialProps: { items: photos } }
    );
    rerender({ items: [{ id: 4 }] as Photo[] });
    await waitFor(() => expect(result.current.sequencesLoading).toBe(false));
    await act(async () => release(sequences));
    expect(result.current.sequences).toEqual([]);
  });
});
