import { describe, expect, it, vi } from "vitest";
import type { Photo } from "@/types/photo";
import type {
  PhotoSequence,
  PhotoSequenceDetail,
} from "@/types/photo-sequence";
import { resolveSequenceSelection } from "@/utils/sequence-selection";

const photos = [{ id: 1, isFavorite: true }] as Photo[];
const sequences = [
  { id: 10, matchedPhotoIds: [1, 2], memberPhotoIds: [1, 2, 3] },
] as PhotoSequence[];

describe("sequence selection resolution", () => {
  it("loads missing selected members and keeps their real favorite state", async () => {
    const load = vi.fn().mockResolvedValue({
      members: [
        ...photos,
        { id: 2, isFavorite: true },
        { id: 3, isFavorite: false },
      ],
    });
    const result = await resolveSequenceSelection(
      [1, 2],
      photos,
      sequences,
      load
    );
    expect(result.map((photo) => photo.id)).toEqual([1, 2]);
    expect(result.every((photo) => photo.isFavorite)).toBe(true);
    expect(load).toHaveBeenCalledOnce();
  });
  it("does not load details for fully loaded selections", async () => {
    const load = vi.fn();
    expect(
      await resolveSequenceSelection([1], photos, sequences, load)
    ).toEqual(photos);
    expect(load).not.toHaveBeenCalled();
  });
  it("rejects out-of-scope or unavailable members before a mutation", async () => {
    const load = vi
      .fn()
      .mockResolvedValue({ members: [{ id: 3 }] } as PhotoSequenceDetail);
    await expect(
      resolveSequenceSelection([2, 3], photos, sequences, load)
    ).rejects.toThrow("unavailable");
  });
  it("propagates a failed detail query", async () => {
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    await expect(
      resolveSequenceSelection([2], photos, sequences, load)
    ).rejects.toThrow("offline");
  });
});
