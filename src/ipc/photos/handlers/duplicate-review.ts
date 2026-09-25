import { os } from "@orpc/server";
import { z } from "zod";
import { getDatabase } from "@/db";
import {
  applyDuplicateKeepCount,
  DUPLICATE_REVIEW_DECISIONS,
  updateDuplicateReviewState,
} from "@/services/duplicate-review";

const duplicateReviewDecision = z.enum(DUPLICATE_REVIEW_DECISIONS);

export const updateDuplicateReview = os
  .input(
    z.object({
      decisions: z
        .array(
          z.object({
            decision: duplicateReviewDecision,
            photoId: z.number().int().positive(),
          })
        )
        .min(1),
      expectedReviewRevision: z.number().int().nonnegative(),
      groupKey: z.string().min(1),
      groupVersion: z.string().min(1),
      ignoreState: z.enum(["ACTIVE", "IGNORED"]).optional(),
    })
  )
  .handler(({ input }) => updateDuplicateReviewState(getDatabase(), input));

export const applyDuplicateKeepCountHandler = os
  .input(
    z.object({
      count: z.number().int().positive(),
      expectedReviewRevision: z.number().int().nonnegative(),
      groupKey: z.string().min(1),
      groupVersion: z.string().min(1),
    })
  )
  .handler(({ input }) => applyDuplicateKeepCount(getDatabase(), input));
