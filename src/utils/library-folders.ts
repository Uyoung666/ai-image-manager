export function getVisibleLibraryFolders<
  T extends { id: number; parentId: number | null },
>(folders: T[], expanded: ReadonlySet<number>): T[] {
  const byParent = new Map<number | null, T[]>();
  const ids = new Set(folders.map((folder) => folder.id));
  for (const folder of folders) {
    const parentId =
      folder.parentId !== null && ids.has(folder.parentId)
        ? folder.parentId
        : null;
    const siblings = byParent.get(parentId) ?? [];
    siblings.push(folder);
    byParent.set(parentId, siblings);
  }
  const visible: T[] = [];
  const visited = new Set<number>();
  function visit(parentId: number | null) {
    for (const folder of byParent.get(parentId) ?? []) {
      if (visited.has(folder.id)) {
        continue;
      }
      visited.add(folder.id);
      visible.push(folder);
      if (expanded.has(folder.id)) {
        visit(folder.id);
      }
    }
  }
  visit(null);
  return visible;
}
