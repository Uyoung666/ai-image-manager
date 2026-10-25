import type { ExifFilters } from "@/types/search";

export interface SearchPresetContext {
  colorHex?: string;
  order: "asc" | "desc";
  query: string;
  sort: "date" | "name" | "size";
}
export interface SearchPreset {
  createdAt: number;
  filters: ExifFilters;
  lastUsedAt?: number;
  name: string;
  search?: SearchPresetContext;
}
const COLOR_HEX = /^[\da-f]{6}$/i;
const KEY = "exif-filter-presets";
export const SEARCH_PRESETS_CHANGED = "search-presets-changed";
export function readSearchPresets(): SearchPreset[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) {
      return [];
    }
    return raw.flatMap((value) => {
      if (
        !value ||
        typeof value !== "object" ||
        typeof value.name !== "string" ||
        !value.name.trim() ||
        !Number.isFinite(value.createdAt) ||
        !value.filters ||
        typeof value.filters !== "object" ||
        Array.isArray(value.filters) ||
        Object.values(value.filters).some((item) => typeof item !== "string")
      ) {
        return [];
      }
      const preset: SearchPreset = {
        name: value.name,
        createdAt: value.createdAt,
        filters: { ...value.filters },
      };
      if (Number.isFinite(value.lastUsedAt) && value.lastUsedAt > 0) {
        preset.lastUsedAt = value.lastUsedAt;
      }
      const search = value.search;
      if (search) {
        if (
          typeof search.query !== "string" ||
          !["date", "name", "size"].includes(search.sort) ||
          !["asc", "desc"].includes(search.order) ||
          (search.colorHex !== undefined &&
            search.colorHex !== "" &&
            (typeof search.colorHex !== "string" ||
              !COLOR_HEX.test(search.colorHex)))
        ) {
          return [];
        }
        // Reconstruct the safe fields; temporary image paths are never retained.
        preset.search = {
          query: search.query,
          colorHex: search.colorHex || undefined,
          sort: search.sort,
          order: search.order,
        };
      }
      return [preset];
    });
  } catch {
    return [];
  }
}
export function writeSearchPresets(presets: SearchPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
    window.dispatchEvent(new Event(SEARCH_PRESETS_CHANGED));
    return true;
  } catch {
    return false;
  }
}

export function markSearchPresetUsed(name: string) {
  const presets = readSearchPresets();
  if (!presets.some((preset) => preset.name === name)) {
    return false;
  }
  const lastUsedAt = presets.reduce(
    (latest, preset) => Math.max(latest, (preset.lastUsedAt ?? 0) + 1),
    Date.now()
  );
  return writeSearchPresets(
    presets.map((preset) =>
      preset.name === name ? { ...preset, lastUsedAt } : preset
    )
  );
}
