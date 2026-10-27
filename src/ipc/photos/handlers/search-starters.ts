import { os } from "@orpc/server";
import { z } from "zod";
import { getSearchStarterFallbacks as prepareFallbacks } from "@/services/search-starter-fallbacks";
import { getSearchStarters as prepareSearchStarters } from "@/services/search-starters";
import { CompoundSearchSchema } from "./shared";

export const SearchStartersSchema = z.object({
  language: z.enum(["zh", "en"]),
  locale: z.enum(["zh", "en", "ja"]).optional(),
  history: z.array(z.string().max(500)).max(20).default([]),
  filters: CompoundSearchSchema.omit({
    query: true,
    colorHex: true,
    requestId: true,
    cursor: true,
    limit: true,
    offset: true,
  }).default({}),
  colorHex: z.string().max(8).optional(),
});

export const getSearchStarters = os
  .input(SearchStartersSchema)
  .handler(({ input }) => prepareSearchStarters(input));

export const getSearchStarterFallbacks = os
  .input(SearchStartersSchema)
  .handler(({ input }) => prepareFallbacks(input));
