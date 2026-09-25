import { os } from "@orpc/server";
import { z } from "zod";
import {
  createDuplicateCleanupPlan,
  executeDuplicateCleanupPlan,
  listDuplicateCleanupBatches,
  restoreDuplicateCleanupBatch,
} from "@/services/duplicate-cleanup-plan";

export const listDuplicateCleanupBatchesHandler = os.handler(() =>
  listDuplicateCleanupBatches()
);

const duplicateCleanupGroupInput = z.object({
  deletePhotoIds: z.array(z.number().int().positive()).min(1),
  groupKey: z.string().min(1),
  groupVersion: z.string().min(1),
  keepPhotoIds: z.array(z.number().int().positive()).min(1),
  matchType: z.enum(["exact", "similar"]),
  reviewRevision: z.number().int().nonnegative(),
});

export const createDuplicateCleanupPlanHandler = os
  .input(z.object({ groups: z.array(duplicateCleanupGroupInput).min(1) }))
  .handler(({ input }) => createDuplicateCleanupPlan(input));

export const executeDuplicateCleanupPlanHandler = os
  .input(z.object({ planId: z.string().uuid() }))
  .handler(({ input }) => executeDuplicateCleanupPlan(input));

export const restoreDuplicateCleanupBatchHandler = os
  .input(z.object({ batchId: z.string().uuid() }))
  .handler(({ input }) => restoreDuplicateCleanupBatch(input));
