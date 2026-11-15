import { X } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExifFilters } from "@/types/search";

interface SearchActiveFiltersProps {
  filterBarLeadingContent?: ReactNode;
  filterBarTrailingContent?: ReactNode;
  filters: ExifFilters;
  hasActiveFilters: boolean;
  onClear: () => void;
  onRemoveAdvancedFilter: () => void;
  onRemoveFilter: (key: keyof ExifFilters) => void;
  onRemoveShutterFilter: () => void;
}
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve the existing independently removable filter chips
export function SearchActiveFilters({
  filterBarLeadingContent,
  filterBarTrailingContent,
  filters,
  hasActiveFilters,
  onClear,
  onRemoveAdvancedFilter,
  onRemoveFilter,
  onRemoveShutterFilter,
}: SearchActiveFiltersProps) {
  const { t } = useTranslation();
  return (
    <>
      {(hasActiveFilters ||
        filterBarLeadingContent ||
        filterBarTrailingContent) && (
        <div className="mt-2 flex min-w-0 max-w-full flex-wrap items-start gap-1.5">
          {filterBarLeadingContent && (
            <div className="flex min-h-8 shrink-0 items-center border-border border-r pr-2">
              {filterBarLeadingContent}
            </div>
          )}
          {hasActiveFilters && (
            <div className="flex max-h-24 min-w-0 flex-1 basis-0 flex-wrap items-center gap-1.5 overflow-y-auto overflow-x-hidden overscroll-contain pr-0.5">
              {filters.dateFrom && (
                <FilterChip
                  label={t("filterFrom", { value: filters.dateFrom })}
                  onRemove={() => onRemoveFilter("dateFrom")}
                />
              )}
              {filters.dateTo && (
                <FilterChip
                  label={t("filterTo", { value: filters.dateTo })}
                  onRemove={() => onRemoveFilter("dateTo")}
                />
              )}
              {filters.dateMonth && (
                <FilterChip
                  label={t("dateMonthValue", {
                    value: filters.dateMonth,
                  })}
                  onRemove={() => onRemoveFilter("dateMonth")}
                />
              )}
              {filters.dateHour && (
                <FilterChip
                  label={t("dateHourValue", {
                    next: String((Number(filters.dateHour) + 1) % 24).padStart(
                      2,
                      "0"
                    ),
                    value: filters.dateHour.padStart(2, "0"),
                  })}
                  onRemove={() => onRemoveFilter("dateHour")}
                />
              )}
              {filters.cameraModel && (
                <FilterChip
                  label={filters.cameraModel}
                  onRemove={() => onRemoveFilter("cameraModel")}
                />
              )}
              {filters.creator && (
                <FilterChip
                  label={filters.creator}
                  onRemove={() => onRemoveFilter("creator")}
                />
              )}
              {filters.lensModel && (
                <FilterChip
                  label={filters.lensModel}
                  onRemove={() => onRemoveFilter("lensModel")}
                />
              )}
              {filters.advancedField && filters.advancedValue && (
                <FilterChip
                  label={`${t(`advancedFilter_${filters.advancedField}`)}: ${filters.advancedValue}`}
                  onRemove={onRemoveAdvancedFilter}
                />
              )}
              {filters.isoMin && (
                <FilterChip
                  label={`ISO ≥ ${filters.isoMin}`}
                  onRemove={() => onRemoveFilter("isoMin")}
                />
              )}
              {filters.isoMax && (
                <FilterChip
                  label={`ISO ≤ ${filters.isoMax}`}
                  onRemove={() => onRemoveFilter("isoMax")}
                />
              )}
              {filters.apertureMin && (
                <FilterChip
                  label={t("apertureGte", { value: filters.apertureMin })}
                  onRemove={() => onRemoveFilter("apertureMin")}
                />
              )}
              {filters.apertureMax && (
                <FilterChip
                  label={t("apertureLte", { value: filters.apertureMax })}
                  onRemove={() => onRemoveFilter("apertureMax")}
                />
              )}
              {filters.focalMin && (
                <FilterChip
                  label={t("focalGte", { value: filters.focalMin })}
                  onRemove={() => onRemoveFilter("focalMin")}
                />
              )}
              {filters.focalMax && (
                <FilterChip
                  label={t("focalLte", { value: filters.focalMax })}
                  onRemove={() => onRemoveFilter("focalMax")}
                />
              )}
              {(filters.shutterMin || filters.shutterMax) && (
                <FilterChip
                  label={`${t("shutterSpeedLabel")}: ${filters.shutterMin || "0"}s-${filters.shutterMax || "∞"}s`}
                  onRemove={onRemoveShutterFilter}
                />
              )}
            </div>
          )}
          {hasActiveFilters && !filterBarTrailingContent && (
            <button
              className="min-h-8 rounded-[4px] px-2 text-[11px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
              onClick={onClear}
              type="button"
            >
              {t("clearSearchFilters")}
            </button>
          )}
          {filterBarTrailingContent && (
            <div className="ml-auto flex min-h-8 shrink-0 items-center">
              {filterBarTrailingContent}
            </div>
          )}
        </div>
      )}
    </>
  );
}
function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  const { t } = useTranslation();

  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1 rounded-[4px] bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary">
      <span className="min-w-0 flex-1 break-all">{label}</span>
      <button
        aria-label={t("removeSearchFilter", { label })}
        className="-mr-1 ml-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded hover:bg-primary/15 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        onClick={onRemove}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
