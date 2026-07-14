import { describe, expect, it } from "vitest";
import {
  getFolderSubtreeIds,
  getFolderTotalPhotoCounts,
} from "@/services/folder-hierarchy";

describe("folder hierarchy", () => {
  const folders = [
    { id: 1, parentId: null, photoCount: 2 },
    { id: 2, parentId: 1, photoCount: 3 },
    { id: 3, parentId: 2, photoCount: 5 },
    { id: 4, parentId: 1, photoCount: 7 },
    { id: 5, parentId: null, photoCount: 11 },
  ];

  it("returns the selected folder and every descendant exactly once", () => {
    expect(getFolderSubtreeIds(folders, 1)).toEqual([1, 2, 4, 3]);
    expect(getFolderSubtreeIds(folders, 2)).toEqual([2, 3]);
    expect(getFolderSubtreeIds(folders, 5)).toEqual([5]);
  });

  it("computes self plus descendant photo totals", () => {
    const totals = getFolderTotalPhotoCounts(folders);

    expect(totals.get(1)).toBe(17);
    expect(totals.get(2)).toBe(8);
    expect(totals.get(3)).toBe(5);
    expect(totals.get(4)).toBe(7);
    expect(totals.get(5)).toBe(11);
  });

  it("returns an empty subtree for an unknown folder", () => {
    expect(getFolderSubtreeIds(folders, 999)).toEqual([]);
  });

  it("terminates and de-duplicates malformed cyclic relationships", () => {
    const cyclicFolders = [
      { id: 1, parentId: 2, photoCount: 2 },
      { id: 2, parentId: 1, photoCount: 3 },
      { id: 3, parentId: 2, photoCount: 5 },
    ];

    expect(getFolderSubtreeIds(cyclicFolders, 1)).toEqual([1, 2, 3]);
    const totals = getFolderTotalPhotoCounts(cyclicFolders);
    expect(Number.isFinite(totals.get(1))).toBe(true);
    expect(Number.isFinite(totals.get(2))).toBe(true);
  });
});
