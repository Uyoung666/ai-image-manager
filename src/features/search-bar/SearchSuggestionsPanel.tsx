import { Clock, EyeOff, RefreshCw, Search } from "lucide-react";
import {
  type FocusEventHandler,
  type KeyboardEventHandler,
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  getTimePresets,
  SearchSuggestion,
} from "@/components/search-bar-utils";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { SearchStarterResponse } from "@/types/search-starters";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { cn } from "@/utils/tailwind";
import { SearchHistorySuggestion } from "./SearchHistorySuggestion";
import { SearchStarterGallery } from "./SearchStarterGallery";
import { SearchTextButton } from "./SearchTextButton";

interface SearchSuggestionsPanelProps {
  clearHistory: () => void;
  floatingPanelMaxHeight: number;
  handleSuggestionClick: (suggestion: SearchSuggestion) => void;
  handleSuggestionKeyDown: KeyboardEventHandler<HTMLDivElement>;
  historyDisabled: boolean;
  onBlur: FocusEventHandler<HTMLDivElement>;
  onRefreshStarters: () => void;
  onRemoveHistory: (id: string) => void;
  onResetStarterFilters: () => void;
  onTimePresetSelect: (
    preset: ReturnType<typeof getTimePresets>[number]
  ) => void;
  panelRef: Ref<HTMLDivElement>;
  presetsContent?: ReactNode;
  query: string;
  recentSuggestions: SearchSuggestion[];
  searchExamples: SearchSuggestion[];
  setSuggestionIndex: (index: number) => void;
  starterEmptyReason?: SearchStarterResponse["emptyReason"];
  starterLoading: boolean;
  starterStatus: SearchStarterResponse["status"];
  suggestionIndex: number;
  suggestions: SearchSuggestion[];
  timePresets: ReturnType<typeof getTimePresets>;
}

