import { Clock, Filter, Search, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

const HISTORY_KEY = "search_history";
const MAX_HISTORY = 20;

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
}

interface SearchBarProps {
  onClear: () => void;
  onImageSearch?: (imagePath: string) => void;
  onSearch: (query: string, filters?: ExifFilters) => void;
}

export function SearchBar({
  onSearch,
  onClear,
  onImageSearch,
}: SearchBarProps) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [history, setHistory] = useState<string[]>(loadHistory);
  const [showHistory, setShowHistory] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Filter state
  const [filters, setFilters] = useState<ExifFilters>({});

  const hasActiveFilters = Object.values(filters).some(
    (v) => v && v.length > 0
  );

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    function handleGlobalShortcut(e: MessageEvent) {
      if (e.data === "global-shortcut:search") {
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("message", handleGlobalShortcut);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("message", handleGlobalShortcut);
    };
  }, []);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node) &&
        inputRef.current &&
        !inputRef.current.contains(e.target as Node)
      ) {
        setShowHistory(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

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
    setShowHistory(false);
  }

  function handleClear() {
    setQuery("");
    onClear();
    inputRef.current?.focus();
  }

  function handleHistoryClick(h: string) {
    setQuery(h);
    addToHistory(h);
    onSearch(h, hasActiveFilters ? filters : undefined);
    setShowHistory(false);
  }

  function handleDragOver(e: React.DragEvent) {
    if (!onImageSearch) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setDragOver(true);
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
      const filePath = (file as any).path;
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

  const filterInputClass =
    "h-8 w-full rounded-[4px] border border-border bg-card px-2 text-[12px] text-foreground outline-none placeholder:text-[#6b6b75] focus:border-primary/40";

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
            拖放图片以搜索相似照片
          </span>
        </div>
      )}

      <div className="px-4 py-3">
        {/* Search input row */}
        <div className="flex items-center gap-2">
          <form className="relative flex-1" onSubmit={handleSubmit}>
            <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#6b6b75]" />
            <input
              className="h-9 w-full rounded-[6px] border border-border bg-card pr-8 pl-9 text-[14px] text-foreground outline-none transition-colors placeholder:text-[#6b6b75] focus:border-primary focus:ring-1 focus:ring-ring"
              onChange={(e) => setQuery(e.target.value)}
              onFocus={() => setShowHistory(history.length > 0)}
              placeholder={t("searchPlaceholder")}
              ref={inputRef}
              type="text"
              value={query}
            />
            {query && (
              <button
                className="absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-[#6b6b75] hover:text-foreground"
                onClick={handleClear}
                type="button"
              >
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </form>

          <button
            className={`flex h-9 w-9 items-center justify-center rounded-[6px] transition-colors ${
              showFilters || hasActiveFilters
                ? "bg-primary/10 text-primary"
                : "text-[#6b6b75] hover:bg-foreground/5 hover:text-foreground"
            }`}
            onClick={() => setShowFilters((prev) => !prev)}
            title="EXIF 筛选"
          >
            <Filter className="h-4 w-4" />
          </button>
        </div>

        {/* Active filter chips */}
        {hasActiveFilters && !showFilters && (
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {filters.dateFrom && (
              <FilterChip
                label={`从 ${filters.dateFrom}`}
                onRemove={() => updateFilter("dateFrom", "")}
              />
            )}
            {filters.dateTo && (
              <FilterChip
                label={`至 ${filters.dateTo}`}
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
                label={`光圈 ≥ f/${filters.apertureMin}`}
                onRemove={() => updateFilter("apertureMin", "")}
              />
            )}
            {filters.apertureMax && (
              <FilterChip
                label={`光圈 ≤ f/${filters.apertureMax}`}
                onRemove={() => updateFilter("apertureMax", "")}
              />
            )}
            {filters.focalMin && (
              <FilterChip
                label={`焦段 ≥ ${filters.focalMin}mm`}
                onRemove={() => updateFilter("focalMin", "")}
              />
            )}
            {filters.focalMax && (
              <FilterChip
                label={`焦段 ≤ ${filters.focalMax}mm`}
                onRemove={() => updateFilter("focalMax", "")}
              />
            )}
            <button
              className="rounded-[4px] px-1.5 py-0.5 text-[#6b6b75] text-[10px] hover:text-foreground"
              onClick={clearFilters}
            >
              清除全部
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
                <label className="mb-1 block font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
                  日期范围
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("dateFrom", e.target.value)}
                    placeholder="起始 (YYYY-MM-DD)"
                    type="date"
                    value={filters.dateFrom || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("dateTo", e.target.value)}
                    placeholder="结束 (YYYY-MM-DD)"
                    type="date"
                    value={filters.dateTo || ""}
                  />
                </div>
              </div>

              {/* Camera */}
              <div>
                <label className="mb-1 block font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
                  相机型号
                </label>
                <input
                  className={filterInputClass}
                  onChange={(e) => updateFilter("cameraModel", e.target.value)}
                  placeholder="如 Sony A7M4"
                  value={filters.cameraModel || ""}
                />
              </div>

              {/* ISO range */}
              <div>
                <label className="mb-1 block font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
                  ISO 范围
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("isoMin", e.target.value)}
                    placeholder="最小 ISO"
                    type="number"
                    value={filters.isoMin || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("isoMax", e.target.value)}
                    placeholder="最大 ISO"
                    type="number"
                    value={filters.isoMax || ""}
                  />
                </div>
              </div>

              {/* Aperture range */}
              <div>
                <label className="mb-1 block font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
                  光圈 (f/)
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    min="0.7"
                    onChange={(e) =>
                      updateFilter("apertureMin", e.target.value)
                    }
                    placeholder="最小 (如 1.4)"
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
                    placeholder="最大 (如 5.6)"
                    step="0.1"
                    type="number"
                    value={filters.apertureMax || ""}
                  />
                </div>
              </div>

              {/* Focal length range */}
              <div>
                <label className="mb-1 block font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
                  焦段 (mm)
                </label>
                <div className="space-y-1">
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("focalMin", e.target.value)}
                    placeholder="最小 (如 24)"
                    type="number"
                    value={filters.focalMin || ""}
                  />
                  <input
                    className={filterInputClass}
                    onChange={(e) => updateFilter("focalMax", e.target.value)}
                    placeholder="最大 (如 200)"
                    type="number"
                    value={filters.focalMax || ""}
                  />
                </div>
              </div>
            </div>

            <div className="mt-3 flex items-center justify-between border-border border-t pt-2">
              <span className="text-[#6b6b75] text-[10px]">
                按 Enter 执行搜索
              </span>
              <div className="flex items-center gap-2">
                <button
                  className="rounded-[4px] px-2 py-1 text-[#6b6b75] text-[11px] hover:text-foreground"
                  onClick={() => {
                    clearFilters();
                    setShowFilters(false);
                  }}
                >
                  重置
                </button>
                <button
                  className="rounded-[4px] bg-primary/10 px-2 py-1 font-[510] text-[11px] text-primary hover:bg-primary/20"
                  onClick={() => {
                    onSearch(query.trim(), filters);
                    setShowFilters(false);
                  }}
                >
                  应用筛选
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Search history dropdown */}
      {showHistory && history.length > 0 && (
        <div
          className="absolute top-full right-4 left-4 z-50 mt-1 overflow-hidden rounded-[8px] border border-border bg-popover shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          ref={dropdownRef}
        >
          <div className="px-3 py-1.5 font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
            最近搜索
          </div>
          {history.slice(0, 8).map((h, i) => (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-muted-foreground hover:bg-foreground/5 hover:text-foreground"
              key={i}
              onClick={() => handleHistoryClick(h)}
            >
              <Clock className="h-3 w-3 flex-shrink-0 text-[#6b6b75]" />
              <span className="truncate">{h}</span>
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
