import { ipc } from "@/ipc/manager";
import { batchTagPhotoLimit } from "@/lib/batch-tag-limits";

export const photoTagActions = {
  list: () => ipc.client.photos.getTagOptions(),
  summary: async (ids: number[]) => {
    const counts = new Map<number, number>();
    let total = 0;
    for (let offset = 0; offset < ids.length; offset += 1000) {
      const result = await ipc.client.photos.getBatchTags({
        ids: ids.slice(offset, offset + 1000),
      });
      total += result.total;
      for (const item of result.counts) {
        if (item.id !== null) {
          counts.set(item.id, (counts.get(item.id) ?? 0) + item.count);
        }
      }
    }
    return { counts, total };
  },
  apply: async (
    ids: number[],
    addTagIds: number[],
    removeTagIds: number[],
    onProgress: (processed: number) => void
  ) => {
    const operationId = crypto.randomUUID();
    let changed = 0;
    let processed = 0;
    let failed = 0;
    const tagCount = new Set([...addTagIds, ...removeTagIds]).size;
    const chunkSize = batchTagPhotoLimit(tagCount);
    for (let offset = 0; offset < ids.length; offset += chunkSize) {
      try {
        const result = await ipc.client.photos.updateBatchTags({
          ids: ids.slice(offset, offset + chunkSize),
          addTagIds,
          removeTagIds,
          operationId,
        });
        changed += result.changed;
        processed += result.processed;
        onProgress(Math.min(offset + chunkSize, ids.length));
      } catch {
        failed = ids.length - offset;
        break;
      }
    }
    return { operationId, changed, processed, failed };
  },
  undo: async (operationId: string) => {
    let restored = 0;
    let skipped = 0;
    let expired = false;
    for (;;) {
      const result = await ipc.client.photos.undoBatchTagChanges({
        operationId,
      });
      restored += result.restored;
      skipped += result.skipped;
      expired ||= result.expired;
      if (result.done) {
        return { restored, skipped, expired };
      }
    }
  },
};
