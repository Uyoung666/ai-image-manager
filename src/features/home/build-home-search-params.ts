import type { searchPhotos } from "@/actions/photo-search";
import type { ExifFilters } from "@/types/search";
import { buildSearchFilterParams } from "@/utils/search-filter-params";
/** Keep initial and continuation filters identical, including local date boundaries. */
export function buildHomeSearchParams(
  query: string,
  filters?: ExifFilters,
  effectiveColorHex?: string | null,
  pagination: { cursor?: string; offset?: number } = {}
) {
  const searchParams: Parameters<typeof searchPhotos>[0] = {
    limit: 100,
    ...pagination,
  };
  if (query.trim()) {
    searchParams.query = query.trim();
  }
  if (effectiveColorHex) {
    searchParams.colorHex = effectiveColorHex;
  }
  Object.assign(searchParams, buildSearchFilterParams(filters));
  return searchParams;
}
