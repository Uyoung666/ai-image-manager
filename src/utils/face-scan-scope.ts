import { getFolderSubtreeIds } from "@/services/folder-hierarchy";

export interface FaceScanFolder {
  id: number;
  parentId: number | null;
}

/**
 * Keeps only valid, non-overlapping scan roots. A selected parent covers every
 * selected descendant, including malformed cyclic trees without looping.
 */
export function normalizeFaceScanFolderIds(
  folders: FaceScanFolder[],
  folderIds: number[]
): number[] {
  const validIds = new Set(folders.map((folder) => folder.id));
  const requested = [...new Set(folderIds)]
    .filter((id) => Number.isInteger(id) && id > 0 && validIds.has(id))
    .sort((a, b) => a - b);
  const roots: number[] = [];
  const covered = new Set<number>();

  for (const folderId of requested) {
    if (covered.has(folderId)) {
      continue;
    }
    roots.push(folderId);
    for (const descendantId of getFolderSubtreeIds(folders, folderId)) {
      covered.add(descendantId);
    }
  }

  return roots;
}

export function expandFaceScanFolderIds(
  folders: FaceScanFolder[],
  rootIds: number[]
): number[] {
  const expanded = new Set<number>();
  for (const rootId of normalizeFaceScanFolderIds(folders, rootIds)) {
    for (const folderId of getFolderSubtreeIds(folders, rootId)) {
      expanded.add(folderId);
    }
  }
  return [...expanded];
}
