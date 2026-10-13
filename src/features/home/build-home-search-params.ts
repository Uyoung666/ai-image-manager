import type { searchPhotos } from "@/actions/photo-search";
import type { ExifFilters } from "@/types/search";
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
  if (filters?.dateFrom) {
    const [y, m, d] = filters.dateFrom.split("-").map(Number);
    searchParams.dateFrom = new Date(y, m - 1, d, 0, 0, 0).getTime();
  }
  if (filters?.dateMonth) {
    searchParams.dateMonth = Number(filters.dateMonth);
  }
  if (filters?.dateHour) {
    searchParams.dateHour = Number(filters.dateHour);
  }
  if (filters?.dateTo) {
    const [y, m, d] = filters.dateTo.split("-").map(Number);
    searchParams.dateTo = new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
  }
  if (filters?.cameraModel) {
    searchParams.cameraModel = filters.cameraModel;
  }
  if (filters?.creator) {
    searchParams.creator = filters.creator;
  }
  if (filters?.lensModel) {
    searchParams.lensModel = filters.lensModel;
  }
  if (filters?.advancedField) {
    searchParams.advancedField = filters.advancedField;
  }
  if (filters?.advancedValue) {
    searchParams.advancedValue = filters.advancedValue;
  }
  if (filters?.focalMin) {
    searchParams.focalMin = Number(filters.focalMin);
  }
  if (filters?.focalMax) {
    searchParams.focalMax = Number(filters.focalMax);
  }
  if (filters?.apertureMin) {
    searchParams.apertureMin = Number(filters.apertureMin);
  }
  if (filters?.apertureMax) {
    searchParams.apertureMax = Number(filters.apertureMax);
  }
  if (filters?.isoMin) {
    searchParams.isoMin = Number(filters.isoMin);
  }
  if (filters?.isoMax) {
    searchParams.isoMax = Number(filters.isoMax);
  }
  if (filters?.shutterMin) {
    searchParams.shutterMin = Number(filters.shutterMin);
  }
  if (filters?.shutterMax) {
    searchParams.shutterMax = Number(filters.shutterMax);
  }

  return searchParams;
}
