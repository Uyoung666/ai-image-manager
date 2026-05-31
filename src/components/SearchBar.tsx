import { Clock, Filter, ImageUp, Search, Tag, X } from "lucide-react";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";
import { hexToColorName } from "@/utils/color-name";
import { cn } from "@/utils/tailwind";
import { FilterBreadcrumb } from "./FilterBreadcrumb";
import { FilterPresets } from "./FilterPresets";

const HISTORY_KEY = "search_history";
const MAX_HISTORY = 20;

interface TagInfo {
  color: string | null;
  id: number;
  name: string;
}

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveHistory(items: string[]) {
  try {
    localStorage.setItem(
      HISTORY_KEY,
      JSON.stringify(items.slice(0, MAX_HISTORY))
    );
  } catch {
    /* ignore */
  }
}

export interface ExifFilters {
  apertureMax?: string;
  apertureMin?: string;
  cameraModel?: string;
  dateFrom?: string;
  dateTo?: string;
  focalMax?: string;
  focalMin?: string;
  isoMax?: string;
  isoMin?: string;
  lensModel?: string;
  shutterMax?: string;
  shutterMin?: string;
}

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

function getFilterLabel(
  key: keyof ExifFilters,
  value: string | undefined
): string {
  if (!value) {
    return "";
  }
  switch (key) {
    case "cameraModel":
      return value;
    case "lensModel":
      return value;
    case "isoMin":
      return `ISO ≥ ${value}`;
    case "isoMax":
      return `ISO ≤ ${value}`;
    case "apertureMin":
      return `光圈 ≥ f/${value}`;
    case "apertureMax":
      return `光圈 ≤ f/${value}`;
    case "focalMin":
      return `焦段 ≥ ${value}mm`;
    case "focalMax":
      return `焦段 ≤ ${value}mm`;
    case "shutterMin":
      return `快门 ≥ ${value}s`;
    case "shutterMax":
      return `快门 ≤ ${value}s`;
    case "dateFrom":
      return `从 ${value}`;
    case "dateTo":
      return `至 ${value}`;
    default:
      return value;
  }
}

