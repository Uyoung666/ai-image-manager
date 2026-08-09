import { describe, expect, it } from "vitest";
import {
  createExactDuplicatePairs,
  type DuplicatePairRecord,
  type DuplicatePhoto,
  groupDuplicatePairs,
  recommendDuplicateKeeper,
  validateDuplicateCleanupGroup,
} from "@/services/duplicate-groups";

const RETAIN_ERROR = /retain at least one/;
const STALE_ERROR = /stale/;
const SINGLE_GROUP_ERROR = /one group/;

function photo(
  id: number,
  overrides: Partial<DuplicatePhoto> = {}
): DuplicatePhoto {
  return {
    id,
    path: `C:\\photos\\${id}.jpg`,
    filename: `${id}.jpg`,
    fileSize: 1000,
    fileDate: 100,
    width: 100,
    height: 100,
    createdAt: 100,
    thumbnailPath: null,
    ...overrides,
  };
}

function pair(
  pairId: number,
  photoA: DuplicatePhoto,
  photoB: DuplicatePhoto,
  overrides: Partial<DuplicatePairRecord> = {}
): DuplicatePairRecord {
  return {
    pairId,
    photoA,
    photoB,
    matchType: "exact",
    distance: 0,
    clipSimilarity: null,
    status: "confirmed",
    ...overrides,
  };
}

describe("duplicate group clustering", () => {
  it("turns all pair combinations of three exact copies into one group", () => {
    const photos = [photo(1), photo(2), photo(3)];
    const groups = groupDuplicatePairs([
      pair(1, photos[0], photos[1]),
      pair(2, photos[0], photos[2]),
      pair(3, photos[1], photos[2]),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].photos.map((item) => item.id)).toEqual([1, 2, 3]);
    expect(groups[0].pairIds).toEqual([1, 2, 3]);
    expect(groups[0].matchType).toBe("exact");
  });

  it("shows ten exact copies once even when every pair is persisted", () => {
    const photos = Array.from({ length: 10 }, (_, index) => photo(index + 1));
    const pairs: DuplicatePairRecord[] = [];
    let pairId = 1;
    for (let i = 0; i < photos.length; i++) {
      for (let j = i + 1; j < photos.length; j++) {
        pairs.push(pair(pairId++, photos[i], photos[j]));
      }
    }

    const groups = groupDuplicatePairs(pairs);
    expect(groups).toHaveLength(1);
    expect(groups[0].photos).toHaveLength(10);
    expect(groups[0].pairIds).toHaveLength(45);
  });

  it.each([
    10, 100, 500, 1000,
  ])("creates a linear exact pair graph for %i photos", (count) => {
    const pairs = createExactDuplicatePairs(
      Array.from({ length: count }, (_, index) => count - index)
    );
    expect(pairs).toHaveLength(count - 1);
    expect(pairs[0]).toEqual({ photoAId: 1, photoBId: 2 });
    expect(pairs.at(-1)).toEqual({
      photoAId: 1,
      photoBId: count,
    });
  });

  it("creates disjoint, stable groups from overlapping and reordered edges", () => {
    const a = photo(4);
    const b = photo(2);
    const c = photo(9);
    const input = [
      pair(8, b, c, { matchType: "clip_confirmed" }),
      pair(7, a, b),
    ];

    const first = groupDuplicatePairs(input);
    const second = groupDuplicatePairs([...input].reverse());
    expect(first).toEqual(second);
    expect(first[0].photos.map((item) => item.id)).toEqual([2, 4, 9]);
    expect(first[0].matchType).toBe("similar");
  });

  it("keeps ignored components available without mixing them into active groups", () => {
    const groups = groupDuplicatePairs([
      pair(1, photo(1), photo(2), { status: "dismissed" }),
      pair(2, photo(10), photo(11)),
    ]);
    expect(groups.map((group) => group.status)).toEqual([
      "active",
      "dismissed",
    ]);
  });
});

describe("duplicate keeper recommendation", () => {
  it("uses pixels, size, file time and id as deterministic tie breakers", () => {
    expect(
      recommendDuplicateKeeper([
        photo(1, { width: 200, height: 100, fileSize: 500 }),
        photo(2, { width: 100, height: 100, fileSize: 5000 }),
      ])
    ).toBe(1);
    expect(
      recommendDuplicateKeeper([
        photo(3, { fileSize: 2000 }),
        photo(4, { fileSize: 1000 }),
      ])
    ).toBe(3);
    expect(
      recommendDuplicateKeeper([
        photo(8, { fileDate: 200 }),
        photo(7, { fileDate: 100 }),
      ])
    ).toBe(7);
    expect(recommendDuplicateKeeper([photo(12), photo(10)])).toBe(10);
  });
});

describe("duplicate cleanup validation", () => {
  const relations = [
    { id: 1, photoAId: 1, photoBId: 2 },
    { id: 2, photoAId: 1, photoBId: 3 },
  ];

  it("accepts deleting all non-keeper photos", () => {
    expect(
      validateDuplicateCleanupGroup(relations, {
        pairIds: [1, 2],
        keepPhotoId: 1,
        deletePhotoIds: [2, 3],
      })
    ).toEqual([2, 3]);
  });

  it("rejects deleting the keeper or every photo in the group", () => {
    expect(() =>
      validateDuplicateCleanupGroup(relations, {
        pairIds: [1, 2],
        keepPhotoId: 1,
        deletePhotoIds: [1, 2],
      })
    ).toThrow(RETAIN_ERROR);
    expect(() =>
      validateDuplicateCleanupGroup(relations, {
        pairIds: [1, 2],
        keepPhotoId: 1,
        deletePhotoIds: [1, 2, 3],
      })
    ).toThrow(RETAIN_ERROR);
  });

  it("rejects stale relationships and unrelated photos", () => {
    expect(() =>
      validateDuplicateCleanupGroup(relations.slice(0, 1), {
        pairIds: [1, 2],
        keepPhotoId: 1,
        deletePhotoIds: [2],
      })
    ).toThrow(STALE_ERROR);
    expect(() =>
      validateDuplicateCleanupGroup(relations, {
        pairIds: [1, 2],
        keepPhotoId: 1,
        deletePhotoIds: [99],
      })
    ).toThrow(RETAIN_ERROR);
  });

  it("rejects combining disjoint relationships to bypass per-group safety", () => {
    expect(() =>
      validateDuplicateCleanupGroup(
        [
          { id: 1, photoAId: 1, photoBId: 2 },
          { id: 2, photoAId: 10, photoBId: 11 },
        ],
        {
          pairIds: [1, 2],
          keepPhotoId: 1,
          deletePhotoIds: [2, 10, 11],
        }
      )
    ).toThrow(SINGLE_GROUP_ERROR);
  });
});
