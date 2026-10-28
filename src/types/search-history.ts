import { z } from "zod";

const PATH_SEPARATORS = /[\\/]/;
const REPEATED_SLASHES = /\/+/g;

export const SEARCH_HISTORY_PREFERENCES_KEY = "search.history.preferences";
export const SEARCH_HISTORY_LIMITS = [5, 10, 20, 50, 100] as const;
export const SearchHistoryPreferencesSchema = z.object({
  enabled: z.boolean(),
  limit: z.union([
    z.literal(5),
    z.literal(10),
    z.literal(20),
    z.literal(50),
    z.literal(100),
  ]),
});
export type SearchHistoryPreferences = z.infer<
  typeof SearchHistoryPreferencesSchema
>;
export const DEFAULT_SEARCH_HISTORY_PREFERENCES: SearchHistoryPreferences = {
  enabled: true,
  limit: 5,
};
export type SearchHistoryEntry = { id: string; lastUsedAt: number } & (
  | { kind: "text"; query: string }
  | { kind: "image"; imagePath: string }
);
export function parseSearchHistoryPreferences(
  raw: string | null
): SearchHistoryPreferences {
  try {
    const result = SearchHistoryPreferencesSchema.safeParse(
      JSON.parse(raw ?? "null")
    );
    return result.success
      ? result.data
      : { ...DEFAULT_SEARCH_HISTORY_PREFERENCES };
  } catch {
    return { ...DEFAULT_SEARCH_HISTORY_PREFERENCES };
  }
}
export function searchHistoryLabel(entry: SearchHistoryEntry): string {
  return entry.kind === "text"
    ? entry.query
    : (entry.imagePath.split(PATH_SEPARATORS).filter(Boolean).at(-1) ??
        entry.imagePath);
}
export function searchHistoryId(kind: "text" | "image", value: string): string {
  return `${kind}:${kind === "image" ? value.replaceAll("\\", "/").replace(REPEATED_SLASHES, "/").toLowerCase() : value.trim()}`;
}
