import { z } from "zod";

const PositiveIdSchema = z.number().int().positive();

export const SessionIdSchema = z.object({ sessionId: PositiveIdSchema });

export const GetNextPairSchema = z.object({
  sessionId: PositiveIdSchema,
  /** Photo IDs that the frontend reports as unloadable (corrupt / externally deleted).
   *  These are excluded from pairing to prevent infinite retry loops. */
  excludeSessionPhotoIds: z.array(PositiveIdSchema).optional().default([]),
});

export const CreateSessionSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["duel", "curate"]).default("duel"),
  pkMode: z.enum(["quick", "standard", "fine"]).default("standard"),
  sortStrategy: z.enum(["time", "similarity"]).default("time"),
  photoIds: z.array(PositiveIdSchema).default([]),
  folderId: PositiveIdSchema.optional(),
});

export const SubmitComparisonSchema = z
  .object({
    sessionId: PositiveIdSchema,
    winnerId: PositiveIdSchema,
    loserId: PositiveIdSchema,
    isDraw: z.boolean().default(false),
  })
  .refine((value) => value.winnerId !== value.loserId, {
    message: "A photo cannot be compared with itself",
  });

export const UpdatePhotoStatusSchema = z.object({
  sessionId: PositiveIdSchema,
  photoId: PositiveIdSchema,
  status: z.enum(["pending", "kept", "rejected"]),
});

export const RecordSkipSchema = z
  .object({
    sessionId: PositiveIdSchema,
    photoAId: PositiveIdSchema,
    photoBId: PositiveIdSchema,
  })
  .refine((value) => value.photoAId !== value.photoBId, {
    message: "A photo cannot be skipped against itself",
  });

export const BatchUpdatePhotoStatusSchema = z.object({
  sessionId: PositiveIdSchema,
  photoIds: z.array(PositiveIdSchema).min(1),
  status: z.enum(["pending", "kept", "rejected"]),
});
