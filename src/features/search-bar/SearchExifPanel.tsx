import { X } from "lucide-react";
import type { Dispatch, KeyboardEventHandler, SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { FilterBreadcrumb } from "@/components/FilterBreadcrumb";
import { FilterPresets } from "@/components/FilterPresets";
import { FilterDropdown } from "@/components/filter-dropdown";
import { getFilterLabel } from "@/components/search-bar-utils";
import type { AdvancedExifFilterField, ExifFilters } from "@/types/search";
import { cn } from "@/utils/tailwind";

const ADVANCED_EXIF_FILTERS: AdvancedExifFilterField[] = [
  "vendor",
  "captureMode",
  "exposureProgram",
  "meteringMode",
  "whiteBalance",
  "focusMode",
  "subjectTarget",
  "driveMode",
  "stabilizationMode",
  "computationalMode",
  "inCameraLook",
  "provenanceStatus",
];

interface SearchExifPanelProps {
  candidates: {
    advancedCategories: Record<string, string[]>;
    cameraSuggestions: string[];
    creatorSuggestions: string[];
    lensSuggestions: string[];
  };
  clearFilters: () => void;
  drillOriginFilters: Set<keyof ExifFilters>;
  filters: ExifFilters;
  floatingPanelMaxHeight: number;
  onApply: () => void;
  onClose: () => void;
  onKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onLoadPreset: (filters: ExifFilters) => void;
  rangePresets: Record<
    "iso" | "aperture" | "focal" | "shutter",
    (preset: string) => void
  >;
  setDrillOriginFilters: Dispatch<SetStateAction<Set<keyof ExifFilters>>>;
  updateFilter: (
    key: keyof ExifFilters,
    value: string,
    triggerSearch?: boolean
  ) => void;
}

/** Controlled EXIF view; draft updates and search timing belong to SearchBar. */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: existing controlled EXIF form is moved without changing its branches
export function SearchExifPanel({
  candidates: {
    advancedCategories,
    cameraSuggestions,
    creatorSuggestions,
    lensSuggestions,
  },
  clearFilters,
  drillOriginFilters,
  filters,
  floatingPanelMaxHeight,
  onApply,
  onClose,
  onKeyDown: handleFilterKeyDown,
  onLoadPreset,
  rangePresets: {
    iso: applyIsoPreset,
    aperture: applyAperturePreset,
    focal: applyFocalPreset,
    shutter: applyShutterPreset,
  },
  setDrillOriginFilters,
  updateFilter,
}: SearchExifPanelProps) {
  const { t } = useTranslation();
  const filterInputClass =
    "h-8 w-full rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40";
  const filterDropdownClass = "w-full placeholder:text-muted-foreground/70";
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: preserve existing panel keyboard event boundary
    // biome-ignore lint/a11y/noNoninteractiveElementInteractions: Enter applies the controlled filter draft
    <div
      className="absolute top-full right-4 z-[70] mt-2 w-[min(900px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover p-4 shadow-2xl ring-1 ring-foreground/5"
      data-overlay-kind="search-filter"
      data-surface="overlay"
      onKeyDown={handleFilterKeyDown}
      style={{ maxHeight: floatingPanelMaxHeight }}
    >
      <div className="mb-3 flex items-center justify-between">
        <div>
          <h2 className="font-semibold text-[14px] text-foreground">
            {t("exifFilterTitle")}
          </h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            {t("enterToSearch")}
          </p>
        </div>
        <button
          aria-label={t("close")}
          className="flex h-8 w-8 items-center justify-center rounded-[6px] text-muted-foreground transition-colors hover:bg-foreground/5 hover:text-foreground"
          onClick={() => onClose()}
          type="button"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <FilterBreadcrumb
        filters={filters}
        getFilterLabel={getFilterLabel}
        onClearAll={clearFilters}
        onRemoveFilter={(key) => updateFilter(key, "", true)}
      />
      <div className="grid grid-cols-1 gap-x-5 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* Date range */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-date-from"
          >
            {t("dateRangeLabel")}
          </label>
          <div className="space-y-1">
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("dateFrom") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              id="search-date-from"
              onChange={(e) => {
                updateFilter("dateFrom", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("dateFrom");
                  return next;
                });
              }}
              placeholder={t("dateFromPlaceholder")}
              type="date"
              value={filters.dateFrom || ""}
            />
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("dateTo") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              onChange={(e) => {
                updateFilter("dateTo", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("dateTo");
                  return next;
                });
              }}
              placeholder={t("dateToPlaceholder")}
              type="date"
              value={filters.dateTo || ""}
            />
          </div>
        </div>

        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-date-month"
          >
            {t("dateMonthLabel")}
          </label>
          <FilterDropdown
            ariaLabel={t("dateMonthLabel")}
            className={cn(
              filterDropdownClass,
              drillOriginFilters.has("dateMonth") &&
                "border-primary bg-primary/10 dark:bg-primary/20"
            )}
            id="search-date-month"
            onChange={(value) => {
              updateFilter("dateMonth", value);
              setDrillOriginFilters((previous) => {
                const next = new Set(previous);
                next.delete("dateMonth");
                return next;
              });
            }}
            options={[
              { label: t("datePeriodicAny"), value: "" },
              ...Array.from({ length: 12 }, (_, index) => index + 1).map(
                (month) => ({
                  label: t("dateMonthValue", { value: month }),
                  value: String(month),
                })
              ),
            ]}
            placeholder={t("datePeriodicAny")}
            value={filters.dateMonth || ""}
          />
        </div>

        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-date-hour"
          >
            {t("dateHourLabel")}
          </label>
          <FilterDropdown
            ariaLabel={t("dateHourLabel")}
            className={cn(
              filterDropdownClass,
              drillOriginFilters.has("dateHour") &&
                "border-primary bg-primary/10 dark:bg-primary/20"
            )}
            id="search-date-hour"
            onChange={(value) => {
              updateFilter("dateHour", value);
              setDrillOriginFilters((previous) => {
                const next = new Set(previous);
                next.delete("dateHour");
                return next;
              });
            }}
            options={[
              { label: t("datePeriodicAny"), value: "" },
              ...Array.from({ length: 24 }, (_, hour) => hour).map((hour) => ({
                label: t("dateHourValue", {
                  next: String((hour + 1) % 24).padStart(2, "0"),
                  value: String(hour).padStart(2, "0"),
                }),
                value: String(hour),
              })),
            ]}
            placeholder={t("datePeriodicAny")}
            value={filters.dateHour || ""}
          />
        </div>

        {/* Camera */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-camera-model"
          >
            {t("cameraModelLabel")}
          </label>
          <FilterDropdown
            ariaLabel={t("cameraModelLabel")}
            className={cn(
              filterDropdownClass,
              drillOriginFilters.has("cameraModel") &&
                "border-primary bg-primary/10 dark:bg-primary/20"
            )}
            editable
            id="search-camera-model"
            onChange={(value) => {
              updateFilter("cameraModel", value);
              setDrillOriginFilters((prev) => {
                const next = new Set(prev);
                next.delete("cameraModel");
                return next;
              });
            }}
            options={cameraSuggestions.map((model) => ({
              label: model,
              value: model,
            }))}
            placeholder={t("cameraPlaceholder")}
            value={filters.cameraModel || ""}
          />
        </div>

        {/* Lens */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-lens-model"
          >
            {t("lensModelLabel")}
          </label>
          <FilterDropdown
            ariaLabel={t("lensModelLabel")}
            className={cn(
              filterDropdownClass,
              drillOriginFilters.has("lensModel") &&
                "border-primary bg-primary/10 dark:bg-primary/20"
            )}
            editable
            id="search-lens-model"
            onChange={(value) => {
              updateFilter("lensModel", value);
              setDrillOriginFilters((prev) => {
                const next = new Set(prev);
                next.delete("lensModel");
                return next;
              });
            }}
            options={lensSuggestions.map((model) => ({
              label: model,
              value: model,
            }))}
            placeholder={t("lensModelPlaceholder")}
            value={filters.lensModel || ""}
          />
        </div>

        {/* Creator */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-creator"
          >
            {t("creatorLabel")}
          </label>
          <FilterDropdown
            ariaLabel={t("creatorLabel")}
            className={cn(
              filterDropdownClass,
              drillOriginFilters.has("creator") &&
                "border-primary bg-primary/10 dark:bg-primary/20"
            )}
            editable
            id="search-creator"
            onChange={(value) => {
              updateFilter("creator", value);
              setDrillOriginFilters((previous) => {
                const next = new Set(previous);
                next.delete("creator");
                return next;
              });
            }}
            options={creatorSuggestions.map((creator) => ({
              label: creator,
              value: creator,
            }))}
            placeholder={t("creatorPlaceholder")}
            value={filters.creator || ""}
          />
        </div>

        {/* Advanced maker metadata */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-advanced-exif-field"
          >
            {t("advancedExifFilter")}
          </label>
          <div className="space-y-1">
            <FilterDropdown
              ariaLabel={t("advancedExifFilterField")}
              className={filterDropdownClass}
              id="search-advanced-exif-field"
              onChange={(value) =>
                updateFilter("advancedField", value as AdvancedExifFilterField)
              }
              options={[
                {
                  label: t("advancedExifFilterField"),
                  value: "",
                },
                ...ADVANCED_EXIF_FILTERS.map((field) => ({
                  label: t(`advancedFilter_${field}`),
                  value: field,
                })),
              ]}
              placeholder={t("advancedExifFilterField")}
              value={filters.advancedField ?? ""}
            />
            <FilterDropdown
              ariaLabel={t("advancedExifFilterValue")}
              className={filterDropdownClass}
              disabled={!filters.advancedField}
              editable
              onChange={(value) => updateFilter("advancedValue", value)}
              options={(filters.advancedField
                ? (advancedCategories[filters.advancedField] ?? [])
                : []
              ).map((option) => ({ label: option, value: option }))}
              placeholder={t("advancedExifFilterValue")}
              value={filters.advancedValue ?? ""}
            />
          </div>
        </div>

        {/* ISO range */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-iso-min"
          >
            {t("isoRangeLabel")}
          </label>
          <div className="space-y-1">
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("isoMin") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              id="search-iso-min"
              onChange={(e) => {
                updateFilter("isoMin", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("isoMin");
                  return next;
                });
              }}
              placeholder={t("isoMinPlaceholder")}
              type="number"
              value={filters.isoMin || ""}
            />
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("isoMax") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              onChange={(e) => {
                updateFilter("isoMax", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("isoMax");
                  return next;
                });
              }}
              placeholder={t("isoMaxPlaceholder")}
              type="number"
              value={filters.isoMax || ""}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(["100-400", "400-1600", "1600-6400", "6400+"] as const).map(
              (preset) => (
                <button
                  className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                  key={preset}
                  onClick={() => applyIsoPreset(preset)}
                  type="button"
                >
                  {preset}
                </button>
              )
            )}
          </div>
        </div>

        {/* Aperture range */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-aperture-min"
          >
            {t("apertureLabel")}
          </label>
          <div className="space-y-1">
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("apertureMin") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              id="search-aperture-min"
              min="0.7"
              onChange={(e) => {
                updateFilter("apertureMin", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("apertureMin");
                  return next;
                });
              }}
              placeholder={t("minExamplePlaceholder", {
                value: "1.4",
              })}
              step="0.1"
              type="number"
              value={filters.apertureMin || ""}
            />
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("apertureMax") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              min="0.7"
              onChange={(e) => {
                updateFilter("apertureMax", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("apertureMax");
                  return next;
                });
              }}
              placeholder={t("maxExamplePlaceholder", {
                value: "5.6",
              })}
              step="0.1"
              type="number"
              value={filters.apertureMax || ""}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(["f/1.4-2.8", "f/2.8-5.6", "f/5.6-11", "f/11+"] as const).map(
              (preset) => (
                <button
                  className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                  key={preset}
                  onClick={() => applyAperturePreset(preset)}
                  type="button"
                >
                  {preset}
                </button>
              )
            )}
          </div>
        </div>

        {/* Focal length range */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-focal-min"
          >
            {t("focalLabel")}
          </label>
          <div className="space-y-1">
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("focalMin") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              id="search-focal-min"
              onChange={(e) => {
                updateFilter("focalMin", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("focalMin");
                  return next;
                });
              }}
              placeholder={t("minExamplePlaceholder", {
                value: "24",
              })}
              type="number"
              value={filters.focalMin || ""}
            />
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("focalMax") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              onChange={(e) => {
                updateFilter("focalMax", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("focalMax");
                  return next;
                });
              }}
              placeholder={t("maxExamplePlaceholder", {
                value: "200",
              })}
              type="number"
              value={filters.focalMax || ""}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(["<35mm", "35-85mm", "85-200mm", ">200mm"] as const).map(
              (preset) => (
                <button
                  className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                  key={preset}
                  onClick={() => applyFocalPreset(preset)}
                  type="button"
                >
                  {preset}
                </button>
              )
            )}
          </div>
        </div>

        {/* Shutter speed range */}
        <div>
          <label
            className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider"
            htmlFor="search-shutter-min"
          >
            {t("shutterSpeedLabel")}
          </label>
          <div className="flex gap-2">
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("shutterMin") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              id="search-shutter-min"
              onChange={(e) => {
                updateFilter("shutterMin", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("shutterMin");
                  return next;
                });
              }}
              placeholder={t("shutterSpeedMin")}
              type="text"
              value={filters.shutterMin || ""}
            />
            <input
              className={cn(
                filterInputClass,
                drillOriginFilters.has("shutterMax") &&
                  "border-primary bg-primary/10 dark:bg-primary/20"
              )}
              onChange={(e) => {
                updateFilter("shutterMax", e.target.value);
                setDrillOriginFilters((prev) => {
                  const next = new Set(prev);
                  next.delete("shutterMax");
                  return next;
                });
              }}
              placeholder={t("shutterSpeedMax")}
              type="text"
              value={filters.shutterMax || ""}
            />
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1">
            {(["1/1000+", "1/100-1/10", "1s+", "30s+"] as const).map(
              (preset) => (
                <button
                  className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                  key={preset}
                  onClick={() => applyShutterPreset(preset)}
                  type="button"
                >
                  {preset}
                </button>
              )
            )}
          </div>
        </div>
      </div>

      <FilterPresets
        currentFilters={filters}
        onLoadPreset={(loadedFilters) => {
          onLoadPreset(loadedFilters);
        }}
      />
      <div className="mt-3 flex items-center justify-between border-border border-t pt-2">
        <span className="text-[10px] text-muted-foreground/70">
          {t("enterToSearch")}
        </span>
        <div className="flex items-center gap-2">
          <button
            className="min-h-8 rounded-[4px] px-2 text-[11px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
            onClick={() => {
              clearFilters();
              onClose();
            }}
            type="button"
          >
            {t("reset")}
          </button>
          <button
            className="min-h-8 rounded-[4px] bg-primary/10 px-2 font-medium text-[11px] text-primary hover:bg-primary/20"
            onClick={() => {
              onApply();
              onClose();
            }}
            type="button"
          >
            {t("applyFilters")}
          </button>
        </div>
      </div>
    </div>
  );
}
