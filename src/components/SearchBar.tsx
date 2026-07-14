import { Clock, Filter, ImageUp, Search, X } from "lucide-react";
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
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
import { hexToColorName } from "@/utils/color-name";
import {
  buildPersonTrie,
  getSearchSuggestions,
} from "@/utils/search-suggestions";
import { cn } from "@/utils/tailwind";
import { FilterBreadcrumb } from "./FilterBreadcrumb";
import { FilterPresets } from "./FilterPresets";
import {
  clearSavedHistory,
  type ExifFilters,
  getFilterLabel,
  getTimePresets,
  loadHistory,
  MAX_HISTORY,
  type SearchSuggestion,
  saveHistory,
  type TagInfo,
} from "./search-bar-utils";

export type { ExifFilters } from "./search-bar-utils";

interface SearchBarProps {
  aiStatus?: {
    model: string;
    vectorDB: string;
    hasVectors: boolean;
    vectorCount: number;
    indexReady: boolean;
    isEmbedding: boolean;
    embeddingProgress: { processed: number; total: number; phase: string };
  } | null;
  colorHex?: string | null;
  imageSearchActive?: boolean;
  onClear: () => void;
  onImageSearch?: (imagePath: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
  resultCount?: number;
  searchMode?: "text" | "image" | "exif" | "color" | null;
  searchTime?: number;
}

export interface SearchBarHandle {
  clearFilters: () => void;
  setFilters: (filters: ExifFilters, isDrillDown?: boolean) => void;
}

export const SearchBar = memo(
  forwardRef<SearchBarHandle, SearchBarProps>(
  (
    {
      aiStatus,
      colorHex,
      imageSearchActive,
      onSearch,
      onClear,
      onImageSearch,
      resultCount,
      searchMode,
      searchTime,
    }: SearchBarProps,
    ref
  ) => {
    const { t } = useTranslation();
    const timePresets = useMemo(() => getTimePresets(t), [t]);
    const [query, setQuery] = useState(
      imageSearchActive ? t("imageSearchToken") : ""
    );
    const [history, setHistory] = useState<string[]>(loadHistory);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const [tags, setTags] = useState<TagInfo[]>([]);
    const [cameraModels, setCameraModels] = useState<string[]>([]);
    const [showCameraSuggestions, setShowCameraSuggestions] = useState(false);
    const [lensModels, setLensModels] = useState<string[]>([]);
    const [showLensSuggestions, setShowLensSuggestions] = useState(false);
    // Person names for search suggestions and AI-powered dictionary suggestions
    const [personNames, setPersonNames] = useState<string[]>([]);
    const [dictSuggestionsEnabled, setDictSuggestionsEnabled] = useState(false);

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
          const result = (await (ipc.client as any).faces.listFaceIdentities(
            {}
          )) as any[];
          if (!cancelled && Array.isArray(result)) {
            const names = result
              .filter((f: any) => f.name && f.name.trim())
              .map((f: any) => f.name.trim());
            setPersonNames(names);
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
        .then((r: any) => {
          setCameraModels(r.cameraModels || []);
          setLensModels(r.lensModels || []);
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
      const matchingPersons = personNames
        .filter((n) => n.toLowerCase().includes(q))
        .slice(0, 3);
      const seen = new Set<string>();
      for (const name of matchingPersons) {
        all.push({ type: "person", text: name, category: "person" });
        seen.add(name.toLowerCase());
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
    }, [query, tags, history, personNames, dictSuggestionsEnabled]);

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
      () =>
        history
          .slice(0, 5)
          .map((text) => ({ type: "history", text })),
      [history]
    );
    const displayedSuggestions = query.trim()
      ? suggestions
      : [
          ...(examplesDisabled ? [] : searchExamples),
          ...recentSuggestions,
        ];
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
    }, [imageSearchActive, t]);
    const [dragOver, setDragOver] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const suggestionListRef = useRef<HTMLDivElement>(null);
    const cameraDropdownRef = useRef<HTMLDivElement>(null);
    const lensDropdownRef = useRef<HTMLDivElement>(null);
    const [locallyDragging, setLocallyDragging] = useState(false);
    const queryRef = useRef(query);
    const [suggestionIndex, setSuggestionIndex] = useState(-1);
    useEffect(() => {
      queryRef.current = query;
    }, [query]);

    function clearHistory() {
      clearSavedHistory();
      setHistory([]);
      setSuggestionIndex(-1);
    }

    // Filter state
    const [filters, setFilters] = useState<ExifFilters>({});

    const [drillOriginFilters, setDrillOriginFilters] = useState<
      Set<keyof ExifFilters>
    >(new Set());

    const hasActiveFilters = Object.values(filters).some(
      (v) => v && v.length > 0
    );

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
      return lensModels.filter((m) => m.toLowerCase().includes(q)).slice(0, 20);
    }, [filters.lensModel, lensModels]);

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

