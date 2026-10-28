// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: scoped component lint cleanup preserves existing UI behavior
import { useNavigate } from "@tanstack/react-router";
import { Filter, ImageUp, Search, X } from "lucide-react";
import {
  type Dispatch,
  forwardRef,
  memo,
  type ReactNode,
  type SetStateAction,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import type {
  SearchPreset,
  SearchPresetContext,
} from "@/actions/search-presets";
import { AiIndexRebuildNotice } from "@/components/AiIndexRebuildNotice";
import { FilterPresets } from "@/components/FilterPresets";
import { SmoothInput } from "@/components/ui/smooth-input";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { SearchActiveFilters } from "@/features/search-bar/SearchActiveFilters";
import { SearchExifPanel } from "@/features/search-bar/SearchExifPanel";
import { SearchSuggestionsPanel } from "@/features/search-bar/SearchSuggestionsPanel";
import { useSearchCandidates } from "@/features/search-bar/use-search-candidates";
import { useSearchHistory } from "@/features/search-bar/use-search-history";
import { useSearchOverlayInteraction } from "@/features/search-bar/use-search-overlay-interaction";
import { useSearchStarters } from "@/features/search-bar/use-search-starters";
import type { ExifFilters, SearchMode } from "@/types/search";
import { searchHistoryLabel } from "@/types/search-history";
import { getSearchSuggestions } from "@/utils/search-suggestions";
import {
  getTimePresets,
  type SearchSuggestion,
  type TagInfo,
} from "./search-bar-utils";
import {
  SemanticSearchDiagnostics,
  type SemanticSearchDiagnosticsProps,
} from "./semantic-search-diagnostics";

const PATH_SEPARATOR_PATTERN = /[\\/]/;

interface ImageSearchReference {
  imagePath: string;
  previewDataUrl: string | null;
}

function getFileName(filePath: string): string {
  return (
    filePath.split(PATH_SEPARATOR_PATTERN).filter(Boolean).at(-1) ?? filePath
  );
}

interface SearchBarProps {
  activeTagIds?: number[];
  aiStatus?: {
    coverageState?: "ready" | "partial" | "unavailable" | "error";
    model: string;
    vectorDB: string;
    hasVectors: boolean;
    vectorCount: number;
    indexReady: boolean;
    rebuildRequired?: boolean;
    indexedPhotos?: number;
    isEmbedding: boolean;
    totalPhotos?: number;
    embeddingProgress: { processed: number; total: number; phase: string };
  } | null;
  colorHex?: string | null;
  drillDownFilters?: ExifFilters;
  filterBarLeadingContent?: ReactNode;
  filterBarTrailingContent?: ReactNode;
  filters: ExifFilters;
  imageSearchActive?: boolean;
  imageSearchReference?: ImageSearchReference;
  leadingContent?: ReactNode;
  onClear: () => void;
  onFiltersChange: Dispatch<SetStateAction<ExifFilters>>;
  onImageSearch?: (imagePath: string) => void;
  onLoadSearchPreset?: (preset: SearchPreset) => void;
  onQueryChange: (query: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
  onTagRemove?: (tagId: number) => void;
  onTagSelect?: (tag: TagInfo) => void;
  query: string;
  resetVersion?: number;
  resultCount?: number;
  searchMode?: SearchMode | null;
  searchPresetContext?: SearchPresetContext;
  searchTime?: number;
  semanticDiagnostics?: SemanticSearchDiagnosticsProps;
  trailingContent?: ReactNode;
}

export const SearchBar = memo(
  forwardRef<HTMLElement, SearchBarProps>(
    (
      {
        activeTagIds,
        aiStatus,
        colorHex,
        searchPresetContext,
        onLoadSearchPreset,
        drillDownFilters,
        filterBarLeadingContent,
        filterBarTrailingContent,
        filters,
        imageSearchActive,
        imageSearchReference,
        leadingContent,
        onFiltersChange: setFilters,
        onQueryChange: setQuery,
        onSearch,
        onTagRemove,
        onTagSelect,
        onClear,
        onImageSearch,
        query,
        resetVersion,
        resultCount,
        searchMode,
        searchTime,
        semanticDiagnostics,
        trailingContent,
      }: SearchBarProps,
      ref
    ) => {
      const { t, i18n } = useTranslation();
      const timePresets = useMemo(() => getTimePresets(t), [t]);
      const {
        history,
        preferences: historyPreferences,
        ready: historyReady,
        addToHistory,
        removeHistory,
        clearHistory: clearSavedSearchHistory,
      } = useSearchHistory();
      const {
        tags,
        cameraModels,
        creators,
        lensModels,
        advancedCategories,
        personOptions,
        dictSuggestionsEnabled,
      } = useSearchCandidates();
      const navigate = useNavigate();

      // Filter suggestions: person names + dictionary + tags + recent searches
      const suggestions = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) {
          return [];
        }

        const all: SearchSuggestion[] = [];

        // 1) Person name matches
        const matchingPersons = personOptions
          .filter((p) => p.name.toLowerCase().includes(q))
          .slice(0, 3);
        const seen = new Set<string>();
        for (const p of matchingPersons) {
          all.push({
            type: "person",
            text: p.name,
            category: "person",
            id: p.id,
            coverThumbnailPath: p.coverThumbnailPath,
            coverPhotoPath: p.coverPhotoPath,
          });
          seen.add(p.name.toLowerCase());
        }

        // 2) AI dictionary suggestions (from search-suggestions)
        // Allow single-char for pinyin matching (e.g. "h" → "海")
        if (dictSuggestionsEnabled && q.length >= 1) {
          const dictSuggestions = getSearchSuggestions(q, 4);
          for (const s of dictSuggestions) {
            if (seen.has(s.word.toLowerCase())) {
              continue;
            }
            all.push({
              type: "dictionary",
              text: s.word,
              category: s.category,
            });
          }
        }

        // 3) Tag matches
        const matchingTags = tags
          .filter((t) => t.name.toLowerCase().includes(q))
          .slice(0, 4)
          .map((t) => ({
            type: "tag" as const,
            tagId: t.id,
            text: t.name,
            color: t.color || "var(--primary)",
          }));
        all.push(...matchingTags);

        // 4) History matches
        const matchingHistory = history
          .filter((entry) =>
            searchHistoryLabel(entry).toLowerCase().includes(q)
          )
          .map((entry) => ({
            type: "history" as const,
            text: searchHistoryLabel(entry),
            historyEntry: entry,
          }));
        all.push(...matchingHistory);

        return all;
      }, [query, tags, history, personOptions, dictSuggestionsEnabled]);

      const examplesDisabled =
        aiStatus === null ||
        Boolean(
          aiStatus &&
            (aiStatus.rebuildRequired ||
              aiStatus.isEmbedding ||
              aiStatus.model === "loading" ||
              aiStatus.model === "error" ||
              aiStatus.vectorDB !== "ready" ||
              !aiStatus.hasVectors ||
              !aiStatus.indexReady)
        );
      const recentSuggestions = useMemo<SearchSuggestion[]>(
        () =>
          history.map((entry) => ({
            type: "history",
            text: searchHistoryLabel(entry),
            historyEntry: entry,
          })),
        [history]
      );
      const {
        inputRef,
        dropdownRef,
        toolbarRef,
        suggestionListRef,
        showSuggestions,
        setShowSuggestions,
        inputFocused,
        setInputFocused,
        showFilters,
        setShowFilters,
        suggestionIndex,
        setSuggestionIndex,
        floatingPanelMaxHeight,
        showSuggestionPanel,
        handleInputBlur,
      } = useSearchOverlayInteraction({
        query,
        imageSearchActive,
        hasSuggestions: suggestions.length > 0 || Boolean(searchPresetContext),
      });
      const starters = useSearchStarters({
        open: showSuggestionPanel && !query.trim(),
        enabled: !imageSearchActive && historyReady,
        historyEnabled: historyReady && historyPreferences.enabled,
        semanticEnabled: !examplesDisabled,
        language: i18n?.resolvedLanguage ?? i18n?.language ?? "zh",
        history: history.flatMap((entry) =>
          entry.kind === "text" ? [entry.query] : []
        ),
        filters,
        colorHex,
      });
      const searchExamples = useMemo<SearchSuggestion[]>(
        () =>
          starters.batch.map((starter) => ({
            ...starter,
            previewVersion: starters.validity,
            type: "example",
          })),
        [starters.batch, starters.validity]
      );
      const displayedSuggestions = useMemo(
        () =>
          query.trim()
            ? suggestions
            : [...searchExamples, ...recentSuggestions],
        [query, suggestions, searchExamples, recentSuggestions]
      );
      const previousSuggestions = useRef(displayedSuggestions);
      useLayoutEffect(() => {
        const active = previousSuggestions.current[suggestionIndex];
        previousSuggestions.current = displayedSuggestions;
        if (!active || suggestionIndex < 0) {
          return;
        }
        const nextIndex = displayedSuggestions.findIndex(
          (item) =>
            item.type === active.type &&
            item.text === active.text &&
            item.id === active.id &&
            item.tagId === active.tagId &&
            item.historyEntry?.id === active.historyEntry?.id
        );
        if (nextIndex !== suggestionIndex) {
          setSuggestionIndex(nextIndex);
        }
      }, [displayedSuggestions, suggestionIndex, setSuggestionIndex]);
      const fileInputRef = useRef<HTMLInputElement>(null);
      const [_locallyDragging, _setLocallyDragging] = useState(false);
      const [failedImagePreviewUrl, setFailedImagePreviewUrl] = useState<
        string | null
      >(null);
      const imageSearchFileName = imageSearchReference
        ? getFileName(imageSearchReference.imagePath)
        : "";

      function clearHistory() {
        clearSavedSearchHistory();
        setSuggestionIndex(-1);
      }

      const [drillOriginFilters, setDrillOriginFilters] = useState<
        Set<keyof ExifFilters>
      >(new Set());

      useEffect(() => {
        setDrillOriginFilters(
          new Set(
            Object.keys(drillDownFilters ?? {}) as Array<keyof ExifFilters>
          )
        );
      }, [drillDownFilters]);

      const hasActiveFilters = Object.values(filters).some(
        (v) => v && v.length > 0
      );
      const activeFilterCount = [
        filters.dateFrom,
        filters.dateTo,
        filters.dateMonth,
        filters.dateHour,
        filters.cameraModel,
        filters.creator,
        filters.lensModel,
        filters.advancedField && filters.advancedValue,
        filters.isoMin,
        filters.isoMax,
        filters.apertureMin,
        filters.apertureMax,
        filters.focalMin,
        filters.focalMax,
        filters.shutterMin || filters.shutterMax,
      ].filter(Boolean).length;

      useEffect(() => {
        setDrillOriginFilters(new Set());
        setShowSuggestions(false);
        setShowFilters(false);
        setSuggestionIndex(-1);
        setInputFocused(false);
      }, [
        setInputFocused,
        setShowFilters,
        setShowSuggestions,
        setSuggestionIndex,
      ]);

      const cameraSuggestions = useMemo(() => {
        if (!filters.cameraModel) {
          return cameraModels.slice(0, 20);
        }
        const q = filters.cameraModel.toLowerCase();
        return cameraModels
          .filter((m) => m.toLowerCase().includes(q))
          .slice(0, 20);
      }, [filters.cameraModel, cameraModels]);

      const lensSuggestions = useMemo(() => {
        if (!filters.lensModel) {
          return lensModels.slice(0, 20);
        }
        const q = filters.lensModel.toLowerCase();
        return lensModels
          .filter((m) => m.toLowerCase().includes(q))
          .slice(0, 20);
      }, [filters.lensModel, lensModels]);

      const creatorSuggestions = useMemo(() => {
        if (!filters.creator) {
          return creators.slice(0, 20);
        }
        const query = filters.creator.toLocaleLowerCase();
        return creators
          .filter((creator) => creator.toLocaleLowerCase().includes(query))
          .slice(0, 20);
      }, [creators, filters.creator]);

      function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (
          e.key === "ArrowDown" &&
          showSuggestionPanel &&
          displayedSuggestions.length > 0
        ) {
          e.preventDefault();
          focusKeyboardSuggestion(0);
          return;
        }
        if (e.key === "Escape") {
          if (showSuggestions) {
            e.preventDefault();
            setShowSuggestions(false);
            setSuggestionIndex(-1);
            return;
          }
          if (query.trim()) {
            e.preventDefault();
            handleClear();
          }
        }
      }

      function focusKeyboardSuggestion(index: number) {
        setSuggestionIndex(index);
        const button =
          suggestionListRef.current?.querySelector<HTMLButtonElement>(
            `[data-suggestion-index="${index}"]`
          );
        (button ?? suggestionListRef.current)?.focus({ preventScroll: true });
        button?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      }

      function handleSuggestionKeyDown(e: React.KeyboardEvent) {
        if (
          e.target instanceof Element &&
          e.target.closest(
            '[data-search-presets], [data-search-action], [data-overlay-kind="filter-presets"]'
          )
        ) {
          return;
        }
        if (searchPresetContext && e.key === "Tab") {
          setSuggestionIndex(-1);
          return;
        }
        const len = displayedSuggestions.length;
        if (len === 0) {
          return;
        }
        const focusedSuggestion =
          e.target instanceof Element
            ? e.target.closest("[data-suggestion-index]")
            : null;
        const navigationIndex = focusedSuggestion
          ? Number(focusedSuggestion.getAttribute("data-suggestion-index"))
          : suggestionIndex;

        if (
          [
            "ArrowLeft",
            "ArrowRight",
            "ArrowDown",
            "ArrowUp",
            "Enter",
            "Escape",
            "Tab",
          ].includes(e.key)
        ) {
          // Keep gallery-level shortcuts from stealing focus from the open listbox.
          e.stopPropagation();
        }

        switch (e.key) {
          case "Delete": {
            const entry = displayedSuggestions[navigationIndex]?.historyEntry;
            if (entry) {
              e.preventDefault();
              e.stopPropagation();
              removeHistory(entry.id);
              setSuggestionIndex(-1);
              suggestionListRef.current?.focus();
            }
            break;
          }
          case "ArrowLeft":
          case "ArrowRight":
            if (
              navigationIndex >= 0 &&
              navigationIndex < searchExamples.length
            ) {
              e.preventDefault();
              const step = e.key === "ArrowRight" ? 1 : -1;
              focusKeyboardSuggestion(
                (navigationIndex + step + searchExamples.length) %
                  searchExamples.length
              );
            }
            break;
          case "ArrowDown":
            e.preventDefault();
            focusKeyboardSuggestion((navigationIndex + 1) % len);
            break;
          case "ArrowUp":
            e.preventDefault();
            focusKeyboardSuggestion((navigationIndex - 1 + len) % len);
            break;
          case "Enter":
            e.preventDefault();
            if (navigationIndex >= 0 && navigationIndex < len) {
              handleSuggestionClick(displayedSuggestions[navigationIndex]);
            }
            break;
          case "Escape":
            e.preventDefault();
            inputRef.current?.focus();
            setShowSuggestions(false);
            setSuggestionIndex(-1);
            break;
          case "Tab":
            e.preventDefault();
            focusKeyboardSuggestion((navigationIndex + 1) % len);
            break;
          default:
            break;
        }
      }

      function handleSubmit(e: React.FormEvent) {
        e.preventDefault();
        if (!(query.trim() || hasActiveFilters)) {
          return;
        }
        if (query.trim()) {
          addToHistory(query.trim());
        }
        onSearch(query.trim(), hasActiveFilters ? filters : undefined);
        setShowSuggestions(false);
      }

      function handleClear() {
        setQuery("");
        onClear();
        requestAnimationFrame(() => inputRef.current?.focus());
      }

      function handleSuggestionClick(suggestion: SearchSuggestion) {
        if (suggestion.historyEntry?.kind === "image") {
          onImageSearch?.(suggestion.historyEntry.imagePath);
          setShowSuggestions(false);
          setSuggestionIndex(-1);
          return;
        }
        if (suggestion.type === "person" && suggestion.id != null) {
          navigate({
            to: "/people/$identityId",
            params: { identityId: String(suggestion.id) },
          });
          setShowSuggestions(false);
          setSuggestionIndex(-1);
          return;
        }
        if (
          suggestion.type === "tag" &&
          suggestion.tagId !== undefined &&
          onTagSelect
        ) {
          const tag = tags.find((item) => item.id === suggestion.tagId);
          setQuery("");
          onTagSelect(
            tag ?? {
              id: suggestion.tagId,
              name: suggestion.text,
              color: suggestion.color ?? null,
            }
          );
          setShowSuggestions(false);
          setSuggestionIndex(-1);
          return;
        }
        const searchQuery = suggestion.query ?? suggestion.text;
        const nextFilters = suggestion.filters
          ? { ...filters, ...suggestion.filters }
          : filters;
        const hasFilters = Object.values(nextFilters).some(Boolean);
        if (suggestion.filters) {
          setFilters(nextFilters);
        }
        setQuery(searchQuery);
        addToHistory(searchQuery);
        onSearch(searchQuery, hasFilters ? nextFilters : undefined);
        setShowSuggestions(false);
      }

      function updateFilter(
        key: keyof ExifFilters,
        value: string,
        triggerSearch = false
      ) {
        setFilters((prev) => {
          const next = { ...prev, [key]: value };
          if (triggerSearch) {
            const hasAny = Object.values(next).some((v) => v);
            queueMicrotask(() =>
              onSearch(query.trim(), hasAny ? next : undefined)
            );
          }
          return next;
        });
      }

      function applyIsoPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "100-400": ["100", "400"],
          "400-1600": ["400", "1600"],
          "1600-6400": ["1600", "6400"],
          "6400+": ["6400", ""],
        };
        const [min, max] = map[preset];
        updateFilter("isoMin", min);
        updateFilter("isoMax", max);
      }

      function applyAperturePreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "f/1.4-2.8": ["1.4", "2.8"],
          "f/2.8-5.6": ["2.8", "5.6"],
          "f/5.6-11": ["5.6", "11"],
          "f/11+": ["11", ""],
        };
        const [min, max] = map[preset];
        updateFilter("apertureMin", min);
        updateFilter("apertureMax", max);
      }

      function applyFocalPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "<35mm": ["", "35"],
          "35-85mm": ["35", "85"],
          "85-200mm": ["85", "200"],
          ">200mm": ["200", ""],
        };
        const [min, max] = map[preset];
        updateFilter("focalMin", min);
        updateFilter("focalMax", max);
      }

      function applyShutterPreset(preset: string) {
        const map: Record<string, [string, string]> = {
          "1/1000+": ["0.001", ""],
          "1/100-1/10": ["0.001", "0.1"],
          "1s+": ["1", ""],
          "30s+": ["30", ""],
        };
        const [min, max] = map[preset];
        updateFilter("shutterMin", min);
        updateFilter("shutterMax", max);
      }

      function clearFilters() {
        setFilters({});
        setDrillOriginFilters(new Set());
        if (query.trim()) {
          onSearch(query.trim(), undefined);
        } else {
          onClear();
        }
      }

      const handleRemoveAdvancedFilter = () => {
        setFilters((previous) => {
          const next = {
            ...previous,
            advancedField: undefined,
            advancedValue: undefined,
          };
          const hasAny = Object.values(next).some((v) => v);
          queueMicrotask(() =>
            onSearch(query.trim(), hasAny ? next : undefined)
          );
          return next;
        });
      };

      const handleRemoveShutterFilter = () => {
        setFilters((prev) => {
          const next = {
            ...prev,
            shutterMin: "",
            shutterMax: "",
          };
          const hasAny = Object.values(next).some((v) => v);
          queueMicrotask(() =>
            onSearch(query.trim(), hasAny ? next : undefined)
          );
          return next;
        });
      };

      function handleFilterKeyDown(e: React.KeyboardEvent) {
        if (e.key === "Enter") {
          e.preventDefault();
          onSearch(query.trim(), hasActiveFilters ? filters : undefined);
          setShowFilters(false);
        }
      }

      // Determine search placeholder based on AI status
      function getPlaceholder(): string {
        if (imageSearchActive) {
          return t("imageSearchMode");
        }
        return t("searchPlaceholder");
      }

      const selectedTags = useMemo(() => {
        if (!activeTagIds?.length) {
          return [];
        }
        const selected = new Set(activeTagIds);
        return tags.filter((tag) => selected.has(tag.id));
      }, [activeTagIds, tags]);

      return (
        <search
          aria-label={t("searchPlaceholder")}
          className="home-unified-toolbar relative min-w-0 border-border border-b transition-colors"
          data-surface="toolbar-content"
          ref={(node) => {
            toolbarRef.current = node;
            if (typeof ref === "function") {
              ref(node);
            } else if (ref) {
              ref.current = node;
            }
          }}
        >
          <div className="home-toolbar-inner px-3 py-2">
            {/* Search input row */}
            <div className="home-toolbar-primary-row flex min-h-9 min-w-0 flex-wrap items-center gap-2">
              {leadingContent && (
                <div className="home-toolbar-context min-w-0 flex-shrink-0">
                  {leadingContent}
                </div>
              )}
              <form
                className="home-search-form relative xl:max-w-[720px]"
                onSubmit={handleSubmit}
              >
                {imageSearchActive && imageSearchReference ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("imageSearchReferenceHint", {
                          filename: imageSearchFileName,
                        })}
                        className="home-image-search-reference home-search-input is-active flex h-9 w-full min-w-0 items-center gap-2 rounded-[6px] border border-border pr-10 pl-1.5 text-left text-[14px] text-foreground outline-none transition-colors focus:border-primary focus:ring-1 focus:ring-ring"
                        data-surface="control"
                        onClick={() => fileInputRef.current?.click()}
                        type="button"
                      >
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center overflow-hidden rounded-[4px] bg-foreground/5 text-muted-foreground">
                          {imageSearchReference.previewDataUrl &&
                          failedImagePreviewUrl !==
                            imageSearchReference.previewDataUrl ? (
                            <img
                              alt=""
                              aria-hidden="true"
                              className="h-full w-full object-cover"
                              height={28}
                              onError={() =>
                                setFailedImagePreviewUrl(
                                  imageSearchReference.previewDataUrl
                                )
                              }
                              src={imageSearchReference.previewDataUrl}
                              width={28}
                            />
                          ) : (
                            <ImageUp aria-hidden="true" className="h-4 w-4" />
                          )}
                        </span>
                        <span className="home-image-search-reference-label text-[11px] text-muted-foreground">
                          {t("searchModeImage")}
                        </span>
                        <span className="home-image-search-reference-name min-w-0 truncate font-medium">
                          {imageSearchFileName}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("imageSearchReferenceHint", {
                        filename: imageSearchFileName,
                      })}
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  <>
                    <span
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-y-0 left-0 z-[100] flex w-9 items-center justify-center"
                      style={{
                        color: "var(--muted-foreground)",
                        zIndex: 100,
                      }}
                    >
                      <Search className="h-4 w-4 shrink-0" strokeWidth={2} />
                    </span>
                    <SmoothInput
                      aria-activedescendant={
                        suggestionIndex >= 0
                          ? `search-suggestion-${suggestionIndex}`
                          : undefined
                      }
                      aria-autocomplete="list"
                      aria-controls="search-suggestions-listbox"
                      aria-expanded={showSuggestionPanel}
                      className={`home-search-input h-9 w-full rounded-[6px] border border-border pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-ring ${inputFocused || showSuggestionPanel || showFilters || query.trim() ? "is-active" : ""}`}
                      data-surface="control"
                      onBlur={handleInputBlur}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setShowSuggestions(true);
                        setSuggestionIndex(-1); // 输入变化时重置高亮
                      }}
                      onClick={() => {
                        setShowSuggestions(true);
                        setShowFilters(false);
                      }}
                      onFocus={() => {
                        setInputFocused(true);
                        if (showFilters) {
                          setShowFilters(false);
                        }
                        setShowSuggestions(true);
                      }}
                      onKeyDown={handleInputKeyDown}
                      placeholder={getPlaceholder()}
                      ref={inputRef}
                      role="combobox"
                      type="text"
                      value={query}
                    />
                  </>
                )}
                {(query || imageSearchActive) && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("clearSearch")}
                        className="absolute top-1/2 right-1 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-[5px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        onClick={handleClear}
                        type="button"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("clearSearch")}</TooltipContent>
                  </Tooltip>
                )}
              </form>

              {(searchMode || resultCount !== undefined) && (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="home-search-result-summary inline-flex h-7 flex-shrink-0 items-center gap-1 rounded-[5px] bg-foreground/5 px-2 text-[10px] text-muted-foreground">
                      {searchMode === "color" && colorHex && (
                        <span
                          className="h-2 w-2 rounded-full"
                          style={{ backgroundColor: `#${colorHex}` }}
                        />
                      )}
                      {resultCount === undefined
                        ? searchMode === "image"
                          ? t("searchModeImage")
                          : searchMode === "color"
                            ? t("searchModeColor")
                            : searchMode === "exif"
                              ? t("searchModeExif")
                              : t("searchModeSemantic")
                        : resultCount > 0
                          ? t("resultCount", { count: resultCount })
                          : t("noMatchResult")}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>
                    {searchTime === undefined
                      ? t("searchSuggestions")
                      : `${searchTime < 1000 ? `${searchTime}ms` : `${(searchTime / 1000).toFixed(1)}s`}`}
                  </TooltipContent>
                </Tooltip>
              )}

              {searchMode === "text" && semanticDiagnostics?.used && (
                <SemanticSearchDiagnostics {...semanticDiagnostics} />
              )}

              {onImageSearch && (
                <>
                  <input
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        const filePath =
                          window.electronAPI?.getFilePath?.(file);
                        if (filePath) {
                          onImageSearch(filePath);
                        }
                      }
                      e.target.value = "";
                    }}
                    ref={fileInputRef}
                    type="file"
                  />
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        aria-label={t("searchModeImage")}
                        className={`flex h-9 items-center justify-center gap-1.5 rounded-[6px] px-2.5 text-[12px] transition-colors ${
                          imageSearchActive
                            ? "bg-primary/10 text-primary"
                            : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                        }`}
                        onClick={() => fileInputRef.current?.click()}
                        type="button"
                      >
                        <ImageUp className="h-4 w-4" />
                        <span className="home-image-search-label">
                          {t("searchModeImage")}
                        </span>
                      </button>
                    </TooltipTrigger>
                    <TooltipContent>{t("imageSearchTitle")}</TooltipContent>
                  </Tooltip>
                </>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    aria-expanded={showFilters}
                    aria-label={t("exifFilterTitle")}
                    className={`flex h-9 flex-shrink-0 items-center justify-center gap-1 rounded-[6px] px-2 transition-colors ${
                      showFilters || hasActiveFilters
                        ? "bg-primary/10 text-primary"
                        : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                    }`}
                    onClick={() => {
                      setShowFilters((prev) => {
                        const next = !prev;
                        if (next) {
                          setShowSuggestions(false);
                          setSuggestionIndex(-1);
                        }
                        return next;
                      });
                    }}
                    type="button"
                  >
                    <Filter className="h-4 w-4" />
                    {hasActiveFilters && (
                      <span className="home-filter-summary whitespace-nowrap text-[10px]">
                        {t("exifFilterTitle")} · {activeFilterCount}
                      </span>
                    )}
                  </button>
                </TooltipTrigger>
                <TooltipContent>{t("exifFilterTitle")}</TooltipContent>
              </Tooltip>
              {aiStatus?.coverageState &&
                aiStatus.coverageState !== "ready" &&
                aiStatus.coverageState !== "error" && (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        aria-label={t("semanticSearchPartial", {
                          indexed: aiStatus.indexedPhotos ?? 0,
                          total: aiStatus.totalPhotos ?? 0,
                        })}
                        className="flex h-9 w-5 items-center justify-center text-amber-500"
                        role="status"
                        // biome-ignore lint/a11y/noNoninteractiveTabindex: expose the AI-status Tooltip to keyboard users.
                        tabIndex={0}
                      >
                        <span className="h-1.5 w-1.5 rounded-full bg-current" />
                      </span>
                    </TooltipTrigger>
                    <TooltipContent>
                      {t("semanticSearchPartial", {
                        indexed: aiStatus.indexedPhotos ?? 0,
                        total: aiStatus.totalPhotos ?? 0,
                      })}
                    </TooltipContent>
                  </Tooltip>
                )}
              {trailingContent && (
                <div className="home-toolbar-actions ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
                  {trailingContent}
                </div>
              )}
            </div>

            {selectedTags.length > 0 && (
              <div className="mt-2 flex flex-wrap items-center gap-1.5">
                {selectedTags.map((tag) => (
                  <span
                    className="inline-flex h-6 min-w-0 max-w-full items-center gap-1 rounded-[5px] border border-primary/20 bg-primary/10 px-2 font-medium text-[11px] text-primary"
                    key={tag.id}
                  >
                    <span
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{
                        backgroundColor: tag.color || "var(--primary)",
                      }}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span
                          className="min-w-0 flex-1 truncate"
                          // biome-ignore lint/a11y/noNoninteractiveTabindex: truncated tag must expose its Tooltip to keyboard users
                          tabIndex={0}
                        >
                          {t("tagFilterChip", { name: tag.name })}
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-[min(28rem,calc(100vw-1rem))] break-all">
                        {t("tagFilterChip", { name: tag.name })}
                      </TooltipContent>
                    </Tooltip>
                    {onTagRemove && (
                      <button
                        aria-label={t("removeTagFilter", { name: tag.name })}
                        className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded hover:bg-primary/15"
                        onClick={() => onTagRemove(tag.id)}
                        type="button"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}

            {aiStatus?.rebuildRequired && (
              <div className="mt-2 min-w-0">
                <AiIndexRebuildNotice
                  onOpenSettings={() => navigate({ to: "/settings/ai-index" })}
                />
              </div>
            )}
            {!aiStatus?.rebuildRequired &&
              aiStatus?.coverageState === "error" && (
                <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                  {t("semanticSearchUnavailable")}
                </div>
              )}

            <SearchActiveFilters
              filterBarLeadingContent={filterBarLeadingContent}
              filterBarTrailingContent={filterBarTrailingContent}
              filters={filters}
              hasActiveFilters={hasActiveFilters}
              onClear={clearFilters}
              onRemoveAdvancedFilter={handleRemoveAdvancedFilter}
              onRemoveFilter={(key) => updateFilter(key, "", true)}
              onRemoveShutterFilter={handleRemoveShutterFilter}
            />

            {/* Filter panel */}
            {showFilters && (
              <SearchExifPanel
                candidates={{
                  advancedCategories,
                  cameraSuggestions,
                  creatorSuggestions,
                  lensSuggestions,
                }}
                clearFilters={clearFilters}
                currentSearch={
                  imageSearchActive ? undefined : searchPresetContext
                }
                drillOriginFilters={drillOriginFilters}
                filters={filters}
                floatingPanelMaxHeight={floatingPanelMaxHeight}
                onApply={() => {
                  onSearch(
                    query.trim(),
                    hasActiveFilters ? filters : undefined
                  );
                }}
                onClose={() => setShowFilters(false)}
                onKeyDown={handleFilterKeyDown}
                onLoadPreset={setFilters}
                onLoadSearchPreset={
                  imageSearchActive ? undefined : onLoadSearchPreset
                }
                rangePresets={{
                  iso: applyIsoPreset,
                  aperture: applyAperturePreset,
                  focal: applyFocalPreset,
                  shutter: applyShutterPreset,
                }}
                setDrillOriginFilters={setDrillOriginFilters}
                updateFilter={updateFilter}
              />
            )}
          </div>

          {showSuggestionPanel && (
            <SearchSuggestionsPanel
              clearHistory={clearHistory}
              floatingPanelMaxHeight={floatingPanelMaxHeight}
              handleSuggestionClick={handleSuggestionClick}
              handleSuggestionKeyDown={handleSuggestionKeyDown}
              historyDisabled={historyReady && !historyPreferences.enabled}
              onBlur={(e) => {
                // 焦点离开建议列表且没有回到 input 时关闭
                const related = e.relatedTarget as Node | null;
                if (
                  related &&
                  (suggestionListRef.current?.contains(related) ||
                    (related instanceof Element &&
                      related.closest(
                        '[data-overlay-kind="filter-presets"]'
                      )) ||
                    related === inputRef.current)
                ) {
                  return;
                }
                setShowSuggestions(false);
                setSuggestionIndex(-1);
              }}
              onRefreshStarters={() => {
                setSuggestionIndex(-1);
                starters.refresh().catch(() => undefined);
              }}
              onRemoveHistory={(id) => {
                removeHistory(id);
                setSuggestionIndex(-1);
                suggestionListRef.current?.focus({ preventScroll: true });
              }}
              onResetStarterFilters={() => {
                setFilters({});
                onSearch("");
              }}
              onTimePresetSelect={(preset) => {
                const range = preset.getRange();
                const nextFilters: ExifFilters = {
                  ...filters,
                  dateFrom: range.dateFrom,
                  dateTo: range.dateTo,
                };
                setFilters(nextFilters);
                setShowSuggestions(false);
                queueMicrotask(() => onSearch("", nextFilters));
              }}
              panelRef={(node) => {
                (
                  dropdownRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
                (
                  suggestionListRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
              }}
              presetsContent={
                searchPresetContext && (
                  <FilterPresets
                    currentFilters={filters}
                    currentSearch={searchPresetContext}
                    onLoadPreset={setFilters}
                    onLoadSearchPreset={(preset) => {
                      if (onLoadSearchPreset) {
                        onLoadSearchPreset(preset);
                      } else {
                        setFilters(preset.filters);
                      }
                      setShowSuggestions(false);
                      setSuggestionIndex(-1);
                    }}
                    presentation="inline"
                  />
                )
              }
              query={query}
              recentSuggestions={recentSuggestions}
              searchExamples={searchExamples}
              setSuggestionIndex={setSuggestionIndex}
              starterEmptyReason={starters.emptyReason}
              starterLoading={starters.loading}
              starterStatus={starters.status}
              suggestionIndex={suggestionIndex}
              suggestions={suggestions}
              timePresets={timePresets}
            />
          )}
        </search>
      );
    }
  ),
  (prevProps, nextProps) => {
    if (
      prevProps.searchPresetContext !== nextProps.searchPresetContext ||
      prevProps.onLoadSearchPreset !== nextProps.onLoadSearchPreset
    ) {
      return false;
    }
    if (prevProps.aiStatus !== nextProps.aiStatus) {
      return false;
    }
    if (
      (prevProps.activeTagIds ?? []).join(",") !==
      (nextProps.activeTagIds ?? []).join(",")
    ) {
      return false;
    }
    if (prevProps.colorHex !== nextProps.colorHex) {
      return false;
    }
    if (prevProps.imageSearchActive !== nextProps.imageSearchActive) {
      return false;
    }
    if (
      prevProps.imageSearchReference?.imagePath !==
        nextProps.imageSearchReference?.imagePath ||
      prevProps.imageSearchReference?.previewDataUrl !==
        nextProps.imageSearchReference?.previewDataUrl
    ) {
      return false;
    }
    if (prevProps.onTagRemove !== nextProps.onTagRemove) {
      return false;
    }
    if (prevProps.onTagSelect !== nextProps.onTagSelect) {
      return false;
    }
    if (prevProps.query !== nextProps.query) {
      return false;
    }
    if (prevProps.resetVersion !== nextProps.resetVersion) {
      return false;
    }
    if (prevProps.filters !== nextProps.filters) {
      return false;
    }
    if (prevProps.drillDownFilters !== nextProps.drillDownFilters) {
      return false;
    }
    if (
      prevProps.filterBarLeadingContent !== nextProps.filterBarLeadingContent
    ) {
      return false;
    }
    if (
      prevProps.filterBarTrailingContent !== nextProps.filterBarTrailingContent
    ) {
      return false;
    }
    if (prevProps.resultCount !== nextProps.resultCount) {
      return false;
    }
    if (prevProps.searchMode !== nextProps.searchMode) {
      return false;
    }
    if (prevProps.searchTime !== nextProps.searchTime) {
      return false;
    }
    if (prevProps.leadingContent !== nextProps.leadingContent) {
      return false;
    }
    if (prevProps.trailingContent !== nextProps.trailingContent) {
      return false;
    }
    return true;
  }
);
