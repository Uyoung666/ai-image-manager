import fs from "node:fs/promises";
import path from "node:path";
import { DATA_PATH_SUBDIRECTORIES } from "./data-path-destination";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PROTECTED_EXTENSION = /\.(?:csv|xlsx)$/i;

export type ProjectPreviewMigrationOwnership = Map<string, Set<string>>;

export function projectPreviewMigrationOwnership(
  projectIds: string[],
  photos: {
    projectId: string;
    id: string;
    previewRelativePath: string | null;
  }[]
): ProjectPreviewMigrationOwnership {
  const ownership = new Map(projectIds.map((id) => [id, new Set<string>()]));
  for (const photo of photos) {
    const names = ownership.get(photo.projectId);
    if (!(names && UUID.test(photo.id))) {
      continue;
    }
    names.add(`${photo.id}.jpg`);
    const staging = photo.previewRelativePath;
    if (
      staging?.startsWith(`${photo.id}-`) &&
      staging.endsWith(".jpg.pending") &&
      UUID.test(staging.slice(photo.id.length + 1, -12))
    ) {
      names.add(staging);
    }
  }
  return ownership;
}

function refused(code: string, target: string): never {
  throw new Error(`${code}: ${target}`);
}

async function assertSafeAncestors(target: string): Promise<void> {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const segment of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, segment);
    if (segment.toLowerCase() === "temp") {
      refused("CLEANUP_PROTECTED_TEMP", current);
    }
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        refused("CLEANUP_DIRECTORY_LINK", current);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
}

function assertOwnedPreviewEntry(
  relativePath: string,
  directory: boolean,
  ownership: ProjectPreviewMigrationOwnership
) {
  const parts = relativePath.split(path.sep);
  if (parts.length === 1 && directory && ownership.has(parts[0])) {
    return;
  }
  if (
    parts.length === 2 &&
    !directory &&
    ownership.get(parts[0])?.has(parts[1])
  ) {
    return;
  }
  refused("CLEANUP_FOREIGN_PROJECT_CONTENT", relativePath);
}

async function inspectCleanupTree(
  target: string,
  ownership?: ProjectPreviewMigrationOwnership
) {
  const pending = [target];
  const files: string[] = [];
  const directories: string[] = [];
  for (const current of pending) {
    await assertSafeAncestors(current);
    if (PROTECTED_EXTENSION.test(current)) {
      refused("CLEANUP_PROTECTED_EXTENSION", current);
    }
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) {
      refused("CLEANUP_DIRECTORY_LINK", current);
    }
    if (ownership && current !== target) {
      assertOwnedPreviewEntry(
        path.relative(target, current),
        stat.isDirectory(),
        ownership
      );
    }
    if (stat.isDirectory()) {
      directories.push(current);
      for (const name of await fs.readdir(current)) {
        pending.push(path.join(current, name));
      }
    } else if (stat.isFile()) {
      files.push(current);
    } else {
      refused("CLEANUP_UNKNOWN_FILE_TYPE", current);
    }
  }
  return { files, directories };
}

/**
 * Cleanup only a checked managed child. Never recurse during deletion: a file
 * added after inspection (especially a protected file) keeps its directory.
 */
export async function removeMigratedDataDirectory(
  dataRoot: string,
  directory: string,
  projectOwnership: ProjectPreviewMigrationOwnership
): Promise<void> {
  if (!(DATA_PATH_SUBDIRECTORIES as readonly string[]).includes(directory)) {
    refused("CLEANUP_INVALID_DIRECTORY", directory);
  }
  const root = path.resolve(dataRoot);
  const target = path.resolve(root, directory);
  if (path.dirname(target) !== root) {
    refused("CLEANUP_OUTSIDE_DATA_ROOT", target);
  }
  await assertSafeAncestors(target);
  try {
    await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw error;
  }
  const snapshot = await inspectCleanupTree(
    target,
    directory === "shooting-projects" ? projectOwnership : undefined
  );
  for (const filename of snapshot.files) {
    await assertSafeAncestors(filename);
    if (PROTECTED_EXTENSION.test(filename)) {
      refused("CLEANUP_PROTECTED_EXTENSION", filename);
    }
    await fs.unlink(filename).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
  for (const current of snapshot.directories.reverse()) {
    await assertSafeAncestors(current);
    await fs.rmdir(current).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") {
        throw error;
      }
    });
  }
}
