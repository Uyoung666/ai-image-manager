import { z } from "zod";

const sourceRootSchema = z.string().min(1).max(32_767);

export const inspectShootingProjectSourceSchema = z
  .object({ sourceRoot: sourceRootSchema })
  .strict();

export const createShootingProjectSchema = z
  .object({
    workflow: z.enum(["curate", "duel", "hybrid"]).optional(),
    pkMode: z.enum(["quick", "standard", "fine"]).optional(),
    acknowledgeLibrarySource: z.boolean().optional(),
    name: z.string().max(200).optional(),
    sourceRoot: sourceRootSchema,
  })
  .strict();

export const listShootingProjectsSchema = z
  .object({
    archived: z.boolean().optional(),
    search: z.string().max(200).optional(),
  })
  .strict();

export const openShootingProjectSchema = z.object({ id: z.uuid() }).strict();

export const projectIdSchema = z.object({ projectId: z.uuid() }).strict();
const photoIdsSchema = z.array(z.uuid()).min(1).max(100_000);
export const projectPhotosSchema = projectIdSchema
  .extend({ photoIds: photoIdsSchema })
  .strict();
export const projectSelectionSchema = projectPhotosSchema
  .extend({ status: z.enum(["pending", "undecided", "kept", "rejected"]) })
  .strict();
export const projectPrepareSchema = projectIdSchema
  .extend({
    checkNew: z.boolean().optional(),
    retryPreviews: z.boolean().optional(),
  })
  .strict();
export const projectBrowseSchema = projectIdSchema
  .extend({
    browsing: z
      .object({
        currentPhotoId: z.uuid().nullable(),
        orderedPhotoIds: z.array(z.uuid()).max(100_000),
        filter: z.enum(["all", "pending", "undecided", "kept", "rejected"]),
        format: z.string().max(32),
        sort: z.enum(["time", "name", "format"]),
        view: z.enum(["single", "grid"]),
        gridScrollTop: z.number().finite().min(0).max(1_000_000_000),
      })
      .strict(),
  })
  .strict();
export const projectRelinkSchema = projectIdSchema
  .extend({ sourceRoot: sourceRootSchema })
  .strict();
export const projectCommitRelinkSchema = projectIdSchema
  .extend({ token: z.uuid(), acceptCandidates: z.boolean() })
  .strict();
export const projectRenameSchema = projectIdSchema
  .extend({ name: z.string().trim().min(1).max(200) })
  .strict();
export const projectArchiveSchema = projectIdSchema
  .extend({ archived: z.boolean() })
  .strict();
export const projectOutputSchema = projectIdSchema
  .extend({
    targetParent: sourceRootSchema,
    photoIds: photoIdsSchema.optional(),
  })
  .strict();
export const projectCreateOutputSchema = projectOutputSchema
  .extend({ acknowledgeWatchedTarget: z.boolean().optional() })
  .strict();
export const projectOutputTaskSchema = projectIdSchema
  .extend({ taskId: z.uuid() })
  .strict();
export const projectRetryOutputSchema = projectOutputTaskSchema
  .extend({ acknowledgeWatchedTarget: z.boolean().optional() })
  .strict();
export const projectLibrarySchema = projectIdSchema
  .extend({
    source: z.enum(["original", "output"]),
    taskId: z.uuid().optional(),
    photoIds: photoIdsSchema.optional(),
  })
  .strict();
export const projectAddLibrarySchema = projectLibrarySchema
  .extend({ confirmed: z.literal(true), inspectionToken: z.uuid() })
  .strict();