    function handleInputBlur(e: React.FocusEvent<HTMLInputElement>) {
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

    function handleCameraBlur() {
      setTimeout(() => setShowCameraSuggestions(false), 150);
    }

    function handleCameraSuggestionClick(model: string) {
      setFilters((prev) => ({ ...prev, cameraModel: model }));
      setShowCameraSuggestions(false);
    }

    function handleLensBlur() {
      setTimeout(() => setShowLensSuggestions(false), 150);
    }

    function handleLensSuggestionClick(model: string) {
      setFilters((prev) => ({ ...prev, lensModel: model }));
      setShowLensSuggestions(false);
    }

    const addToHistory = useCallback((q: string) => {
      if (!q.trim()) {
        return;
      }
      setHistory((prev) => {
        const next = [q, ...prev.filter((h) => h !== q)].slice(0, MAX_HISTORY);
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

    function handleSuggestionClick(suggestion: {
      type: "example" | "person" | "dictionary" | "tag" | "history";
      text: string;
    }) {
      setQuery(suggestion.text);
      addToHistory(suggestion.text);
      onSearch(suggestion.text, hasActiveFilters ? filters : undefined);
      setShowSuggestions(false);
    }

    // Electron 拖拽时 MIME type 为空，改用扩展名判断
    const IMAGE_EXTENSIONS = new Set([
      ".jpg",
      ".jpeg",
      ".png",
      ".gif",
      ".webp",
      ".bmp",
      ".avif",
      ".heic",
      ".heif",
      ".tiff",
      ".tif",
      ".svg",
      ".ico",
      ".raw",
      ".cr2",
      ".cr3",
      ".nef",
      ".arw",
      ".orf",
      ".rw2",
      ".dng",
      ".pef",
      ".raf",
      ".sr2",
    ]);

    function handleDragOver(e: React.DragEvent) {
      if (!onImageSearch) {
        return;
      }
      // 接受单个文件拖放
      if (
        e.dataTransfer.types.includes("Files") &&
        e.dataTransfer.items.length === 1 &&
        e.dataTransfer.items[0].kind === "file"
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }
    }

    function handleDragLeave(e: React.DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
    }

    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      e.stopPropagation();
      setDragOver(false);
      if (!onImageSearch) {
        return;
      }
      const file = e.dataTransfer.files[0];
      if (!file) {
        return;
      }
      const filePath = (window as any).electronAPI?.getFilePath?.(file);
      if (!filePath) {
        return;
      }
      const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        onImageSearch(filePath);
      }
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

    useImperativeHandle(ref, () => ({
      setFilters: (newFilters: ExifFilters, isDrillDown = false) => {
        setFilters(newFilters);
        if (isDrillDown) {
          setDrillOriginFilters(
            new Set(Object.keys(newFilters) as Array<keyof ExifFilters>)
          );
        }
      },
      clearFilters: () => {
        setFilters({});
        setDrillOriginFilters(new Set());
        if (queryRef.current.trim()) {
          onSearch(queryRef.current.trim(), undefined);
        } else {
          onClear();
        }
      },
    }));

    const filterInputClass =
      "h-8 w-full rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-primary/40";

    return (
      <div
        aria-label={t("searchPlaceholder")}
        className={`relative border-border border-b transition-colors ${dragOver ? "bg-primary/5" : ""}`}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        role="search"
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-[6px] border-2 border-primary border-dashed bg-primary/10">
            <span className="font-medium text-[13px] text-primary">
              {t("dropImageToSearch")}
            </span>
          </div>
        )}

        <div className="px-4 py-3">
          {/* Search input row */}
          <div className="flex items-center gap-2">
            <form className="relative flex-1" onSubmit={handleSubmit}>
              <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-muted-foreground/70" />
              <input
                aria-activedescendant={suggestionIndex >= 0 ? `search-suggestion-${suggestionIndex}` : undefined}
                aria-autocomplete="list"
                aria-controls="search-suggestions-listbox"
                aria-expanded={showSuggestionPanel}
                className="h-9 w-full rounded-[6px] border border-border bg-card pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-ring"
                onBlur={handleInputBlur}
                role="combobox"
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowSuggestions(true);
                  setSuggestionIndex(-1); // 输入变化时重置高亮
                }}
                onFocus={() => {
                  if (!(imageSearchActive || showFilters)) {
                    setShowSuggestions(true);
                  }
                }}
                onKeyDown={handleInputKeyDown}
                placeholder={getPlaceholder()}
                ref={inputRef}
                type="text"
                value={query}
              />
              {(query || imageSearchActive) && (
                <button
                  className="absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-muted-foreground/70 hover:text-foreground"
                  onClick={handleClear}
                  type="button"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </form>

            {onImageSearch && (
              <>
                <input
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const filePath = (
                        window as any
                      ).electronAPI?.getFilePath?.(file);
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
                      <span>{t("searchModeImage")}</span>
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
                  className={`flex h-9 w-9 items-center justify-center rounded-[6px] transition-colors ${
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
                </button>
              </TooltipTrigger>
              <TooltipContent>{t("exifFilterTitle")}</TooltipContent>
            </Tooltip>
          </div>

          {/* Time quick presets */}
          {!imageSearchActive && (
            <div className="mt-2 flex items-center gap-1.5">
              <Clock className="h-3 w-3 flex-shrink-0 text-muted-foreground/50" />
              {timePresets.map((preset) => (
                <button
                  className="rounded-[4px] border border-border px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:border-primary/30 hover:bg-primary/5 hover:text-primary"
                  key={preset.label}
                  onClick={() => {
                    const range = preset.getRange();
                    const newFilters: ExifFilters = {
                      ...filters,
                      dateFrom: range.dateFrom,
                      dateTo: range.dateTo,
                    };
                    setFilters(newFilters);
                    const q = query.trim();
                    queueMicrotask(() =>
                      onSearch(
                        q,
                        Object.values(newFilters).some((v) => v)
                          ? newFilters
                          : undefined
                      )
                    );
                  }}
                  type="button"
                >
                  {preset.label}
                </button>
              ))}
            </div>
          )}

          {/* Search status line — shows mode, timing, and result count */}
          {(searchMode ||
            searchTime !== undefined ||
            resultCount !== undefined) && (
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              {searchMode && (
                <span className="inline-flex items-center gap-1 rounded-[4px] bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
                  {searchMode === "text" ? (
                    t("searchModeSemantic")
                  ) : searchMode === "image" ? (
                    t("searchModeImage")
                  ) : searchMode === "color" && colorHex ? (
                    <>
                      <span
                        className="inline-block h-2.5 w-2.5 rounded-full"
                        style={{ backgroundColor: `#${colorHex}` }}
                      />
                      {hexToColorName(`#${colorHex}`, "zh")}
                      <span className="font-mono opacity-70">
                        #{colorHex.toUpperCase()}
                      </span>
                      <button
                        className="ml-0.5 hover:text-foreground"
                        onClick={(e) => {
                          e.stopPropagation();
                          onClear();
                        }}
                      >
                        <X className="h-2.5 w-2.5" />
                      </button>
                    </>
                  ) : (
                    t("searchModeExif")
                  )}
                </span>
              )}
              {searchTime !== undefined && (
                <span className="text-muted-foreground/70">
                  {searchTime < 1000
                    ? `${searchTime}ms`
                    : `${(searchTime / 1000).toFixed(1)}s`}
                </span>
              )}
              {resultCount !== undefined && (
                <span className="text-muted-foreground">
                  {resultCount > 0
                    ? t("resultCount", { count: resultCount })
                    : searchMode
                      ? t("noMatchResult")
                      : ""}
                </span>
              )}
            </div>
          )}

