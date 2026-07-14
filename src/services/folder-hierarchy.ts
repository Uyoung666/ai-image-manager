export interface FolderHierarchyItem {
  id: number;
  parentId: number | null;
}

export interface CountedFolderHierarchyItem extends FolderHierarchyItem {
  photoCount: number;
}

function buildChildrenMap(
  folders: FolderHierarchyItem[]
): Map<number, number[]> {
  const childrenMap = new Map<number, number[]>();
  for (const folder of folders) {
    if (folder.parentId === null) {
      continue;
    }
    const children = childrenMap.get(folder.parentId);
    if (children) {
      children.push(folder.id);
    } else {
      childrenMap.set(folder.parentId, [folder.id]);
    }
  }
  return childrenMap;
}

/** Returns the root folder and every reachable descendant exactly once. */
export function getFolderSubtreeIds(
  folders: FolderHierarchyItem[],
  rootId: number
): number[] {
  const knownIds = new Set(folders.map((folder) => folder.id));
  if (!knownIds.has(rootId)) {
    return [];
  }

  const childrenMap = buildChildrenMap(folders);
  const subtreeIds: number[] = [];
  const visited = new Set<number>();
  const queue = [rootId];

  for (const folderId of queue) {
    if (visited.has(folderId)) {
      continue;
    }
    visited.add(folderId);
    subtreeIds.push(folderId);
    for (const childId of childrenMap.get(folderId) ?? []) {
      if (!visited.has(childId)) {
        queue.push(childId);
      }
    }
  }

  return subtreeIds;
}

/** Computes self + descendant active-photo totals in O(n) for valid trees. */
export function getFolderTotalPhotoCounts(
  folders: CountedFolderHierarchyItem[]
): Map<number, number> {
  const folderMap = new Map(folders.map((folder) => [folder.id, folder]));
  const childrenMap = buildChildrenMap(folders);
  const totals = new Map<number, number>();
  const visiting = new Set<number>();

  function compute(folderId: number): number {
    const cached = totals.get(folderId);
    if (cached !== undefined) {
      return cached;
    }
    const folder = folderMap.get(folderId);
    if (!folder || visiting.has(folderId)) {
      return 0;
    }

    visiting.add(folderId);
    let total = folder.photoCount;
    for (const childId of childrenMap.get(folderId) ?? []) {
      total += compute(childId);
    }
    visiting.delete(folderId);
    totals.set(folderId, total);
    return total;
  }

  for (const folder of folders) {
    compute(folder.id);
  }
  return totals;
}
