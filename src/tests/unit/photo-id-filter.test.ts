// @vitest-environment node

import { describe, expect, it } from "vitest";
import { buildPhotoIdFilter } from "@/services/ai/vector-db";

const INT32_MAX = 2_147_483_647;
const BETWEEN_RE = /^photo_id BETWEEN (\d+) AND (\d+)$/;
const IN_RE = /^photo_id IN \((.*)\)$/;
const range = (start: number, size: number) =>
  Array.from({ length: size }, (_, index) => start + index);
const validIds = (ids: number[]) =>
  ids.filter((id) => Number.isInteger(id) && id > 0 && id < INT32_MAX);
const legacyFilter = (ids: number[]) =>
  `photo_id IN (${validIds(ids).join(", ")})`;

function predicate(filter: string): (id: number) => boolean {
  const bounds = BETWEEN_RE.exec(filter);
  if (bounds) {
    const minimum = Number(bounds[1]);
    const maximum = Number(bounds[2]);
    return (id) => id >= minimum && id <= maximum;
  }
  const list = IN_RE.exec(filter);
  if (!list) {
    throw new Error(`Unexpected photo ID predicate: ${filter}`);
  }
  const included = new Set(list[1].split(", ").map(Number));
  return (id) => included.has(id);
}

describe("photo ID filter interval compression", () => {
  it("keeps small sets byte-for-byte identical to the existing IN filter", () => {
    const ids = range(5, 31).reverse();
    expect(buildPhotoIdFilter(ids)).toBe(legacyFilter(ids));
  });

  it("compresses only complete intervals with at least 32 unique IDs", () => {
    expect(buildPhotoIdFilter(range(1, 32))).toBe("photo_id BETWEEN 1 AND 32");
    expect(buildPhotoIdFilter(range(1, 10_000))).toBe(
      "photo_id BETWEEN 1 AND 10000"
    );
    const repeatedSmallSet = [...range(1, 31), ...range(1, 31)];
    expect(buildPhotoIdFilter(repeatedSmallSet)).toBe(
      legacyFilter(repeatedSmallSet)
    );
  });

  it("handles unsorted duplicates and invalid IDs without mutating input", () => {
    const ids = [
      ...range(10, 32).reverse(),
      10,
      41,
      0,
      -1,
      12.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      INT32_MAX,
      INT32_MAX + 1,
    ];
    const original = [...ids];
    expect(buildPhotoIdFilter(ids)).toBe("photo_id BETWEEN 10 AND 41");
    expect(ids).toEqual(original);
  });

  it("preserves a soft-deletion hole instead of admitting its retained vector", () => {
    const ids = range(1, 65).filter((id) => id !== 33);
    const filter = buildPhotoIdFilter(ids);
    expect(filter).toBe(legacyFilter(ids));
    expect(predicate(filter)(33)).toBe(false);
  });

  it("preserves disjoint integer sets", () => {
    const ids = range(1, 64).map((id) => id * 2);
    expect(buildPhotoIdFilter(ids)).toBe(legacyFilter(ids));
  });

  it("retains the existing strict Int32 upper-bound validation", () => {
    const ids = [...range(INT32_MAX - 32, 32), INT32_MAX, INT32_MAX + 1];
    expect(buildPhotoIdFilter(ids)).toBe(
      `photo_id BETWEEN ${INT32_MAX - 32} AND ${INT32_MAX - 1}`
    );
    expect(predicate(buildPhotoIdFilter(ids))(INT32_MAX)).toBe(false);
  });

  it.each(
    [[], [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, INT32_MAX]].map(
      (ids) => ({ ids })
    )
  )("retains the no-valid-IDs error for %j", ({ ids }) => {
    expect(() => buildPhotoIdFilter(ids)).toThrow("no valid IDs");
  });

  it.each(
    [
      range(1, 31),
      range(1, 32),
      [...range(10, 64).reverse(), 10, 50, 0, Number.NaN],
      range(1, 65).filter((id) => id !== 33),
      range(1, 64).map((id) => id * 2),
      [...range(INT32_MAX - 32, 32), INT32_MAX],
      range(1, 10_000),
    ].map((ids) => ({ ids }))
  )("is exactly equivalent to existing IN membership on the integer domain", ({
    ids,
  }) => {
    const accepted = new Set(validIds(ids));
    const domain = new Set([
      ...range(-3, 140),
      ...validIds(ids).flatMap((id) => [id - 1, id, id + 1]),
      INT32_MAX - 1,
      INT32_MAX,
      INT32_MAX + 1,
    ]);
    const matches = predicate(buildPhotoIdFilter(ids));
    for (const id of domain) {
      expect(matches(id), `membership of ${id}`).toBe(accepted.has(id));
    }
  });
});
