import { Clock, Filter, ImageUp, Search, Tag, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/ipc/manager";

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
  imageSearchActive?: boolean;
  onClear: () => void;
  onImageSearch?: (imagePath: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
  resultCount?: number;
  searchMode?: "text" | "image" | "exif" | null;
  searchTime?: number;
}

export function SearchBar({
  aiStatus,
  imageSearchActive,
  onSearch,
  onClear,
  onImageSearch,
  resultCount,
  searchMode,
  searchTime,
}: SearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState(imageSearchActive ? t("imageSearchToken") : "");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [tags, setTags] = useState<TagInfo[]>([]);

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
  const [locallyDragging, setLocallyDragging] = useState(false);

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

  const hasActiveFilters = Object.values(filters).some(
    (v) => v && v.length > 0
  );

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

  function updateFilter(key: keyof ExifFilters, value: string) {
    setFilters((prev) => ({ ...prev, [key]: value }));
  }

  function clearFilters() {
    setFilters({});
  }

  function handleFilterKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      onSearch(
        query.trim(),
        hasActiveFilters || undefined ? filters : undefined
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
                    const filePath = (window as any).electronAPI?.getFilePath?.(
                      file
                    );
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
              <span className="rounded-[4px] bg-primary/10 px-1.5 py-0.5 font-[510] text-primary">
                {searchMode === "text"
                  ? t("searchModeSemantic")
                  : searchMode === "image"
                    ? t("searchModeImage")
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

        {/* Active filter chips */}
        {hasActiveFilters && !showFilters && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {filters.dateFrom && (
              <FilterChip
                label={t("filterFrom", { value: filters.dateFrom })}
                onRemove={() => updateFilter("dateFrom", "")}
              />
            )}
            {filters.dateTo && (
              <FilterChip
                label={t("filterTo", { value: filters.dateTo })}
                onRemove={() => updateFilter("dateTo", "")}
              />
            )}
            {filters.cameraModel && (
              <FilterChip
                label={filters.cameraModel}
                onRemove={() => updateFilter("cameraModel", "")}
              />
            )}
            {filters.isoMin && (
              <FilterChip
                label={`ISO ≥ ${filters.isoMin}`}
                onRemove={() => updateFilter("isoMin", "")}
              />
            )}
            {filters.isoMax && (
              <FilterChip
                label={`ISO ≤ ${filters.isoMax}`}
                onRemove={() => updateFilter("isoMax", "")}
              />
            )}
            {filters.apertureMin && (
              <FilterChip
                label={t("apertureGte", { value: filters.apertureMin })}
                onRemove={() => updateFilter("apertureMin", "")}
              />
            )}
            {filters.apertureMax && (
              <FilterChip
                label={t("apertureLte", { value: filters.apertureMax })}
                onRemove={() => updateFilter("apertureMax", "")}
              />
            )}
            {filters.focalMin && (
              <FilterChip
                label={t("focalGte", { value: filters.focalMin })}
                onRemove={() => updateFilter("focalMin", "")}
              />
            )}
            {filters.focalMax && (
              <FilterChip
                label={t("focalLte", { value: filters.focalMax })}
                onRemove={() => updateFilter("focalMax", "")}
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
            <div className="grid grid-cols-5 gap-3">
              {/* Date range */}
              <div>
                <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("dateRangeLabel")}
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("dateFrom", e.target.value)}
                    pattern="\d{4}-\d{2}-\d{2}"
                    placeholder={t("dateFromPlaceholder")}
                    type="text"
                    value={filters.dateFrom || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("dateTo", e.target.value)}
                    pattern="\d{4}-\d{2}-\d{2}"
                    placeholder={t("dateToPlaceholder")}
                    type="text"
                    value={filters.dateTo || ""}
                  />
                </div>
              </div>

              {/* Camera */}
              <div>
                <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("cameraModelLabel")}
                </label>
                <input
                  className={filterInputClass}
                  onChange={(e) => updateFilter("cameraModel", e.target.value)}
                  placeholder={t("cameraPlaceholder")}
                  value={filters.cameraModel || ""}
                />
              </div>

              {/* ISO range */}
              <div>
                <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("isoRangeLabel")}
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("isoMin", e.target.value)}
                    placeholder={t("isoMinPlaceholder")}
                    type="number"
                    value={filters.isoMin || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("isoMax", e.target.value)}
                    placeholder={t("isoMaxPlaceholder")}
                    type="number"
                    value={filters.isoMax || ""}
                  />
                </div>
              </div>

              {/* Aperture range */}
              <div>
                <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("apertureLabel")}
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    min="0.7"
                    onChange={(e) =>
                      updateFilter("apertureMin", e.target.value)
                    }
                    placeholder={t("minExamplePlaceholder", { value: "1.4" })}
                    step="0.1"
                    type="number"
                    value={filters.apertureMin || ""}
                  />
                  <input
                    className={filterInputClass}
                    min="0.7"
                    onChange={(e) =>
                      updateFilter("apertureMax", e.target.value)
                    }
                    placeholder={t("maxExamplePlaceholder", { value: "5.6" })}
                    step="0.1"
                    type="number"
                    value={filters.apertureMax || ""}
                  />
                </div>
              </div>

              {/* Focal length range */}
              <div>
                <label className="mb-1 block font-[510] text-[10px] text-muted-foreground/70 uppercase tracking-wider">
                  {t("focalLabel")}
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("focalMin", e.target.value)}
                    placeholder={t("minExamplePlaceholder", { value: "24" })}
                    type="number"
                    value={filters.focalMin || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("focalMax", e.target.value)}
                    placeholder={t("maxExamplePlaceholder", { value: "200" })}
                    type="number"
                    value={filters.focalMax || ""}
                  />
                </div>
              </div>
            </div>

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
                    onSearch(query.trim(), filters);
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
