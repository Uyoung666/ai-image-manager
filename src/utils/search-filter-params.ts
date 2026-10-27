import type { PhotoSearchFilters } from "@/services/search-scope";
import type { ExifFilters } from "@/types/search";

/** Shared by actual searches and starter validation, including local day edges. */
export function buildSearchFilterParams(
  filters?: ExifFilters
): PhotoSearchFilters {
  const params: PhotoSearchFilters = {};
  if (!filters) {
    return params;
  }
  for (const key of ["dateFrom", "dateTo"] as const) {
    if (filters[key]) {
      const [year, month, day] = filters[key].split("-").map(Number);
      params[key] =
        key === "dateFrom"
          ? new Date(year, month - 1, day, 0, 0, 0, 0).getTime()
          : new Date(year, month - 1, day, 23, 59, 59, 999).getTime();
    }
  }
  for (const key of [
    "dateMonth",
    "dateHour",
    "focalMin",
    "focalMax",
    "apertureMin",
    "apertureMax",
    "isoMin",
    "isoMax",
    "shutterMin",
    "shutterMax",
  ] as const) {
    if (filters[key]) {
      params[key] = Number(filters[key]);
    }
  }
  for (const key of [
    "cameraModel",
    "lensModel",
    "creator",
    "advancedField",
    "advancedValue",
  ] as const) {
    if (filters[key]) {
      Object.assign(params, { [key]: filters[key] });
    }
  }
  return params;
}
