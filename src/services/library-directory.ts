import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { closeDatabase, getDatabase } from "@/db";
import {
  folders,
  photos,
  shootingProjectPhotos,
  shootingProjects,
} from "@/db/schema";
import type {
  LibraryDirectoryError,
  LibraryDirectoryInput,
  LibraryDirectoryProgress,
  LibraryDirectoryResult,
} from "@/types/library-directory";
import {
  getDataPath,
  persistDataPath,
  setRuntimeDataPath,
} from "@/utils/data-path";
import { DATA_PATH_SUBDIRECTORIES } from "@/utils/data-path-destination";
import {
  projectPreviewMigrationOwnership,
  removeMigratedDataDirectory,
} from "@/utils/data-path-migration-cleanup";
import { registry } from "./registry";
import { getSetting } from "./settings-manager";

let changingDirectory = false;

export function isLibraryDirectoryChanging(): boolean {
  return changingDirectory;
}

class DirectoryError extends Error {
  readonly code: LibraryDirectoryError;

  constructor(code: LibraryDirectoryError) {
    super(code);
    this.code = code;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

async function statIfPresent(filename: string) {
  try {
    return await fs.lstat(filename);
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

async function verifyDirectoryPath(directory: string) {
  let current = path.parse(directory).root;
  for (const segment of path.relative(current, directory).split(path.sep)) {
    current = path.join(current, segment);
    const stat = await statIfPresent(current);
    if (stat && !stat.isDirectory()) {
      throw new DirectoryError("invalidPath");
    }
  }
}

function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    Boolean(relative) &&
    !path.isAbsolute(relative) &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`)
  );
}

async function verifyExistingLibrary(root: string) {
  try {
    const data = path.join(root, "data");
    const file = path.join(data, "ai-image-manager.db");
    if (
      !((await fs.lstat(data)).isDirectory() && (await fs.lstat(file)).isFile())
    ) {
      throw new Error("Missing library database");
    }
    const database = new Database(file, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('photos', 'folders', 'app_settings')"
        )
        .all();
      if (tables.length !== 3) {
        throw new Error("Unrecognized library schema");
      }
    } finally {
      database.close();
    }
  } catch (error) {
    console.warn(
      "[Library directory] Existing library validation failed",
      error
    );
    throw new DirectoryError("notLibrary");
  }
}

async function prepareDestination(
  input: LibraryDirectoryInput,
  source: string,
  target: string
) {
  await verifyDirectoryPath(target);
  if (isInside(source, target) || isInside(target, source)) {
    throw new DirectoryError("nestedPath");
  }
  if (input.mode === "open") {
    await verifyExistingLibrary(target);
  } else if (await statIfPresent(target)) {
    if ((await fs.readdir(target)).length > 0) {
      throw new DirectoryError("notEmpty");
    }
  } else {
    await fs.mkdir(target, { recursive: true });
  }
  await fs.access(target, fs.constants.W_OK);
}

function getPreviewOwnership() {
  const db = getDatabase();
  return projectPreviewMigrationOwnership(
    db
      .select({ id: shootingProjects.id })
      .from(shootingProjects)
      .all()
      .map(({ id }) => id),
    db
      .select({
        projectId: shootingProjectPhotos.projectId,
        id: shootingProjectPhotos.id,
        previewRelativePath: shootingProjectPhotos.previewRelativePath,
      })
      .from(shootingProjectPhotos)
      .all()
  );
}

function originalMediaRoots() {
  const db = getDatabase();
  return [
    ...db.select({ path: folders.path }).from(folders).all(),
    ...db.select({ path: photos.path }).from(photos).all(),
    ...db
      .select({ path: shootingProjects.sourceRoot })
      .from(shootingProjects)
      .all(),
  ].map((entry) => path.resolve(entry.path));
}

async function cleanDirectories(
  root: string,
  directories: string[],
  ownership: ReturnType<typeof getPreviewOwnership>,
  protectedMedia?: string[]
) {
  let cleaned = 0;
  const cleanupErrors: string[] = [];
  for (const directory of directories) {
    const managedPath = path.join(root, directory);
    if (
      protectedMedia?.some(
        (original) =>
          path.relative(original, managedPath) === "" ||
          isInside(managedPath, original) ||
          isInside(original, managedPath)
      )
    ) {
      cleanupErrors.push(managedPath);
      continue;
    }
    try {
      await removeMigratedDataDirectory(
        root,
        directory,
        ownership,
        Boolean(protectedMedia)
      );
      cleaned++;
    } catch (error) {
      console.warn("[Library directory] Cleanup skipped", error);
      cleanupErrors.push(managedPath);
    }
  }
  return { cleaned, cleanupErrors };
}

async function copyLibrary(
  source: string,
  target: string,
  owned: string[],
  progress: (event: LibraryDirectoryProgress) => void
) {
  for (const [index, dir] of DATA_PATH_SUBDIRECTORIES.entries()) {
    const from = path.join(source, dir);
    const stat = await statIfPresent(from);
    if (!stat) {
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Not a managed directory: ${from}`);
    }
    const to = path.join(target, dir);
    progress({
      phase: "copying",
      dir,
      index: index + 1,
      total: DATA_PATH_SUBDIRECTORIES.length,
    });
    await fs.mkdir(to);
    owned.push(dir);
    for (const name of await fs.readdir(from)) {
      await fs.cp(path.join(from, name), path.join(to, name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: async (entry) => {
          if ((await fs.lstat(entry)).isSymbolicLink()) {
            throw new Error(`Directory migration cannot copy a link: ${entry}`);
          }
          return true;
        },
      });
    }
  }
}

