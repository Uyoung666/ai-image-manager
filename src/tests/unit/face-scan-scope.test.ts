import { describe, expect, it } from "vitest";
import {
  expandFaceScanFolderIds,
  normalizeFaceScanFolderIds,
} from "@/utils/face-scan-scope";

describe("face scan scope", () => {
  const folders = [
    { id: 1, parentId: null },
    { id: 2, parentId: 1 },
    { id: 3, parentId: 2 },
    { id: 4, parentId: 1 },
    { id: 5, parentId: null },
  ];

  it("removes duplicates, invalid ids, and descendants covered by a root", () => {
    expect(normalizeFaceScanFolderIds(folders, [3, 1, 2, 1, 999, -1])).toEqual([
      1,
    ]);
  });

  it("keeps independent roots and expands every descendant once", () => {
    expect(normalizeFaceScanFolderIds(folders, [2, 5])).toEqual([2, 5]);
    expect(expandFaceScanFolderIds(folders, [2, 5])).toEqual([2, 3, 5]);
  });

  it("returns an empty scope instead of falling back to all folders", () => {
    expect(normalizeFaceScanFolderIds(folders, [])).toEqual([]);
    expect(expandFaceScanFolderIds(folders, [999])).toEqual([]);
  });

  it("terminates and chooses one stable root for malformed cycles", () => {
    const cyclic = [
      { id: 1, parentId: 2 },
      { id: 2, parentId: 1 },
      { id: 3, parentId: 2 },
    ];

    expect(normalizeFaceScanFolderIds(cyclic, [2, 1])).toEqual([1]);
    expect(expandFaceScanFolderIds(cyclic, [2, 1])).toEqual([1, 2, 3]);
  });
});
