import { z } from "zod";

export const SessionIdSchema = z.object({ sessionId: z.number() });

export const GetNextPairSchema = z.object({
  sessionId: z.number(),
  /** Photo IDs that the frontend reports as unloadable (corrupt / externally deleted).
   *  These are excluded from pairing to prevent infinite retry loops. */
  excludeIds: z.array(z.number()).optional().default([]),
});

export const CreateSessionSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(["duel", "curate"]).default("duel"),
  pkMode: z.enum(["quick", "standard", "fine"]).default("standard"),
  sortStrategy: z.enum(["time", "similarity"]).default("time"),
  photoIds: z.array(z.number()).default([]),
  folderId: z.number().optional(),
});

export const SubmitComparisonSchema = z.object({
  sessionId: z.number(),
  winnerId: z.number(),
  loserId: z.number(),
  isDraw: z.boolean().default(false),
});

export const UpdatePhotoStatusSchema = z.object({
  sessionId: z.number(),
  photoId: z.number(),
  status: z.enum(["pending", "kept", "rejected"]),
});

export const RecordSkipSchema = z.object({
  sessionId: z.number(),
  photoAId: z.number(),
  photoBId: z.number(),
});

export const BatchUpdatePhotoStatusSchema = z.object({
  sessionId: z.number(),
  photoIds: z.array(z.number()).min(1),
  status: z.enum(["pending", "kept", "rejected"]),
});
