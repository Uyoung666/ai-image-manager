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
  fileExists: (path: string) => boolean;
  hardDelete: (ids: number[]) => void;
  onFailure?: (photo: { id: number; path: string }, message: string) => void;
  trashFile: (path: string) => Promise<void>;
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
      if (dependencies.fileExists(photo.path)) {
        await dependencies.trashFile(photo.path);
      }
      succeededIds.push(photo.id);
    } catch (error) {
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