export const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(
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
    const [query, setQuery] = useState(
      imageSearchActive ? t("imageSearchToken") : ""
    );
    const [history, setHistory] = useState<string[]>(loadHistory);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [tags, setTags] = useState<TagInfo[]>([]);
    const [cameraModels, setCameraModels] = useState<string[]>([]);
    const [showCameraSuggestions, setShowCameraSuggestions] = useState(false);
    const [lensModels, setLensModels] = useState<string[]>([]);
    const [showLensSuggestions, setShowLensSuggestions] = useState(false);

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

    // Filter suggestions: matching tags + recent searches
    const suggestions = useMemo(() => {
      const q = query.trim().toLowerCase();
      if (!q) {
        // Empty query: show recent history only
        return history
          .slice(0, 8)
          .map((h) => ({ type: "history" as const, text: h }));
      }
      // With query: show matching tags first, then matching history
      const matchingTags = tags
        .filter((t) => t.name.toLowerCase().includes(q))
        .slice(0, 5)
        .map((t) => ({
          type: "tag" as const,
          text: t.name,
          color: t.color || "var(--primary)",
        }));
      const matchingHistory = history
        .filter((h) => h.toLowerCase().includes(q) && h !== q)
        .slice(0, 3)
        .map((h) => ({ type: "history" as const, text: h }));
      return [...matchingTags, ...matchingHistory];
    }, [query, tags, history]);

    useEffect(() => {
      if (imageSearchActive) {
        setQuery(t("imageSearchToken"));
      }
    }, [imageSearchActive]);
    const [dragOver, setDragOver] = useState(false);
    const [showFilters, setShowFilters] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const cameraDropdownRef = useRef<HTMLDivElement>(null);
    const lensDropdownRef = useRef<HTMLDivElement>(null);
    const [locallyDragging, setLocallyDragging] = useState(false);
    const queryRef = useRef(query);
    useEffect(() => {
      queryRef.current = query;
    }, [query]);

    function clearHistory() {
      try {
        localStorage.removeItem(HISTORY_KEY);
      } catch {
        /* ignore */
      }
      setHistory([]);
      setShowSuggestions(false);
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

    // Close suggestions on blur (delay to allow click on suggestion items)
    function handleInputBlur() {
      setTimeout(() => setShowSuggestions(false), 150);
    }

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
      type: "tag" | "history";
      text: string;
    }) {
      setQuery(suggestion.text);
      addToHistory(suggestion.text);
      onSearch(suggestion.text, hasActiveFilters ? filters : undefined);
      setShowSuggestions(false);
    }

    function handleDragOver(e: React.DragEvent) {
      if (!onImageSearch) {
        return;
      }
      // Only accept single image files (reject folders)
      if (
        e.dataTransfer.types.includes("Files") &&
        e.dataTransfer.items.length === 1 &&
        e.dataTransfer.items[0].kind === "file" &&
        e.dataTransfer.items[0].type.startsWith("image/")
      ) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = "copy";
        setDragOver(true);
      }
    }

    function handleDragLeave(e: React.DragEvent) {
      e.preventDefault();
      setDragOver(false);
    }

    function handleDrop(e: React.DragEvent) {
      e.preventDefault();
      setDragOver(false);
      if (!onImageSearch) {
        return;
      }
      const file = e.dataTransfer.files[0];
      if (file?.type.startsWith("image/")) {
        const filePath = (window as any).electronAPI?.getFilePath?.(file);
        if (filePath) {
          onImageSearch(filePath);
        }
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
        onSearch(
          query.trim(),
          hasActiveFilters ? filters : undefined
        );
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
        className={`relative border-border border-b transition-colors ${dragOver ? "bg-primary/5" : ""}`}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        {dragOver && (
          <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-[6px] border-2 border-primary border-dashed bg-primary/10">
            <span className="font-[510] text-[13px] text-primary">
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
                className="h-9 w-full rounded-[6px] border border-border bg-card pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/70 focus:border-primary focus:ring-1 focus:ring-ring"
                onBlur={handleInputBlur}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setShowSuggestions(true);
                }}
                onFocus={() => setShowSuggestions(suggestions.length > 0)}
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
                <button
                  className={`flex h-9 w-9 items-center justify-center rounded-[6px] transition-colors ${
                    imageSearchActive
                      ? "bg-primary/10 text-primary"
                      : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
                  }`}
                  onClick={() => fileInputRef.current?.click()}
                  title={t("imageSearchTitle")}
                >
                  <ImageUp className="h-4 w-4" />
                </button>
              </>
            )}
            <button
              className={`flex h-9 w-9 items-center justify-center rounded-[6px] transition-colors ${
                showFilters || hasActiveFilters
                  ? "bg-primary/10 text-primary"
                  : "text-muted-foreground/70 hover:bg-foreground/5 hover:text-foreground"
              }`}
              onClick={() => setShowFilters((prev) => !prev)}
              title={t("exifFilterTitle")}
            >
              <Filter className="h-4 w-4" />
            </button>
          </div>

          {/* Search status line — shows mode, timing, and result count */}
          {(searchMode ||
            searchTime !== undefined ||
            resultCount !== undefined) && (
            <div className="mt-2 flex items-center gap-2 text-[11px]">
              {searchMode && (
                <span className="rounded-[4px] bg-primary/10 px-1.5 py-0.5 font-[510] text-primary inline-flex items-center gap-1">
                  {searchMode === "text"
                    ? t("searchModeSemantic")
                    : searchMode === "image"
                      ? t("searchModeImage")
                      : searchMode === "color" && colorHex
                        ? (
                          <>
                            <span
                              className="inline-block h-2.5 w-2.5 rounded-full"
                              style={{ backgroundColor: `#${colorHex}` }}
                            />
                            {hexToColorName(`#${colorHex}`, "zh")}
                          </>
                        )
                        : t("searchModeExif")}
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

          {/* Color hex chip — shown separately from Exif filter chips */}
          {colorHex && (
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              <span className="inline-flex items-center gap-1.5 rounded-[4px] bg-primary/10 px-2 py-0.5 font-[510] text-[10px] text-primary">
                <span
                  className="inline-block h-2.5 w-2.5 rounded-full"
                  style={{ backgroundColor: `#${colorHex}` }}
                />
                <span className="font-mono">#{colorHex.toUpperCase()}</span>
                <button
                  className="ml-0.5 hover:text-foreground"
                  onClick={() => onClear()}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
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
              className="mt-2 rounded-[8px] border border-border bg-secondary p-3"
              onKeyDown={handleFilterKeyDown}
            >
              <FilterBreadcrumb
                filters={filters}
                getFilterLabel={getFilterLabel}
                onClearAll={clearFilters}
                onRemoveFilter={(key) => updateFilter(key, "", true)}
              />
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {/* Date range */}
                <div>
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                      <div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-[6px] border border-border bg-popover shadow-lg ring-1 ring-foreground/5">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                      <div className="absolute top-full right-0 left-0 z-50 mt-1 max-h-48 overflow-y-auto rounded-[6px] border border-border bg-popover shadow-lg ring-1 ring-foreground/5">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                  <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
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
                    className="rounded-[4px] bg-primary/10 px-2 py-1 font-[510] text-[11px] text-primary hover:bg-primary/20"
                    onClick={() => {
                      onSearch(query.trim(), hasActiveFilters ? filters : undefined);
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
        {showSuggestions && suggestions.length > 0 && (
          <div
            className="absolute top-full right-4 left-4 z-50 mt-1 overflow-hidden rounded-[8px] border border-border bg-popover ring-1 ring-foreground/5"
            ref={dropdownRef}
          >
            <div className="flex items-center justify-between px-3 py-1.5">
              <span className="font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                {query.trim() ? t("searchSuggestions") : t("recentSearches")}
              </span>
              {!query.trim() && (
                <button
                  className="text-[10px] text-muted-foreground/70 hover:text-foreground"
                  onClick={clearHistory}
                  type="button"
                >
                  {t("clearAll")}
                </button>
              )}
            </div>
            {suggestions.map((s, i) => (
              <button
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
                key={`${s.type}-${i}`}
                onClick={() => handleSuggestionClick(s)}
                onMouseDown={(e) => e.preventDefault()}
              >
                {s.type === "tag" ? (
                  <>
                    <span
                      className="h-2 w-2 flex-shrink-0 rounded-full"
                      style={{ background: s.color }}
                    />
                    <span className="truncate">{s.text}</span>
                    <span className="ml-auto flex-shrink-0 text-[10px] text-muted-foreground/70">
                      <Tag className="h-3 w-3" />
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
          </div>
        )}
      </div>
    );
  }
);

function FilterChip({
  label,
  onRemove,
}: {
  label: string;
  onRemove: () => void;
}) {
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] bg-primary/10 px-2 py-0.5 font-[510] text-[10px] text-primary">
      {label}
      <button className="ml-0.5 hover:text-foreground" onClick={onRemove}>
        <X className="h-2.5 w-2.5" />
      </button>
    </span>
  );
}
