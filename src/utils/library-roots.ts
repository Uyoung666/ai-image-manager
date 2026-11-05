import path from "node:path";
import { importPathKey } from "./import-path";

export function containsLibraryPath(root: string, candidate: string): boolean {
  const relative = path.relative(importPathKey(root), importPathKey(candidate));
  return (
    relative === "" ||
    !(
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    )
  );
}

export function selectLibraryRoots<T extends { path: string }>(
  folders: T[]
): T[] {
  const roots: T[] = [];
  for (const folder of [...folders].sort(
    (a, b) => a.path.length - b.path.length
  )) {
    if (!roots.some((root) => containsLibraryPath(root.path, folder.path))) {
      roots.push(folder);
    }
  }
  return roots;
}
