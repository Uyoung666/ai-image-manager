import fs from "node:fs";
import path from "node:path";

/** Resolve an import root to a stable, real directory path. */
export function normalizeImportFolderPath(folderPath: string): string {
  const resolved = fs.realpathSync.native(path.resolve(folderPath));
  if (!fs.statSync(resolved).isDirectory()) {
    throw new Error(`Path is not a folder: ${resolved}`);
  }
  return path.normalize(resolved);
}

/** Compare Windows import roots using filesystem case semantics. */
export function importPathKey(folderPath: string): string {
  const normalized = path.normalize(folderPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}
