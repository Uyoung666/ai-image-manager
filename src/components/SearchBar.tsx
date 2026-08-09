// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noNestedTernary: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/correctness/noUnusedFunctionParameters: scoped component lint cleanup preserves existing UI behavior
import { useNavigate } from "@tanstack/react-router";
import { Clock, Filter, ImageUp, Search, X } from "lucide-react";
import {
  type Dispatch,
  forwardRef,
  memo,
  type ReactNode,
  type SetStateAction,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { ipc } from "@/ipc/manager";
import type {
  AdvancedExifFilterField,
  ExifFilters,
  SearchMode,
} from "@/types/search";
import { toLocalMediaUrl } from "@/utils/local-media-url";
import {
  buildPersonTrie,
  getSearchSuggestions,
} from "@/utils/search-suggestions";
import { cn } from "@/utils/tailwind";
import { FilterBreadcrumb } from "./FilterBreadcrumb";
import { FilterPresets } from "./FilterPresets";
import { FilterDropdown } from "./filter-dropdown";
import {
  clearSavedHistory,
  getFilterLabel,
  getTimePresets,
  loadHistory,
  MAX_HISTORY,
  type SearchSuggestion,
  saveHistory,
  type TagInfo,
} from "./search-bar-utils";
import {
  SemanticSearchDiagnostics,
  type SemanticSearchDiagnosticsProps,
} from "./semantic-search-diagnostics";

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

interface PersonOption {
  coverPhotoPath: string | null;
  coverThumbnailPath: string | null;
  id: number;
  name: string;
}

interface FaceIdentityRecord {
  coverPhotoPath?: string | null;
  coverThumbnailPath?: string | null;
  id: number;
  name: string;
}

interface ExifCandidateResult {
  advancedCategories?: Record<string, string[]>;
  cameraModels?: Array<string | null>;
  creators?: string[];
  lensModels?: Array<string | null>;
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
    indexedPhotos?: number;
    isEmbedding: boolean;
    totalPhotos?: number;
    embeddingProgress: { processed: number; total: number; phase: string };
  } | null;
  colorHex?: string | null;
  drillDownFilters?: ExifFilters;
  filters: ExifFilters;
  imageSearchActive?: boolean;
  leadingContent?: ReactNode;
  onClear: () => void;
  onFiltersChange: Dispatch<SetStateAction<ExifFilters>>;
  onImageSearch?: (imagePath: string) => void;
  onQueryChange: (query: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
  onTagRemove?: (tagId: number) => void;
  onTagSelect?: (tag: TagInfo) => void;
  query: string;
  resetVersion?: number;
  resultCount?: number;
  searchMode?: SearchMode | null;
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
        drillDownFilters,
        filters,
        imageSearchActive,
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
      const { t } = useTranslation();
      const timePresets = useMemo(() => getTimePresets(t), [t]);
      const [history, setHistory] = useState<string[]>(loadHistory);
      const [showSuggestions, setShowSuggestions] = useState(false);
      const [inputFocused, setInputFocused] = useState(false);
      const [showFilters, setShowFilters] = useState(false);
      const [tags, setTags] = useState<TagInfo[]>([]);
      const [cameraModels, setCameraModels] = useState<string[]>([]);
      const [creators, setCreators] = useState<string[]>([]);
      const [lensModels, setLensModels] = useState<string[]>([]);
      const [advancedCategories, setAdvancedCategories] = useState<
        Record<string, string[]>
      >({});
      // Person identities for search suggestions and AI-powered dictionary suggestions
      const [personOptions, setPersonOptions] = useState<PersonOption[]>([]);
      const navigate = useNavigate();
      const [dictSuggestionsEnabled, setDictSuggestionsEnabled] =
        useState(false);

      const searchExamples = useMemo<SearchSuggestion[]>(
        () => [
          { type: "example", text: t("searchExampleAutumnLeaves") },
          { type: "example", text: t("searchExampleSeasideSunset") },
          { type: "example", text: t("searchExampleCuteCat") },
          { type: "example", text: t("searchExampleNightCity") },
        ],
        [t]
      );

      // Fetch person names for search suggestions
      useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const faceClient = (
              ipc.client as unknown as {
                faces?: {
                  listFaceIdentities: (
                    input: Record<string, never>
                  ) => Promise<FaceIdentityRecord[]>;
                };
              }
            ).faces;
            const result = (await faceClient?.listFaceIdentities({})) ?? [];
            if (!cancelled && Array.isArray(result)) {
              const options: PersonOption[] = result
                .filter((f) => f.name?.trim())
                .map((f) => ({
                  id: Number(f.id),
                  name: f.name.trim(),
                  coverThumbnailPath: f.coverThumbnailPath ?? null,
                  coverPhotoPath: f.coverPhotoPath ?? null,
                }));
              setPersonOptions(options);
              const names = options.map((o) => o.name);
              if (names.length > 0) {
                buildPersonTrie(names);
              }
            }
          } catch {
            // Face module may not be ready
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      // Enable AI dictionary suggestions once tags are loaded
      useEffect(() => {
        if (tags.length > 0) {
          setDictSuggestionsEnabled(true);
        }
      }, [tags]);

      useEffect(() => {
        ipc.client.photos
          .getTags({})
          .then((result) => {
            setTags((result as TagInfo[]) || []);
          })
          .catch(() => {
            /* ignore */
          });
      }, []);

      useEffect(() => {
        ipc.client.photos
          .getExifCandidates({})
          .then((r: ExifCandidateResult) => {
            setCameraModels(
              (r.cameraModels || []).filter(
                (model): model is string => model !== null
              )
            );
            setCreators(r.creators || []);
            setLensModels(
              (r.lensModels || []).filter(
                (model): model is string => model !== null
              )
            );
            setAdvancedCategories(r.advancedCategories || {});
          })
          .catch(() => {
            /* ignore */
          });
      }, []);

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
          .filter((h) => h.toLowerCase().includes(q) && h !== q)
          .slice(0, 3)
          .map((h) => ({ type: "history" as const, text: h }));
        all.push(...matchingHistory);

        return all;
      }, [query, tags, history, personOptions, dictSuggestionsEnabled]);

      const examplesDisabled = Boolean(
        aiStatus &&
          (aiStatus.isEmbedding ||
            aiStatus.model === "loading" ||
            aiStatus.model === "error" ||
            aiStatus.vectorDB !== "ready" ||
            !aiStatus.hasVectors ||
            !aiStatus.indexReady)
      );
      const recentSuggestions = useMemo<SearchSuggestion[]>(
        () => history.slice(0, 5).map((text) => ({ type: "history", text })),
        [history]
      );
      const displayedSuggestions = query.trim()
        ? suggestions
        : [...(examplesDisabled ? [] : searchExamples), ...recentSuggestions];
      const showSuggestionPanel =
        showSuggestions &&
        !imageSearchActive &&
        !showFilters &&
        (!query.trim() || suggestions.length > 0);

      useEffect(() => {
        if (imageSearchActive) {
          setQuery(t("imageSearchToken"));
          setShowSuggestions(false);
        }
      }, [imageSearchActive, setQuery, t]);
      const inputRef = useRef<HTMLInputElement>(null);
      const fileInputRef = useRef<HTMLInputElement>(null);
      const dropdownRef = useRef<HTMLDivElement>(null);
      const toolbarRef = useRef<HTMLElement>(null);
      const suggestionListRef = useRef<HTMLDivElement>(null);
      const [_locallyDragging, _setLocallyDragging] = useState(false);
      const [suggestionIndex, setSuggestionIndex] = useState(-1);
      const [floatingPanelMaxHeight, setFloatingPanelMaxHeight] = useState(440);

      useEffect(() => {
        if (!(showFilters || showSuggestionPanel)) {
          return;
        }

        const updateAvailableHeight = () => {
          const toolbarBottom =
            toolbarRef.current?.getBoundingClientRect().bottom ?? 0;
          setFloatingPanelMaxHeight(
            Math.max(120, Math.floor(window.innerHeight - toolbarBottom - 12))
          );
        };

        updateAvailableHeight();
        window.addEventListener("resize", updateAvailableHeight);
        const observer =
          typeof ResizeObserver === "undefined"
            ? null
            : new ResizeObserver(updateAvailableHeight);
        if (toolbarRef.current) {
          observer?.observe(toolbarRef.current);
        }

        return () => {
          window.removeEventListener("resize", updateAvailableHeight);
          observer?.disconnect();
        };
      }, [showFilters, showSuggestionPanel]);

      function clearHistory() {
        clearSavedHistory();
        setHistory([]);
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
      }, []);

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

      useEffect(() => {
        function handleGlobalShortcut(e: MessageEvent) {
          if (e.data === "global-shortcut:search") {
            inputRef.current?.focus();
          }
        }
        window.addEventListener("message", handleGlobalShortcut);
        return () => {
          window.removeEventListener("message", handleGlobalShortcut);
        };
      }, []);

      useEffect(() => {
        function closeMenus(event: PointerEvent) {
          if (!toolbarRef.current?.contains(event.target as Node)) {
            setShowSuggestions(false);
            setShowFilters(false);
            setSuggestionIndex(-1);
          }
        }
        function handleEscape(event: KeyboardEvent) {
          if (event.key === "Escape") {
            setShowSuggestions(false);
            setShowFilters(false);
            setSuggestionIndex(-1);
          }
        }
        document.addEventListener("pointerdown", closeMenus);
        document.addEventListener("keydown", handleEscape);
        return () => {
          document.removeEventListener("pointerdown", closeMenus);
          document.removeEventListener("keydown", handleEscape);
        };
      }, []);

      function handleInputBlur(e: React.FocusEvent<HTMLInputElement>) {
        setInputFocused(false);
        const related = e.relatedTarget as Node | null;
        if (related && suggestionListRef.current?.contains(related)) {
          return;
        }
        setTimeout(() => {
          setShowSuggestions(false);
          setSuggestionIndex(-1);
        }, 150);
      }

      function handleInputKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
        if (
          e.key === "ArrowDown" &&
          showSuggestionPanel &&
          displayedSuggestions.length > 0
        ) {
          e.preventDefault();
          setSuggestionIndex(0);
          suggestionListRef.current?.focus();
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

      function handleSuggestionKeyDown(e: React.KeyboardEvent) {
        const len = displayedSuggestions.length;
        if (len === 0) {
          return;
        }

        switch (e.key) {
          case "ArrowDown":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev + 1) % len);
            break;
          case "ArrowUp":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev - 1 + len) % len);
            break;
          case "Enter":
            e.preventDefault();
            if (suggestionIndex >= 0 && suggestionIndex < len) {
              handleSuggestionClick(displayedSuggestions[suggestionIndex]);
            }
            break;
          case "Escape":
            e.preventDefault();
            setShowSuggestions(false);
            setSuggestionIndex(-1);
            inputRef.current?.focus();
            break;
          case "Tab":
            e.preventDefault();
            setSuggestionIndex((prev) => (prev + 1) % len);
            break;
          default:
            break;
        }
      }

      useEffect(() => {
        if (suggestionIndex < 0 || !suggestionListRef.current) {
          return;
        }
        const activeEl = suggestionListRef.current.querySelector(
          `[data-suggestion-index="${suggestionIndex}"]`
        );
        if (activeEl) {
          activeEl.scrollIntoView?.({ block: "nearest" });
        }
      }, [suggestionIndex]);

      const addToHistory = useCallback((q: string) => {
        if (!q.trim()) {
          return;
        }
        setHistory((prev) => {
          const next = [q, ...prev.filter((h) => h !== q)].slice(
            0,
            MAX_HISTORY
          );
          saveHistory(next);
          return next;
        });
      }, []);

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
        inputRef.current?.focus();
      }

      function handleSuggestionClick(suggestion: SearchSuggestion) {
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
        setQuery(suggestion.text);
        addToHistory(suggestion.text);
        onSearch(suggestion.text, hasActiveFilters ? filters : undefined);
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
        if (!aiStatus) {
          return t("searchPlaceholder");
        }
        if (aiStatus.isEmbedding) {
          const p = aiStatus.embeddingProgress;
          return t("aiEmbeddingSearchReady", {
            processed: p.processed,
            total: p.total,
          });
        }
        if (aiStatus.model === "loading") {
          return t("aiModelLoading");
        }
        if (aiStatus.model === "error") {
          return t("aiModelError");
        }
        if (aiStatus.vectorDB !== "ready") {
          return t("vectorDbNotReady");
        }
        if (!aiStatus.hasVectors) {
          return t("aiNoIndexHint");
        }
        return t("searchPlaceholder");
      }

      const filterInputClass =
        "h-8 w-full rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40";
      const filterDropdownClass = "w-full placeholder:text-muted-foreground/70";
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
                <span
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-y-0 left-0 z-[100] flex w-9 items-center justify-center"
                  style={{ color: "var(--muted-foreground)", zIndex: 100 }}
                >
                  <Search className="h-4 w-4 shrink-0" strokeWidth={2} />
                </span>
                <input
                  aria-activedescendant={
                    suggestionIndex >= 0
                      ? `search-suggestion-${suggestionIndex}`
                      : undefined
                  }
                  aria-autocomplete="list"
                  aria-controls="search-suggestions-listbox"
                  aria-expanded={showSuggestionPanel}
                  className={`home-search-input h-9 w-full rounded-[6px] border border-border pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-ring ${inputFocused || showSuggestionPanel || showFilters || query.trim() ? "is-active" : ""}`}
                  onBlur={handleInputBlur}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setShowSuggestions(true);
                    setSuggestionIndex(-1); // 输入变化时重置高亮
                  }}
                  onFocus={() => {
                    setInputFocused(true);
                    if (showFilters) {
                      setShowFilters(false);
                    }
                    if (!imageSearchActive) {
                      setShowSuggestions(true);
                    }
                  }}
                  onKeyDown={handleInputKeyDown}
                  placeholder={getPlaceholder()}
                  ref={inputRef}
                  role="combobox"
                  type="text"
                  value={query}
                />
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

            {aiStatus?.coverageState === "error" && (
              <div className="mt-2 text-[11px] text-amber-700 dark:text-amber-300">
                {t("semanticSearchUnavailable")}
              </div>
            )}

            {/* Active filter chips */}
            {hasActiveFilters && (
              <div className="hidden">
                {filters.dateFrom && (
                  <FilterChip
                    label={t("filterFrom", { value: filters.dateFrom })}
                    onRemove={() => updateFilter("dateFrom", "", true)}
                  />
                )}
                {filters.dateTo && (
                  <FilterChip
                    label={t("filterTo", { value: filters.dateTo })}
                    onRemove={() => updateFilter("dateTo", "", true)}
                  />
                )}
                {filters.dateMonth && (
                  <FilterChip
                    label={t("dateMonthValue", {
                      value: filters.dateMonth,
                    })}
                    onRemove={() => updateFilter("dateMonth", "", true)}
                  />
                )}
                {filters.dateHour && (
                  <FilterChip
                    label={t("dateHourValue", {
                      next: String(
                        (Number(filters.dateHour) + 1) % 24
                      ).padStart(2, "0"),
                      value: filters.dateHour.padStart(2, "0"),
                    })}
                    onRemove={() => updateFilter("dateHour", "", true)}
                  />
                )}
                {filters.cameraModel && (
                  <FilterChip
                    label={filters.cameraModel}
                    onRemove={() => updateFilter("cameraModel", "", true)}
                  />
                )}
                {filters.creator && (
                  <FilterChip
                    label={filters.creator}
                    onRemove={() => updateFilter("creator", "", true)}
                  />
                )}
                {filters.lensModel && (
                  <FilterChip
                    label={filters.lensModel}
                    onRemove={() => updateFilter("lensModel", "", true)}
                  />
                )}
                {filters.advancedField && filters.advancedValue && (
                  <FilterChip
                    label={`${t(`advancedFilter_${filters.advancedField}`)}: ${filters.advancedValue}`}
                    onRemove={() => {
                      setFilters((previous) => ({
                        ...previous,
                        advancedField: undefined,
                        advancedValue: undefined,
                      }));
                    }}
                  />
                )}
                {filters.isoMin && (
                  <FilterChip
                    label={`ISO ≥ ${filters.isoMin}`}
                    onRemove={() => updateFilter("isoMin", "", true)}
                  />
                )}
                {filters.isoMax && (
                  <FilterChip
                    label={`ISO ≤ ${filters.isoMax}`}
                    onRemove={() => updateFilter("isoMax", "", true)}
                  />
                )}
                {filters.apertureMin && (
                  <FilterChip
                    label={t("apertureGte", { value: filters.apertureMin })}
                    onRemove={() => updateFilter("apertureMin", "", true)}
                  />
                )}
                {filters.apertureMax && (
                  <FilterChip
                    label={t("apertureLte", { value: filters.apertureMax })}
                    onRemove={() => updateFilter("apertureMax", "", true)}
                  />
                )}
                {filters.focalMin && (
                  <FilterChip
                    label={t("focalGte", { value: filters.focalMin })}
                    onRemove={() => updateFilter("focalMin", "", true)}
                  />
                )}
                {filters.focalMax && (
                  <FilterChip
                    label={t("focalLte", { value: filters.focalMax })}
                    onRemove={() => updateFilter("focalMax", "", true)}
                  />
                )}
                {(filters.shutterMin || filters.shutterMax) && (
                  <FilterChip
                    label={`${t("shutterSpeedLabel")}: ${filters.shutterMin || "0"}s-${filters.shutterMax || "∞"}s`}
                    onRemove={() => {
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
                    }}
                  />
                )}
                <button
                  className="min-h-8 rounded-[4px] px-2 text-[11px] text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                  onClick={clearFilters}
                  type="button"
                >
                  {t("clearAll")}
                </button>
              </div>
            )}

            {/* Filter panel */}
            {showFilters && (
              <div
                className="absolute top-full right-4 z-[70] mt-2 w-[min(900px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover p-4 shadow-2xl ring-1 ring-foreground/5"
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
                    onClick={() => setShowFilters(false)}
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
                        ...Array.from(
                          { length: 12 },
                          (_, index) => index + 1
                        ).map((month) => ({
                          label: t("dateMonthValue", { value: month }),
                          value: String(month),
                        })),
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
                        ...Array.from({ length: 24 }, (_, hour) => hour).map(
                          (hour) => ({
                            label: t("dateHourValue", {
                              next: String((hour + 1) % 24).padStart(2, "0"),
                              value: String(hour).padStart(2, "0"),
                            }),
                            value: String(hour),
                          })
                        ),
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
                          updateFilter(
                            "advancedField",
                            value as AdvancedExifFilterField
                          )
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
                        onChange={(value) =>
                          updateFilter("advancedValue", value)
                        }
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
                      {(
                        ["100-400", "400-1600", "1600-6400", "6400+"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyIsoPreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
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
                      {(
                        ["f/1.4-2.8", "f/2.8-5.6", "f/5.6-11", "f/11+"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyAperturePreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
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
                      {(
                        ["<35mm", "35-85mm", "85-200mm", ">200mm"] as const
                      ).map((preset) => (
                        <button
                          className="rounded-[3px] bg-secondary px-1.5 py-0.5 text-[10px] hover:bg-primary/10"
                          key={preset}
                          onClick={() => applyFocalPreset(preset)}
                          type="button"
                        >
                          {preset}
                        </button>
                      ))}
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
                    setFilters(loadedFilters);
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
                        setShowFilters(false);
                      }}
                      type="button"
                    >
                      {t("reset")}
                    </button>
                    <button
                      className="min-h-8 rounded-[4px] bg-primary/10 px-2 font-medium text-[11px] text-primary hover:bg-primary/20"
                      onClick={() => {
                        onSearch(
                          query.trim(),
                          hasActiveFilters ? filters : undefined
                        );
                        setShowFilters(false);
                      }}
                      type="button"
                    >
                      {t("applyFilters")}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Search suggestions dropdown */}
          {showSuggestionPanel && (
            <div
              className="absolute top-full left-4 z-[60] mt-1 w-[min(960px,calc(100%-32px))] overflow-y-auto overscroll-contain rounded-[10px] border border-border bg-popover shadow-xl outline-none ring-1 ring-foreground/5"
              id="search-suggestions-listbox"
              onBlur={(e) => {
                // 焦点离开建议列表且没有回到 input 时关闭
                const related = e.relatedTarget as Node | null;
                if (
                  related &&
                  (suggestionListRef.current?.contains(related) ||
                    related === inputRef.current)
                ) {
                  return;
                }
                setShowSuggestions(false);
                setSuggestionIndex(-1);
              }}
              onKeyDown={handleSuggestionKeyDown}
              ref={(node) => {
                (
                  dropdownRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
                (
                  suggestionListRef as React.MutableRefObject<HTMLDivElement | null>
                ).current = node;
              }}
              role="listbox"
              style={{ maxHeight: Math.min(440, floatingPanelMaxHeight) }}
              tabIndex={0}
            >
              {query.trim() ? (
                <>
                  <div className="flex items-center justify-between px-3 py-1.5">
                    <span className="font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                      {t("searchSuggestions")}
                    </span>
                  </div>
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
                        onClick={() => {
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
                        aria-selected={
                          !examplesDisabled && i === suggestionIndex
                        }
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
                        id={
                          examplesDisabled
                            ? undefined
                            : `search-suggestion-${i}`
                        }
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
                          (examplesDisabled ? 0 : searchExamples.length) +
                          historyIndex;
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
          )}
        </search>
      );
    }
  ),
  (prevProps, nextProps) => {
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

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] bg-primary/10 px-2 py-0.5 font-medium text-[10px] text-primary">
      {label}
      <button
        aria-label="移除筛选条件"
        className="-mr-1 ml-0.5 flex h-6 w-6 items-center justify-center rounded hover:bg-primary/15 hover:text-foreground"
        onClick={onRemove}
        type="button"
      >
        <X className="h-3 w-3" />
      </button>
    </span>
  );
}
