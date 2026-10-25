import { os } from "@orpc/server";
import { z } from "zod";
import { MAX_BATCH_TAG_RELATIONS } from "@/lib/batch-tag-limits";
import {
  applyBatchTags,
  getBatchTagOptions,
  getBatchTagSummary,
  undoBatchTags,
} from "@/services/batch-photo-tags";
import { BatchPhotoIdsSchema } from "./shared";

export const getTagOptions = os.handler(() => getBatchTagOptions());

export const getBatchTags = os
  .input(BatchPhotoIdsSchema)
  .handler(({ input }) => getBatchTagSummary(input.ids));
export const updateBatchTags = os
  .input(
    BatchPhotoIdsSchema.extend({
      operationId: z.string().uuid(),
      addTagIds: z.array(z.number().int().positive()).max(50),
      removeTagIds: z.array(z.number().int().positive()).max(50),
    }).refine(
      (input) =>
        input.ids.length *
          new Set([...input.addTagIds, ...input.removeTagIds]).size <=
        MAX_BATCH_TAG_RELATIONS,
      "Tag batch exceeds the relation budget"
    )
  )
  .handler(({ input }) => applyBatchTags(input));
export const undoBatchTagChanges = os
  .input(z.object({ operationId: z.string().uuid() }))
  .handler(({ input }) => undoBatchTags(input.operationId));