async function restoreLibrary(
  previous: string | undefined,
  target: string,
  mode: LibraryDirectoryInput["mode"],
  copiedDirectories: string[],
  ownership: ReturnType<typeof getPreviewOwnership>
) {
  if (previous) {
    await registry.stop({ strict: true });
    closeDatabase({ strict: true });
    setRuntimeDataPath(previous);
  }
  await registry.start();
  if (copiedDirectories.length > 0) {
    return (await cleanDirectories(target, copiedDirectories, ownership))
      .cleanupErrors;
  }
  return previous && mode === "create" ? [target] : [];
}

async function switchLibrary(
  input: LibraryDirectoryInput,
  progress: (event: LibraryDirectoryProgress) => void
): Promise<LibraryDirectoryResult> {
  if (!path.isAbsolute(input.newPath)) {
    return { error: "invalidPath", ok: false };
  }
  const source = await fs.realpath(getDataPath());
  const target = path.resolve(input.newPath);
  if (path.relative(source, target) === "") {
    return input.mode === "open"
      ? { alreadyOpen: true, cleaned: 0, copied: 0, ok: true, path: source }
      : { error: "invalidPath", ok: false };
  }
  await prepareDestination(input, source, target);
  const ownership =
    input.mode === "migrate" &&
    (await statIfPresent(path.join(source, "shooting-projects")))
      ? getPreviewOwnership()
      : projectPreviewMigrationOwnership([], []);
  const copiedDirectories: string[] = [];
  const protectedMedia =
    input.mode === "migrate" && input.cleanupSource ? originalMediaRoots() : [];
  const previous = getDataPath();
  const onboardingCompleted = getSetting("onboarding.completed") === "true";
  let usingTarget = false;
  let failure: LibraryDirectoryError = "stopFailed";
  try {
    progress({ phase: "stopping-services" });
    await registry.stop({ strict: true });
    closeDatabase({ strict: true });

    // Recheck after stopping services, before writing into the selected folder.
    failure = "copyFailed";
    await prepareDestination(input, source, target);
    if (input.mode === "migrate") {
      await copyLibrary(source, target, copiedDirectories, progress);
    }

    failure = "startFailed";
    progress({ phase: "starting-services" });
    setRuntimeDataPath(target);
    usingTarget = true;
    await registry.start();
    // A write transaction checks that SQLite can acquire the target's write lock.
    getDatabase().transaction(() => undefined, { behavior: "immediate" });
    failure = "saveFailed";
    persistDataPath(target, onboardingCompleted);
  } catch (error) {
    console.error("[Library directory] Switch failed", error);
    try {
      const cleanupErrors = await restoreLibrary(
        usingTarget ? previous : undefined,
        target,
        input.mode,
        copiedDirectories,
        ownership
      );
      return {
        error: error instanceof DirectoryError ? error.code : failure,
        ok: false,
        cleanupErrors,
      };
    } catch (restoreError) {
      console.error(
        "[Library directory] Could not restore services",
        restoreError
      );
      return { error: "restoreFailed", ok: false, cleanupErrors: [target] };
    }
  }

  if (input.mode === "migrate" && input.cleanupSource) {
    progress({ phase: "cleaning" });
    return {
      ...(await cleanDirectories(
        source,
        copiedDirectories,
        ownership,
        protectedMedia
      )),
      copied: copiedDirectories.length,
      ok: true,
      path: target,
    };
  }
  return {
    cleaned: 0,
    copied: copiedDirectories.length,
    ok: true,
    path: target,
  };
}

export async function changeLibraryDirectory(
  input: LibraryDirectoryInput,
  progress: (event: LibraryDirectoryProgress) => void
): Promise<LibraryDirectoryResult> {
  if (changingDirectory) {
    return { error: "busy", ok: false };
  }
  changingDirectory = true;
  try {
    return await switchLibrary(input, progress);
  } catch (error) {
    console.warn("[Library directory] Preflight failed", error);
    return {
      error: error instanceof DirectoryError ? error.code : "unavailable",
      ok: false,
    };
  } finally {
    changingDirectory = false;
  }
}
