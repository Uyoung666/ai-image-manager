import { z } from "zod";
import {
  FOLDER_APPEARANCE_ICONS,
  HEX_COLOR_PATTERN,
} from "@/lib/folder-appearance";
import type { ScoringOptions } from "@/services/ai/query-parser";

export const FolderSchema = z.object({ path: z.string().min(1) });
export const SearchSchema = z.object({
  query: z.string().min(1).max(500),
  limit: z.number().optional().default(50),
});
export const ImageSearchSchema = z.object({
  imagePath: z.string().min(1),
  limit: z.number().optional().default(20),
});
export const ListSchema = z.object({
  folderId: z.number().optional(),
  tagId: z.number().optional(),
  tagIds: z.number().array().optional(),
  tagMode: z.enum(["and", "or"]).optional().default("or"),
  search: z.string().optional(),
  favoriteOnly: z.boolean().optional(),
  sort: z.enum(["date", "name", "size"]).optional().default("date"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  offset: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});
export const IdSchema = z.object({ id: z.number() });
export const BatchPhotoIdsSchema = z.object({
  ids: z
    .array(z.number().int().positive())
    .min(1)
    .max(1000)
    .transform((ids) => [...new Set(ids)]),
});
export const TrashListSchema = z.object({
  cursor: z
    .object({
      id: z.number().int().positive(),
      value: z.union([z.number(), z.string()]),
    })
    .nullish()
    .default(null),
  limit: z.number().int().min(1).max(200).optional().default(100),
  query: z.string().trim().max(200).optional().default(""),
  sort: z.enum(["deletedAt", "name", "size"]).optional().default("deletedAt"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
});
export const FolderAppearanceSchema = z.object({
  id: z.number(),
  color: z.string().regex(HEX_COLOR_PATTERN).nullable(),
  icon: z.enum(FOLDER_APPEARANCE_ICONS).nullable(),
});

export function applyTimeDecay<
  T extends { similarity: number; fileDate?: number | null },
>(results: T[], options?: ScoringOptions): Array<T & { score: number }> {
  const scored = results.map((r) => {
    let score = r.similarity;

    if (options?.timeDecay?.enabled && r.fileDate != null) {
      const age = Math.max(0, Date.now() - r.fileDate);
      const recency = Math.max(0, 1 - age / options.timeDecay.maxAgeMs);
      score *= 1 + options.timeDecay.alpha * recency;
    }

    if (options?.temporalBoost && r.fileDate != null) {
      const { targetFrom, targetTo, factor } = options.temporalBoost;
      if (r.fileDate >= targetFrom && r.fileDate <= targetTo) {
        score *= factor;
      }
    }

    return { ...r, score: Math.round(score * 10_000) / 10_000 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const CompoundSearchSchema = z.object({
  query: z.string().optional(),
  colorHex: z.string().optional(),
  dateFrom: z.number().optional(),
  dateTo: z.number().optional(),
  cameraModel: z.string().optional(),
  lensModel: z.string().optional(),
  focalMin: z.number().optional(),
  focalMax: z.number().optional(),
  apertureMin: z.number().optional(),
  apertureMax: z.number().optional(),
  isoMin: z.number().optional(),
  isoMax: z.number().optional(),
  shutterMin: z.number().optional(),
  shutterMax: z.number().optional(),
  limit: z.number().optional().default(100),
});
