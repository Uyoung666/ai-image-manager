import { ipc } from "@/ipc/manager";
export const photoOperationActions = {
  deletePhoto: (input: Parameters<typeof ipc.client.photos.deletePhoto>[0]) =>
    ipc.client.photos.deletePhoto(input),
  deletePhotos: async (
    input: Parameters<typeof ipc.client.photos.deletePhotos>[0]
  ) => {
    const deletionBatchId = crypto.randomUUID();
    const ids = [...new Set(input.ids)];
    const succeededIds: number[] = [];
    const failedIds: number[] = [];
    for (let offset = 0; offset < ids.length; offset += 1000) {
      try {
        const result = await ipc.client.photos.deletePhotos({
          ids: ids.slice(offset, offset + 1000),
          operationId: deletionBatchId,
        });
        succeededIds.push(...result.succeededIds);
      } catch {
        failedIds.push(...ids.slice(offset));
        break;
      }
    }
    return {
      deleted: succeededIds.length,
      succeededIds,
      failedIds,
      deletionBatchId,
    };
  },
  restoreDeleted: async (ids: number[], expectedDeletionBatchId: string) => {
    const succeededIds: number[] = [];
    let failed = 0;
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const chunk = ids.slice(offset, offset + 1000);
      try {
        const result = await ipc.client.photos.restorePhotos({
          ids: chunk,
          expectedDeletionBatchId,
        });
        succeededIds.push(...result.succeededIds);
        failed += result.failed.length;
      } catch {
        failed += chunk.length;
      }
    }
    return { succeededIds, failed };
  },
  renamePhotos: (input: Parameters<typeof ipc.client.photos.renamePhotos>[0]) =>
    ipc.client.photos.renamePhotos(input),
  convertPhotos: (
    input: Parameters<typeof ipc.client.photos.convertPhotos>[0]
  ) => ipc.client.photos.convertPhotos(input),
};
