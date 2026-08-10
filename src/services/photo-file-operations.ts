import fs from "node:fs";

export interface AssetMove {
  from: string;
  to: string;
}

/**
 * Move only the source photo. Thumbnail files are disposable cache and are
 * handled separately so a locked cache entry cannot fail a rename.
 */
export function movePhotoFile(oldPath: string, newPath: string): AssetMove[] {
  fs.renameSync(oldPath, newPath);
  return [{ from: oldPath, to: newPath }];
}
