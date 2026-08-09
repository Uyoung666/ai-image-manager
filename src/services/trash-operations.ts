export interface TrashOperationFailure {
  code: "FILE_OPERATION_FAILED" | "NOT_FOUND_OR_NOT_DELETED" | "SOURCE_MISSING";
  id: number;
  message: string;
}

export interface TrashOperationResult {
  failed: TrashOperationFailure[];
  succeededIds: number[];
}

interface TrashMoveDependencies {
  fileExists: (path: string) => Promise<boolean>;
  hardDelete: (ids: number[]) => void;
  onFailure?: (photo: { id: number; path: string }, message: string) => void;
  trashFile: (path: string) => Promise<void>;
}

function isMissingFileError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Moves files before removing catalog records. Failed file operations never
 * reach hardDelete, while already-missing files are cleaned up idempotently.
 */
export async function executeSystemTrashMove(
  targetPhotos: Array<{ id: number; path: string }>,
  dependencies: TrashMoveDependencies
): Promise<TrashOperationResult> {
  const succeededIds: number[] = [];
  const failed: TrashOperationFailure[] = [];

  for (const photo of targetPhotos) {
    try {
      if (await dependencies.fileExists(photo.path)) {
        await dependencies.trashFile(photo.path);
      }
      succeededIds.push(photo.id);
    } catch (error) {
      // The file may disappear between lstat and trashItem. Treat only an
      // explicit missing-file error as idempotent; permission/path errors
      // must not be converted into a destructive database delete.
      if (isMissingFileError(error)) {
        succeededIds.push(photo.id);
        continue;
      }
      const message = (error as Error)?.message ?? String(error);
      failed.push({
        code: "FILE_OPERATION_FAILED",
        id: photo.id,
        message,
      });
      dependencies.onFailure?.(photo, message);
    }
  }

  if (succeededIds.length > 0) {
    dependencies.hardDelete(succeededIds);
  }

  return { failed, succeededIds };
}