          {/* Active filter chips */}
          {hasActiveFilters && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
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
              {filters.cameraModel && (
                <FilterChip
                  label={filters.cameraModel}
                  onRemove={() => updateFilter("cameraModel", "", true)}
                />
              )}
              {filters.lensModel && (
                <FilterChip
                  label={filters.lensModel}
                  onRemove={() => updateFilter("lensModel", "", true)}
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
                      const next = { ...prev, shutterMin: "", shutterMax: "" };
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
                className="rounded-[4px] px-1.5 py-0.5 text-[10px] text-muted-foreground/70 hover:text-foreground"
                onClick={clearFilters}
              >
                {t("clearAll")}
              </button>
            </div>
          )}

          {/* Filter panel */}
          {showFilters && (
            <div
              className="absolute top-full right-4 z-[70] mt-2 max-h-[calc(100vh-170px)] w-[min(900px,calc(100%-32px))] overflow-y-auto rounded-[10px] border border-border bg-popover p-4 shadow-2xl ring-1 ring-foreground/5"
              onKeyDown={handleFilterKeyDown}
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
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("dateRangeLabel")}
                  </label>
                  <div className="space-y-1">
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("dateFrom") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
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
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
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

                {/* Camera */}
                <div>
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("cameraModelLabel")}
                  </label>
                  <div className="relative" ref={cameraDropdownRef}>
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("cameraModel") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
                      onBlur={handleCameraBlur}
                      onChange={(e) => {
                        updateFilter("cameraModel", e.target.value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("cameraModel");
                          return next;
                        });
                        setShowCameraSuggestions(true);
                      }}
                      onFocus={() => {
                        if (cameraSuggestions.length > 0) {
                          setShowCameraSuggestions(true);
                        }
                      }}
                      placeholder={t("cameraPlaceholder")}
                      value={filters.cameraModel || ""}
                    />
                    {showCameraSuggestions && cameraSuggestions.length > 0 && (
                      <div className="absolute top-full right-0 left-0 z-[60] mt-1 max-h-48 overflow-y-auto rounded-[6px] border border-border bg-popover shadow-lg ring-1 ring-foreground/5">
                        {cameraSuggestions.map((model) => (
                          <button
                            className="flex w-full items-center truncate px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-foreground/5"
                            key={model}
                            onClick={() => handleCameraSuggestionClick(model)}
                            onMouseDown={(e) => e.preventDefault()}
                            type="button"
                          >
                            {model}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Lens */}
                <div>
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("lensModelLabel")}
                  </label>
                  <div className="relative" ref={lensDropdownRef}>
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("lensModel") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
                      onBlur={handleLensBlur}
                      onChange={(e) => {
                        updateFilter("lensModel", e.target.value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("lensModel");
                          return next;
                        });
                        setShowLensSuggestions(true);
                      }}
                      onFocus={() => {
                        if (lensSuggestions.length > 0) {
                          setShowLensSuggestions(true);
                        }
                      }}
                      placeholder={t("lensModelPlaceholder")}
                      value={filters.lensModel || ""}
                    />
                    {showLensSuggestions && lensSuggestions.length > 0 && (
                      <div className="absolute top-full right-0 left-0 z-[60] mt-1 max-h-48 overflow-y-auto rounded-[6px] border border-border bg-popover shadow-lg ring-1 ring-foreground/5">
                        {lensSuggestions.map((model) => (
                          <button
                            className="flex w-full items-center truncate px-2.5 py-1.5 text-left text-[12px] text-foreground hover:bg-foreground/5"
                            key={model}
                            onClick={() => handleLensSuggestionClick(model)}
                            onMouseDown={(e) => e.preventDefault()}
                            type="button"
                          >
                            {model}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* ISO range */}
                <div>
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("isoRangeLabel")}
                  </label>
                  <div className="space-y-1">
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("isoMin") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
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
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
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
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("apertureLabel")}
                  </label>
                  <div className="space-y-1">
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("apertureMin") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
                      min="0.7"
                      onChange={(e) => {
                        updateFilter("apertureMin", e.target.value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("apertureMin");
                          return next;
                        });
                      }}
                      placeholder={t("minExamplePlaceholder", { value: "1.4" })}
                      step="0.1"
                      type="number"
                      value={filters.apertureMin || ""}
                    />
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("apertureMax") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
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
                      placeholder={t("maxExamplePlaceholder", { value: "5.6" })}
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
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("focalLabel")}
                  </label>
                  <div className="space-y-1">
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("focalMin") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
                      onChange={(e) => {
                        updateFilter("focalMin", e.target.value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("focalMin");
                          return next;
                        });
                      }}
                      placeholder={t("minExamplePlaceholder", { value: "24" })}
                      type="number"
                      value={filters.focalMin || ""}
                    />
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("focalMax") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
                      onChange={(e) => {
                        updateFilter("focalMax", e.target.value);
                        setDrillOriginFilters((prev) => {
                          const next = new Set(prev);
                          next.delete("focalMax");
                          return next;
                        });
                      }}
                      placeholder={t("maxExamplePlaceholder", { value: "200" })}
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
                  <label className="mb-1 block font-medium text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                    {t("shutterSpeedLabel")}
                  </label>
                  <div className="flex gap-2">
                    <input
                      className={cn(
                        filterInputClass,
                        drillOriginFilters.has("shutterMin") &&
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
                      )}
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
                          "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
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
                    className="rounded-[4px] px-2 py-1 text-[11px] text-muted-foreground/70 hover:text-foreground"
                    onClick={() => {
                      clearFilters();
                      setShowFilters(false);
                    }}
                  >
                    {t("reset")}
                  </button>
                  <button
                    className="rounded-[4px] bg-primary/10 px-2 py-1 font-medium text-[11px] text-primary hover:bg-primary/20"
                    onClick={() => {
                      onSearch(
                        query.trim(),
                        hasActiveFilters ? filters : undefined
                      );
                      setShowFilters(false);
                    }}
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
            className="absolute top-full left-4 z-[60] mt-1 max-h-[min(440px,calc(100vh-150px))] w-[min(960px,calc(100%-32px))] overflow-y-auto rounded-[10px] border border-border bg-popover shadow-xl outline-none ring-1 ring-foreground/5"
            id="search-suggestions-listbox"
            role="listbox"
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
            tabIndex={0}
          >
            {!query.trim() ? (
              <>
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
                      data-suggestion-index={
                        examplesDisabled ? undefined : i
                      }
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
            ) : (
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
                    <span className="flex h-4 w-4 flex-shrink-0 items-center justify-center text-[10px]">
                      👤
                    </span>
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
            )}
          </div>
        )}
      </div>
    );
  }
),
(prevProps, nextProps) => {
  if (prevProps.aiStatus !== nextProps.aiStatus) return false;
  if (prevProps.colorHex !== nextProps.colorHex) return false;
  if (prevProps.imageSearchActive !== nextProps.imageSearchActive) return false;
  if (prevProps.resultCount !== nextProps.resultCount) return false;
  if (prevProps.searchMode !== nextProps.searchMode) return false;
  if (prevProps.searchTime !== nextProps.searchTime) return false;
  return true;
});

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
      <button className="ml-0.5 hover:text-foreground" onClick={onRemove}>
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
