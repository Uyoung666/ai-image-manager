import { describe, expect, it } from "vitest";
import { getSequencePhotoPairIds } from "@/ipc/photos/handlers/stats";

describe("duplicate sequence filter", () => {
  const sequenceByPhoto = new Map([
    [1, 10],
    [2, 10],
    [3, 20],
  ]);

  it("excludes every cached pair that contains a sequence photo", () => {
    expect(
      getSequencePhotoPairIds(
        [
          { id: 1, photoAId: 1, photoBId: 2 },
          { id: 2, photoAId: 1, photoBId: 2 },
          { id: 3, photoAId: 1, photoBId: 3 },
          { id: 4, photoAId: 3, photoBId: 99 },
          { id: 5, photoAId: 99, photoBId: 100 },
        ],
        sequenceByPhoto
      )
    ).toEqual([1, 2, 3, 4]);
  });
});
