// biome-ignore-all lint/style/noNestedTernary: preserve existing suggestion styling
import { Clock, Search } from "lucide-react";
import type {
  FocusEventHandler,
  KeyboardEventHandler,
  ReactNode,
  Ref,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  getTimePresets,
  SearchSuggestion,
} from "@/components/search-bar-utils";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import { cn } from "@/utils/tailwind";

interface SearchSuggestionsPanelProps {
  clearHistory: () => void;
  examplesDisabled: boolean;
  floatingPanelMaxHeight: number;
  handleSuggestionClick: (suggestion: SearchSuggestion) => void;
  handleSuggestionKeyDown: KeyboardEventHandler<HTMLDivElement>;
  onBlur: FocusEventHandler<HTMLDivElement>;
  onTimePresetSelect: (
    preset: ReturnType<typeof getTimePresets>[number]
  ) => void;
  panelRef: Ref<HTMLDivElement>;
  presetsContent?: ReactNode;
  query: string;
  recentSuggestions: SearchSuggestion[];
  searchExamples: SearchSuggestion[];
  setSuggestionIndex: (index: number) => void;
  suggestionIndex: number;
  suggestions: SearchSuggestion[];
  timePresets: ReturnType<typeof getTimePresets>;
}
export function SearchSuggestionsPanel({
  clearHistory,
  examplesDisabled,
  floatingPanelMaxHeight,
  handleSuggestionClick,
  handleSuggestionKeyDown,
  onBlur,
  onTimePresetSelect,
  panelRef,
  presetsContent,
  query,
  recentSuggestions,
  searchExamples,
  setSuggestionIndex,
  suggestionIndex,
  suggestions,
  timePresets,
}: SearchSuggestionsPanelProps) {
  const { t } = useTranslation();
  return (
    <div
      className="absolute top-full left-4 z-[60] mt-1 w-[min(960px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover shadow-xl outline-none ring-1 ring-foreground/5"
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
        <>
          <div className="flex items-center justify-between px-3 py-1.5">
            <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
              {t("searchSuggestions")}
            </span>
          </div>
          {/* biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve the existing suggestion variants */}
          {suggestions.map((s, i) => (
            <button
              aria-selected={i === suggestionIndex}
              className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                i === suggestionIndex
                  ? "bg-foreground/8 text-foreground"
                  : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              }`}
              data-suggestion-index={i}
              id={`search-suggestion-${i}`}
              key={`${s.type}-${s.text}`}
              onClick={() => handleSuggestionClick(s)}
              onMouseDown={(e) => e.preventDefault()}
              onMouseEnter={() => setSuggestionIndex(i)}
              role="option"
              tabIndex={-1}
              type="button"
            >
              {s.type === "person" ? (
                <>
                  {s.coverThumbnailPath || s.coverPhotoPath ? (
                    <img
                      alt=""
                      className="h-6 w-6 flex-shrink-0 rounded-full object-cover"
                      height={24}
                      src={toLocalMediaUrl(
                        s.coverThumbnailPath || s.coverPhotoPath || ""
                      )}
                      width={24}
                    />
                  ) : (
                    <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center text-[10px]">
                      👤
                    </span>
                  )}
                  <span className="truncate">{s.text}</span>
                  <span className="ml-auto flex-shrink-0 rounded-[3px] bg-blue-500/10 px-1 text-[10px] text-blue-500">
                    人物
                  </span>
                </>
              ) : s.type === "dictionary" ? (
                <>
                  <Search className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                  <span className="truncate">{s.text}</span>
                  {s.category && (
                    <span className="ml-auto flex-shrink-0 rounded-[3px] bg-primary/10 px-1 text-[10px] text-primary/70">
                      {s.category}
                    </span>
                  )}
                </>
              ) : s.type === "tag" ? (
                <>
                  <span
                    className="h-2 w-2 flex-shrink-0 rounded-full"
                    style={{ background: s.color }}
                  />
                  <span className="truncate">{s.text}</span>
                  <span className="ml-auto flex-shrink-0 rounded-[3px] bg-green-500/10 px-1 text-[10px] text-green-500">
                    标签
                  </span>
                </>
              ) : (
                <>
                  <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                  <span className="truncate">{s.text}</span>
                </>
              )}
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5 border-border border-b px-3 py-2">
            <Clock className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
            {timePresets.map((preset) => (
              <button
                className="rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                key={preset.label}
                onClick={() => onTimePresetSelect(preset)}
                onMouseDown={(event) => event.preventDefault()}
                type="button"
              >
                {preset.label}
              </button>
            ))}
          </div>
          <div className="px-3 pt-2.5 pb-1.5">
            <div className="font-medium text-[12px] text-foreground">
              {t("searchStarterTitle")}
            </div>
            <div className="mt-0.5 text-[11px] text-muted-foreground/70">
              {t("searchStarterDescription")}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-1.5 px-3 pb-2.5">
            {searchExamples.map((example, i) => (
              <button
                aria-selected={!examplesDisabled && i === suggestionIndex}
                className={cn(
                  "flex min-w-0 items-center gap-2 rounded-[6px] border border-border px-2.5 py-2 text-left text-[12px] transition-colors",
                  examplesDisabled
                    ? "cursor-not-allowed text-muted-foreground/50"
                    : i === suggestionIndex
                      ? "border-primary/30 bg-primary/10 text-primary"
                      : "text-muted-foreground hover:border-primary/20 hover:bg-primary/5 hover:text-foreground"
                )}
                data-suggestion-index={examplesDisabled ? undefined : i}
                disabled={examplesDisabled}
                id={examplesDisabled ? undefined : `search-suggestion-${i}`}
                key={example.text}
                onClick={() => handleSuggestionClick(example)}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => {
                  if (!examplesDisabled) {
                    setSuggestionIndex(i);
                  }
                }}
                role="option"
                tabIndex={-1}
                type="button"
              >
                <Search className="h-3.5 w-3.5 flex-shrink-0" />
                <span className="truncate">{example.text}</span>
              </button>
            ))}
          </div>
          {examplesDisabled && (
            <div className="mx-3 mb-2 rounded-[5px] bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
              {t("searchStarterAiUnavailable")}
            </div>
          )}
          <div className="border-border border-t px-3 py-2 text-[10px] text-muted-foreground/70">
            {t("searchStarterWildcardHint")}
          </div>
          {recentSuggestions.length > 0 && (
            <>
              <div className="flex items-center justify-between border-border border-t px-3 py-1.5">
                <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("recentSearches")}
                </span>
                <button
                  className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                  onClick={clearHistory}
                  tabIndex={-1}
                  type="button"
                >
                  {t("clearAll")}
                </button>
              </div>
              {recentSuggestions.map((s, historyIndex) => {
                const i =
                  (examplesDisabled ? 0 : searchExamples.length) + historyIndex;
                return (
                  <SuggestionButton
                    index={i}
                    isActive={i === suggestionIndex}
                    key={`${s.type}-${s.text}`}
                    onClick={() => handleSuggestionClick(s)}
                    onMouseEnter={() => setSuggestionIndex(i)}
                    suggestion={s}
                  />
                );
              })}
            </>
          )}
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
}: {
  suggestion: SearchSuggestion;
  index: number;
  isActive: boolean;
  onClick: () => void;
  onMouseEnter: () => void;
}) {
  return (
    <button
      aria-selected={isActive}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors",
        isActive
          ? "bg-foreground/8 text-foreground"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
      )}
      data-suggestion-index={index}
      id={`search-suggestion-${index}`}
      onClick={onClick}
      onMouseDown={(event) => event.preventDefault()}
      onMouseEnter={onMouseEnter}
      role="option"
      tabIndex={-1}
      type="button"
    >
      <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
      <span className="truncate">{suggestion.text}</span>
    </button>
  );
}
