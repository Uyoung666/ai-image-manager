import { z } from "zod";

export const WanderContentModeSchema = z.enum([
  "timeCapsule",
  "theme",
  "rediscovery",
  "hamsterWheel",
]);

export const GetWanderSessionSchema = z.object({
  mode: z.union([z.literal("auto"), WanderContentModeSchema]).default("auto"),
  allowedModes: z.array(WanderContentModeSchema).min(1).max(4).optional(),
  excludeMode: WanderContentModeSchema.optional(),
  limit: z.number().int().min(2).max(12).default(8),
});

export const RecordWanderExposureSchema = z.object({
  photoId: z.number().int().positive(),
  source: z.enum(["lightbox", "wander"]),
});

export const SaveWanderSessionToAlbumSchema = z.object({
  title: z.string().trim().min(1).max(200),
  photoIds: z
    .array(z.number().int().positive())
    .min(2)
    .max(12)
    .transform((ids) => [...new Set(ids)])
    .refine((ids) => ids.length >= 2, {
      message: "At least two distinct photos are required",
    }),
});
