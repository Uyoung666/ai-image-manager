import { describe, expect, it } from "vitest";
import {
  rememberStarterBatch,
  selectStarterBatch,
} from "@/services/search-starter-rotation";
import type {
  SearchStarter,
  SearchStarterSource,
} from "@/types/search-starters";

function idea(
  key: string,
  source: SearchStarterSource = "library",
  topics = [key]
): SearchStarter {
  return { key, text: key, source, topics };
}

describe("search starter freshness", () => {
  it("assigns different verified covers across a batch even when the first options collide", () => {
    const candidates = [
      { ...idea("beach"), previewPhotoIds: [1, 2] },
      { ...idea("sunset"), previewPhotoIds: [1] },
      { ...idea("forest"), previewPhotoIds: [2, 3] },
      { ...idea("city"), previewPhotoIds: [4] },
    ];
    const batch = selectStarterBatch(candidates);
    expect(new Set(batch.map((item) => item.previewPhotoIds?.[0])).size).toBe(
      4
    );
    for (const item of batch) {
      expect(
        candidates.find((original) => original.key === item.key)
          ?.previewPhotoIds
      ).toContain(item.previewPhotoIds?.[0]);
    }
    expect(candidates[0].previewPhotoIds).toEqual([1, 2]);
  });

  it("changes covers when a small theme pool must repeat", () => {
    const candidates = [{ ...idea("beach"), previewPhotoIds: [1, 2, 3] }];
    const first = selectStarterBatch(candidates);
    const second = selectStarterBatch(candidates, first, first);
    const third = selectStarterBatch(
      candidates,
      second,
      rememberStarterBatch(first, second),
      [2, 1]
    );
    expect(
      [first[0], second[0], third[0]].map((item) => item.previewPhotoIds?.[0])
    ).toEqual([1, 2, 3]);
  });
  it("replaces scarce interest and rediscovery slots with fresh library ideas", () => {
    const candidates = [
      idea("interest", "interest"),
      idea("old", "rediscovery"),
      ...Array.from({ length: 10 }, (_, index) => idea(`library-${index}`)),
    ];
    const first = selectStarterBatch(candidates);
    expect(first.map((item) => item.source)).toEqual([
      "library",
      "library",
      "interest",
      "rediscovery",
    ]);
    const second = selectStarterBatch(candidates, first, first);
    expect(second).toHaveLength(4);
    expect(
      second.every((item) => !first.some((shown) => shown.key === item.key))
    ).toBe(true);
    expect(second.every((item) => item.source === "library")).toBe(true);
  });

  it("exhausts unseen ideas before cycling back, including across source aliases", () => {
    const pool = Array.from({ length: 12 }, (_, index) =>
      idea(`theme-${index}`)
    );
    const candidates = [
      ...pool,
      ...pool
        .slice(0, 2)
        .map((item) => ({ ...item, source: "interest" as const })),
      { ...pool[0], source: "rediscovery" as const },
    ];
    let previous: SearchStarter[] = [];
    let recent: SearchStarter[] = [];
    const seen = new Set<string>();
    for (let round = 0; round < 3; round++) {
      const batch = selectStarterBatch(candidates, previous, recent);
      expect(batch).toHaveLength(4);
      expect(batch.every((item) => !seen.has(item.key))).toBe(true);
      for (const item of batch) {
        seen.add(item.key);
      }
      recent = rememberStarterBatch(recent, batch);
      previous = batch;
    }
    expect(seen.size).toBe(12);
    expect(
      selectStarterBatch(candidates, previous, recent).every(
        (item) => !previous.some((shown) => shown.key === item.key)
      )
    ).toBe(true);
  });

  it("does not count dated or combined versions of the previous themes as new themes", () => {
    const previous = [idea("beach"), idea("sunset"), idea("cat"), idea("city")];
    const fresh = ["mountain", "flower", "lake", "forest"].map((key) =>
      idea(key)
    );
    const variants = [
      idea("beach:2023-02", "rediscovery", ["beach"]),
      idea("beach and sunset", "interest", ["beach", "sunset"]),
    ];
    const next = selectStarterBatch(
      [...variants, ...previous, ...fresh],
      previous,
      previous
    );
    expect(next.map((item) => item.key).sort()).toEqual(
      fresh.map((item) => item.key).sort()
    );
  });

  it("finds four fresh cards even when a high ranked combination would block them", () => {
    const next = selectStarterBatch([
      idea("a and b", "interest", ["a", "b"]),
      ...["a", "b", "c", "d"].map((key) => idea(key)),
    ]);
    expect(next).toHaveLength(4);
    expect(next.map((item) => item.key)).toEqual(["a", "b", "c", "d"]);
  });

  it("normalizes topics and prevents identical visible phrases with different identifiers", () => {
    expect(
      selectStarterBatch([
        idea("a", "library", [" Cat "]),
        idea("b", "interest", ["cat"]),
      ])
    ).toHaveLength(1);
    expect(
      selectStarterBatch([
        idea("same"),
        { ...idea("different"), text: " SAME " },
      ])
    ).toHaveLength(1);
  });

  it("maximizes replacement in a small pool without inventing extra candidates", () => {
    const candidates = ["a", "b", "c", "d", "e"].map((key) => idea(key));
    const previous = candidates.slice(0, 4);
    const next = selectStarterBatch(candidates, previous, previous);
    expect(next).toHaveLength(4);
    expect(next.some((item) => item.key === "e")).toBe(true);
    expect(
      next.filter((item) => previous.some((shown) => shown.key === item.key))
    ).toHaveLength(3);
    expect(selectStarterBatch(candidates.slice(0, 2), previous)).toHaveLength(
      2
    );
    expect(selectStarterBatch([])).toEqual([]);
  });

  it("bounds the cooldown and keeps its latest display order", () => {
    const recent = Array.from({ length: 60 }, (_, index) =>
      idea(`theme-${index}`)
    );
    const result = rememberStarterBatch(recent, [recent[10], recent[0]]);
    expect(result).toHaveLength(48);
    expect(result.slice(0, 3).map((item) => item.key)).toEqual([
      "theme-10",
      "theme-0",
      "theme-1",
    ]);
    expect(result.filter((item) => item.key === "theme-10")).toHaveLength(1);
  });
});
