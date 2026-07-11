import type { SortField, SortOrder } from "@/components/PhotoGrid";

const GRID_SORT_FIELD_KEY = "grid_sort_field";
const GRID_SORT_ORDER_KEY = "grid_sort_order";

export function loadSortField(): SortField {
  try {
    const raw = localStorage.getItem(GRID_SORT_FIELD_KEY);
    if (raw === "date" || raw === "name" || raw === "size") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "date";
}

export function loadSortOrder(): SortOrder {
  try {
    const raw = localStorage.getItem(GRID_SORT_ORDER_KEY);
    if (raw === "asc" || raw === "desc") {
      return raw;
    }
  } catch {
    /* ignore */
  }
  return "desc";
}

export function saveSortPreference(field: SortField, order: SortOrder) {
  try {
    localStorage.setItem(GRID_SORT_FIELD_KEY, field);
    localStorage.setItem(GRID_SORT_ORDER_KEY, order);
  } catch {
    /* ignore */
  }
}
