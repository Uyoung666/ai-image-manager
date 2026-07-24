import { ChevronRight, Home, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ExifFilters } from "@/types/search";

interface FilterBreadcrumbProps {
  filters: ExifFilters;
  getFilterLabel: (key: keyof ExifFilters, value: string | undefined) => string;
  onClearAll: () => void;
  onRemoveFilter: (key: keyof ExifFilters) => void;
}

export function FilterBreadcrumb({
  filters,
  onRemoveFilter,
  onClearAll,
  getFilterLabel,
}: FilterBreadcrumbProps) {
  const { t } = useTranslation();
  const activeFilters = (
    Object.keys(filters) as Array<keyof ExifFilters>
  ).filter((key) => filters[key] !== undefined && filters[key] !== "");

  if (activeFilters.length === 0) {
    return null;
  }

  return (
    <div className="flex items-center gap-1.5 border-b bg-muted/30 px-3 py-1.5 text-sm">
      <Home className="h-3.5 w-3.5 text-muted-foreground" />
      <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
      {activeFilters.map((key, i) => (
        <span className="flex items-center gap-0.5" key={key}>
          <span className="rounded-[3px] bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">
            {getFilterLabel(key, filters[key])}
            <button
              aria-label={t("clear")}
              className="-mr-1 ml-1 inline-flex h-6 w-6 items-center justify-center rounded hover:bg-primary/15 hover:text-foreground"
              onClick={() => onRemoveFilter(key)}
              type="button"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
          {i < activeFilters.length - 1 && (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )}
        </span>
      ))}
      <button
        className="ml-auto min-h-8 rounded px-2 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
        onClick={onClearAll}
        type="button"
      >
        {t("clearAll")}
      </button>
    </div>
  );
}
