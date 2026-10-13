import { ArrowLeft } from "lucide-react";
import type { ComponentProps, Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  GRID_COLUMN_WIDTH_MAX,
  GRID_COLUMN_WIDTH_MIN,
  type SortField,
  type SortOrder,
} from "@/components/PhotoGrid";
import { SearchBar } from "@/components/SearchBar";
import { SearchCompletionNotice } from "@/components/SearchCompletionNotice";
import { SortDropdown } from "@/components/SortDropdown";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SearchResponse } from "@/types/photo";
import type { DashboardReturnTarget } from "@/utils/dashboard-data";

interface HomeToolbarProps {
  dashboardReturnTarget: DashboardReturnTarget | null;
  galleryContextLabel: string;
  galleryScrolled: boolean;
  gridColumnWidth: number;
  handleGridColumnWidthChange: (width: number) => void;
  handleRebuildSequences: () => void;
  handleSequenceModeChange: (mode: "photos" | "sequences") => void;
  handleSortChange: (field: SortField, order: SortOrder) => void;
  inert: boolean;
  onDashboardReturn: () => void;
  onRetry: () => void;
  onShowSuggestions: () => void;
  rebuildingSequences: boolean;
  resetDrillDown: () => void;
  right: number;
  search: ComponentProps<typeof SearchBar>;
  searchIncomplete: boolean;
  searchSemantic: SearchResponse["semantic"] | null;
  searchSemanticRequired: boolean;
  sequenceCount: number;
  sequenceMode: "photos" | "sequences";
  showDrillBanner: boolean;
  sortField: SortField;
  sortOrder: SortOrder;
  suggestionCount: number;
  suggestionsTriggerRef: Ref<HTMLButtonElement>;
  toolbarRef: Ref<HTMLDivElement>;
  totalPhotos: number;
}
export function HomeToolbar({
  toolbarRef,
  inert,
  right,
  galleryScrolled,
  search,
  galleryContextLabel,
  totalPhotos,
  showDrillBanner,
  dashboardReturnTarget,
  onDashboardReturn,
  resetDrillDown,
  sequenceMode,
  handleSequenceModeChange,
  sequenceCount,
  rebuildingSequences,
  handleRebuildSequences,
  onShowSuggestions,
  suggestionsTriggerRef,
  suggestionCount,
  sortField,
  sortOrder,
  handleSortChange,
  gridColumnWidth,
  handleGridColumnWidthChange,
  searchIncomplete,
  onRetry,
  searchSemantic,
  searchSemanticRequired,
}: HomeToolbarProps) {
  const { t } = useTranslation();
  const { aiStatus, searchMode } = search;
  return (
    <div
      className={`home-gallery-toolbar-layer ${galleryScrolled ? "is-scrolled" : ""}`}
      data-surface="toolbar"
      inert={inert}
      ref={toolbarRef}
      style={{
        right,
      }}
    >
      <SearchBar
        {...search}
        filterBarLeadingContent={
          showDrillBanner ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  aria-label={t(
                    dashboardReturnTarget?.tab === "places"
                      ? "backToPlacesAndColors"
                      : "backToDashboard"
                  )}
                  className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-[4px] px-1.5 text-[11px] text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={onDashboardReturn}
                  type="button"
                >
                  <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                  {t(
                    dashboardReturnTarget?.tab === "places"
                      ? "backToPlacesAndColors"
                      : "backToDashboard"
                  )}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("drillDownActiveHint")}</TooltipContent>
            </Tooltip>
          ) : undefined
        }
        filterBarTrailingContent={
          showDrillBanner ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  className="min-h-8 rounded-[4px] px-1.5 text-[11px] text-primary hover:bg-primary/10 focus-visible:outline-2 focus-visible:outline-ring"
                  onClick={resetDrillDown}
                  type="button"
                >
                  {t("drillDownReset")}
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("drillDownResetHint")}</TooltipContent>
            </Tooltip>
          ) : undefined
        }
        leadingContent={
          <div className="flex w-full min-w-0 max-w-[220px] items-center gap-2 pr-1">
            <div className="min-w-0">
              <div className="truncate font-medium text-[13px] text-foreground">
                {galleryContextLabel}
              </div>
              <div className="text-[10px] text-muted-foreground/70 tabular-nums">
                {t("photosCount", { count: totalPhotos.toLocaleString() })}
              </div>
            </div>
          </div>
        }
        trailingContent={
          <>
            <div className="flex min-w-0 flex-wrap rounded-md border border-border p-0.5 text-[11px]">
              <button
                className={`rounded px-2 py-1 ${sequenceMode === "photos" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => handleSequenceModeChange("photos")}
                type="button"
              >
                {t("sequenceViewPhotos")}
              </button>
              <button
                className={`rounded px-2 py-1 ${sequenceMode === "sequences" ? "bg-muted text-foreground" : "text-muted-foreground"}`}
                onClick={() => handleSequenceModeChange("sequences")}
                type="button"
              >
                {t("sequenceViewSequences")}
                {sequenceCount > 0 ? ` ${sequenceCount}` : ""}
              </button>
            </div>
            {sequenceMode === "sequences" && (
              <button
                className="order-first rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                disabled={rebuildingSequences}
                onClick={handleRebuildSequences}
                type="button"
              >
                {rebuildingSequences
                  ? t("sequenceDetecting")
                  : t("sequenceDetect")}
              </button>
            )}
            {sequenceMode === "sequences" && (
              <button
                className="order-first rounded px-2 py-1 text-[11px] text-primary hover:bg-muted"
                onClick={onShowSuggestions}
                ref={suggestionsTriggerRef}
                type="button"
              >
                {t("sequenceSuggestionCount", {
                  count: suggestionCount,
                })}
              </button>
            )}
            <SortDropdown
              onChange={handleSortChange}
              order={sortOrder}
              sort={sortField}
            />
            <label className="home-grid-size-control flex items-center gap-1.5 text-[10px] text-muted-foreground/70">
              <span>{t("gridSize")}</span>
              <input
                aria-label={t("gridSize")}
                className="h-4 w-16 cursor-pointer accent-primary"
                max={GRID_COLUMN_WIDTH_MAX}
                min={GRID_COLUMN_WIDTH_MIN}
                onChange={(event) =>
                  handleGridColumnWidthChange(Number(event.target.value))
                }
                step={10}
                type="range"
                value={gridColumnWidth}
              />
            </label>
          </>
        }
      />
      {searchIncomplete && <SearchCompletionNotice onRetry={onRetry} />}
      {searchMode === "text" &&
        !aiStatus?.rebuildRequired &&
        searchSemantic &&
        searchSemanticRequired &&
        searchSemantic.state !== "ready" && (
          <div className="border-amber-300 border-b bg-amber-50 px-4 py-2 text-amber-900 text-xs dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
            {searchSemantic.state === "error"
              ? t("semanticSearchUnavailable")
              : t("semanticSearchPartial", {
                  indexed: searchSemantic.indexedPhotos,
                  total: searchSemantic.totalPhotos,
                })}
          </div>
        )}
    </div>
  );
}
