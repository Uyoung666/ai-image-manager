import { z } from "zod";

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
  search: z.string().optional(),
  sort: z.enum(["date", "name", "size"]).optional().default("date"),
  order: z.enum(["asc", "desc"]).optional().default("desc"),
  offset: z.number().optional().default(0),
  limit: z.number().optional().default(100),
});
export const IdSchema = z.object({ id: z.number() });

// Time-decay scoring: blends vector similarity with photo recency.
// Newer photos get a moderate boost; older photos are not penalized below their vector score.
const TIME_DECAY_ALPHA = 0.1; // Light recency boost — prioritizes semantic relevance over freshness
const MAX_AGE_MS = 365 * 24 * 60 * 60 * 1000; // 1 year

export function applyTimeDecay<
  T extends { similarity: number; fileDate?: number | null },
>(results: T[]): Array<T & { score: number }> {
  const now = Date.now();
  const scored = results.map((r) => {
    const age = r.fileDate == null ? 0 : Math.max(0, now - r.fileDate);
    const recency = Math.max(0, 1 - age / MAX_AGE_MS);
    const score = r.similarity * (1 + TIME_DECAY_ALPHA * recency);
    return { ...r, score: Math.round(score * 10_000) / 10_000 };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

export const CompoundSearchSchema = z.object({
  query: z.string().optional(),
  dateFrom: z.number().optional(),
  dateTo: z.number().optional(),
  cameraModel: z.string().optional(),
  focalMin: z.number().optional(),
  focalMax: z.number().optional(),
  apertureMin: z.number().optional(),
  apertureMax: z.number().optional(),
  isoMin: z.number().optional(),
  isoMax: z.number().optional(),
  limit: z.number().optional().default(100),
});
