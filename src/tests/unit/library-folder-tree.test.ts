import { expect, it } from "vitest";
import { getVisibleLibraryFolders } from "@/utils/library-folders";

const folders = [
  { id: 3, parentId: 2 },
  { id: 2, parentId: 1 },
  { id: 1, parentId: null },
  { id: 4, parentId: 999 },
];

it("keeps grandchildren hidden when an ancestor is collapsed", () => {
  expect(
    getVisibleLibraryFolders(folders, new Set([2])).map((folder) => folder.id)
  ).toEqual([1, 4]);
  expect(
    getVisibleLibraryFolders(folders, new Set([1, 2])).map(
      (folder) => folder.id
    )
  ).toEqual([1, 2, 3, 4]);
  expect(
    getVisibleLibraryFolders(folders, new Set([1])).map((folder) => folder.id)
  ).toEqual([1, 2, 4]);
});

it("treats folders whose parent was removed as visible roots", () => {
  expect(
    getVisibleLibraryFolders([{ id: 4, parentId: 999 }], new Set())
  ).toEqual([{ id: 4, parentId: 999 }]);
});
