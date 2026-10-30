import path from "node:path";
import { and, eq, isNull, sql } from "drizzle-orm";
import { getDatabase } from "@/db";
import { folders, photos } from "@/db/schema";
import { invalidateFoldersCache } from "@/utils/folder-paths";
import { getFolderMatcher, reloadFolderMatcher } from "./folder-matcher";

/** Catalog only the confirmed files' ancestry; these folders never start a scan or watcher. */
export function registerExplicitPhotoFolder(
  filePath: string,
  rootPath?: string
): number {
  const db = getDatabase();
  const directory = path.dirname(path.resolve(filePath));
  const known = db
    .select({ id: folders.id })
    .from(folders)
    .where(
      process.platform === "win32"
        ? sql`lower(${folders.path}) = lower(${directory})`
        : eq(folders.path, directory)
    )
    .get();
  if (known) {
    return known.id;
  }
  let root = rootPath ? path.resolve(rootPath) : directory;
  const relative = path.relative(root, directory);
  if (
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    root = directory;
  }
  const ancestorId = getFolderMatcher().match(path.join(root, "placeholder"));
  const ancestor = ancestorId
    ? db.select().from(folders).where(eq(folders.id, ancestorId)).get()
    : undefined;
  if (ancestor) {
    root = ancestor.path;
  }
  const directories = [root];
  for (const segment of path
    .relative(root, directory)
    .split(path.sep)
    .filter(Boolean)) {
    directories.push(path.join(directories.at(-1) ?? root, segment));
  }
  const id = db.transaction(() => {
    let parentId: number | null = null;
    for (const folderPath of directories) {
      const existing = db
        .select()
        .from(folders)
        .where(
          process.platform === "win32"
            ? sql`lower(${folders.path}) = lower(${folderPath})`
            : eq(folders.path, folderPath)
        )
        .get();
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const inserted = db
        .insert(folders)
        .values({
          path: folderPath,
          displayName: path.basename(folderPath),
          parentId,
          explicitOnly: true,
        })
        .returning({ id: folders.id })
        .get();
      if (!inserted) {
        throw new Error("Failed to register selected photo directory");
      }
      parentId = inserted.id;
    }
    if (parentId === null) {
      throw new Error("Missing selected photo directory");
    }
    return parentId;
  });
  reloadFolderMatcher();
  invalidateFoldersCache();
  return id;
}

/** Repair earlier explicit imports without revisiting or importing any source directory. */
export function repairUnassignedLibraryPhotos(): number {
  const db = getDatabase();
  const unassigned = db
    .select({ id: photos.id, path: photos.path })
    .from(photos)
    .where(and(isNull(photos.folderId), isNull(photos.deletedAt)))
    .all();
  const touched = new Set<number>();
  for (const photo of unassigned) {
    if (!path.isAbsolute(photo.path)) {
      continue;
    }
    const folderId = registerExplicitPhotoFolder(photo.path);
    db.update(photos).set({ folderId }).where(eq(photos.id, photo.id)).run();
    touched.add(folderId);
  }
  for (const id of touched) {
    db.update(folders)
      .set({
        photoCount: sql`(select count(*) from photos where folder_id = ${id} and deleted_at is null)`,
      })
      .where(eq(folders.id, id))
      .run();
  }
  return unassigned.length;
}