export function SearchSuggestionsPanel({
  clearHistory,
  onRemoveHistory,
  floatingPanelMaxHeight,
  handleSuggestionClick,
  handleSuggestionKeyDown,
  historyDisabled,
  onBlur,
  onRefreshStarters,
  onResetStarterFilters,
  onTimePresetSelect,
  panelRef,
  presetsContent,
  query,
  recentSuggestions,
  searchExamples,
  setSuggestionIndex,
  starterLoading,
  starterStatus,
  starterEmptyReason,
  suggestionIndex,
  suggestions,
  timePresets,
}: SearchSuggestionsPanelProps) {
  const { t } = useTranslation();
  const historyScrollRef = useRef<HTMLDivElement>(null);
  const [historyFade, setHistoryFade] = useState({ top: false, bottom: false });
  const updateHistoryFade = useCallback(() => {
    const list = historyScrollRef.current;
    if (!list) {
      return;
    }
    const top = list.scrollTop > 2;
    const bottom = list.scrollHeight - list.scrollTop - list.clientHeight > 2;
    setHistoryFade((previous) =>
      previous.top === top && previous.bottom === bottom
        ? previous
        : { top, bottom }
    );
  }, []);
  useEffect(() => {
    const list = historyScrollRef.current;
    if (query.trim() || recentSuggestions.length === 0 || !list) {
      return;
    }
    updateHistoryFade();
    const observer =
      typeof ResizeObserver === "undefined"
        ? undefined
        : new ResizeObserver(updateHistoryFade);
    observer?.observe(list);
    return () => observer?.disconnect();
  }, [query, recentSuggestions, updateHistoryFade]);
  const historyStatus = historyDisabled && (
    <span
      className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground/70"
      data-search-history-status
      role="status"
    >
      <EyeOff aria-hidden="true" className="h-3 w-3" />
      {t("searchHistoryUi.disabled")}
    </span>
  );
  const disabled = starterStatus === "color";
  let emptyKey = "searchStarterUi.empty";
  if (disabled) {
    emptyKey =
      starterStatus === "color"
        ? "searchStarterUi.colorMode"
        : "searchStarterAiUnavailable";
  } else if (starterEmptyReason === "library") {
    emptyKey = "searchStarterUi.emptyLibrary";
  } else if (starterEmptyReason === "scope") {
    emptyKey = "searchStarterUi.emptyScope";
  } else if (starterStatus === "unavailable") {
    emptyKey = "searchStarterUi.unavailable";
  } else if (starterStatus === "error") {
    emptyKey = "searchStarterUi.failed";
  } else if (starterStatus === "busy") {
    emptyKey = "searchStarterUi.busy";
  }
  return (
    <div
      className="@container/search-panel absolute top-full left-4 z-[60] mt-1 w-[min(960px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover shadow-xl outline-none ring-1 ring-foreground/5"
      data-overlay-kind="search-suggestions"
      data-surface="overlay"
      id="search-suggestions-listbox"
      onBlur={onBlur}
      onKeyDown={handleSuggestionKeyDown}
      ref={panelRef}
      role="listbox"
      style={{ maxHeight: Math.min(440, floatingPanelMaxHeight) }}
      tabIndex={0}
    >
      {presetsContent && (
        <div
          className="min-w-0 border-border border-b px-3 py-2"
          data-search-presets
        >
          {presetsContent}
        </div>
      )}
      {query.trim() ? (
        <div className="py-1.5">
          <div className="flex min-w-0 items-center justify-between gap-3 px-3 pb-1.5 font-medium text-[11px] text-muted-foreground">
            <span>{t("searchSuggestions")}</span>
            {historyStatus}
          </div>
          {suggestions.map((suggestion, index) => (
            <SuggestionButton
              index={index}
              isActive={index === suggestionIndex}
              key={
                suggestion.historyEntry?.id ??
                `${suggestion.type}-${suggestion.text}`
              }
              onClick={() => handleSuggestionClick(suggestion)}
              onMouseEnter={() => setSuggestionIndex(index)}
              onRemoveHistory={onRemoveHistory}
              suggestion={suggestion}
            />
          ))}
        </div>
      ) : (
        <>
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-border border-b px-3 py-2">
            <Clock
              aria-hidden="true"
              className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60"
            />
            <span className="mr-1 text-[11px] text-muted-foreground">
              {t("searchStarterUi.quickTime")}
            </span>
            {timePresets.map((preset) => (
              <button
                className="rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                data-search-action
                key={preset.label}
                onClick={() => onTimePresetSelect(preset)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div
            className={cn(
              "grid min-w-0 grid-cols-1",
              recentSuggestions.length > 0 &&
                "@min-[720px]/search-panel:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]"
            )}
            data-search-discovery-layout
          >
            <section
              aria-label={t("searchStarterTitle")}
              className="min-w-0 px-3 py-3"
              data-search-starters
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <span className="font-medium text-[12px] text-foreground">
                  {t("searchStarterTitle")}
                </span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      aria-label={t("searchStarterUi.refresh")}
                      className="flex shrink-0 items-center gap-1 rounded-[4px] px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground disabled:opacity-50"
                      data-search-action
                      disabled={starterStatus === "color" || starterLoading}
                      onClick={onRefreshStarters}
                      onMouseDown={(event) => event.preventDefault()}
                      type="button"
                    >
                      <RefreshCw
                        aria-hidden="true"
                        className={cn(
                          "h-3 w-3",
                          starterLoading && "motion-safe:animate-spin"
                        )}
                      />
                      {t("searchStarterUi.refresh")}
                    </button>
                  </TooltipTrigger>
                  <TooltipContent>
                    {t("searchStarterUi.refreshHint")}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="relative mt-2">
                <SearchStarterGallery
                  examples={disabled ? [] : searchExamples}
                  loading={starterLoading}
                  onHighlight={setSuggestionIndex}
                  onSelect={handleSuggestionClick}
                  status={starterStatus}
                  suggestionIndex={suggestionIndex}
                />
                {(disabled || searchExamples.length === 0) &&
                  !starterLoading && (
                    <div
                      className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-4 text-center text-[12px] text-muted-foreground"
                      role="status"
                    >
                      <span>{t(emptyKey)}</span>
                      {starterEmptyReason === "scope" && (
                        <button
                          className="rounded px-2 py-1 text-primary hover:bg-primary/10"
                          data-search-action
                          onClick={onResetStarterFilters}
                          type="button"
                        >
                          {t("searchStarterUi.clearFilters")}
                        </button>
                      )}
                    </div>
                  )}
              </div>
            </section>
            {recentSuggestions.length > 0 && (
              <section
                aria-label={t("recentSearches")}
                className="min-w-0 border-border border-t @min-[720px]/search-panel:border-t-0 @min-[720px]/search-panel:border-l py-3"
                data-search-history
              >
                <div className="mb-2 flex min-w-0 items-center justify-between gap-2 px-3">
                  <span className="font-medium text-[12px] text-foreground">
                    {t("recentSearches")}
                  </span>
                  <button
                    className="shrink-0 rounded-[4px] px-1.5 py-1 text-[11px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                    data-search-action
                    onClick={clearHistory}
                    type="button"
                  >
                    {t("clearAll")}
                  </button>
                </div>
                <div
                  className="search-history-scroll max-h-[200px] min-h-0 scroll-py-6 overflow-y-auto overscroll-contain"
                  data-bottom-fade={historyFade.bottom}
                  data-search-history-scroll
                  data-top-fade={historyFade.top}
                  onScroll={updateHistoryFade}
                  ref={historyScrollRef}
                >
                  {recentSuggestions.map((suggestion, index) => {
                    const itemIndex = searchExamples.length + index;
                    return (
                      <SuggestionButton
                        index={itemIndex}
                        isActive={itemIndex === suggestionIndex}
                        key={
                          suggestion.historyEntry?.id ??
                          `${suggestion.type}-${suggestion.text}`
                        }
                        onClick={() => handleSuggestionClick(suggestion)}
                        onMouseEnter={() => setSuggestionIndex(itemIndex)}
                        onRemoveHistory={onRemoveHistory}
                        suggestion={suggestion}
                      />
                    );
                  })}
                </div>
              </section>
            )}
          </div>
          <div
            className="flex min-w-0 items-center justify-between gap-3 border-border border-t px-3 py-2 text-[11px] text-muted-foreground"
            data-search-suggestions-footer
          >
            <span className="min-w-0">{t("searchStarterWildcardHint")}</span>
            {historyStatus}
          </div>
        </>
      )}
    </div>
  );
}

function SuggestionButton({
  suggestion,
  index,
  isActive,
  onClick,
  onMouseEnter,
  onRemoveHistory,
}: {
  suggestion: SearchSuggestion;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
  onRemoveHistory: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (suggestion.historyEntry) {
    return (
      <SearchHistorySuggestion
        entry={suggestion.historyEntry}
        index={index}
        isActive={isActive}
        onClick={onClick}
        onMouseEnter={onMouseEnter}
        onRemove={onRemoveHistory}
      />
    );
  }
  const isPerson = suggestion.type === "person";
  const cover = suggestion.coverThumbnailPath || suggestion.coverPhotoPath;
  let categoryLabel = suggestion.category;
  if (isPerson) {
    categoryLabel = t("searchStarterUi.person");
  } else if (suggestion.type === "tag") {
    categoryLabel = t("searchStarterUi.tag");
  }
  return (
    <SearchTextButton
      aria-label={suggestion.text}
      aria-selected={isActive}
      className={cn(
        "flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-[12px] transition-colors",
        isActive
          ? "bg-foreground/8 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
      data-suggestion-index={index}
      id={`search-suggestion-${index}`}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      onPointerMove={onMouseEnter}
      role="option"
      tabIndex={-1}
      tooltipText={suggestion.type === "history" ? undefined : suggestion.text}
      type="button"
    >
      {isPerson && cover ? (
        <img
          alt=""
          className="h-6 w-6 shrink-0 rounded-full object-cover"
          height={24}
          src={toLocalMediaUrl(cover)}
          width={24}
        />
      ) : null}
      {suggestion.type === "tag" ? (
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: suggestion.color }}
        />
      ) : null}
      {suggestion.type === "history" ? (
        <Clock
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
        />
      ) : null}
      {suggestion.type === "dictionary" || (isPerson && !cover) ? (
        <Search
          aria-hidden="true"
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/70"
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate" data-search-tooltip-text>
        {suggestion.text}
      </span>
      {suggestion.category || suggestion.type === "tag" ? (
        <span className="max-w-[35%] shrink-0 truncate text-[11px] text-muted-foreground">
          {categoryLabel}
        </span>
      ) : null}
    </SearchTextButton>
  );
}
