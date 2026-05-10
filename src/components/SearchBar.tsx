import { Clock, Search, X } from "lucide-react";
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

interface SearchBarProps {
  onClear: () => void;
  onImageSearch?: (imagePath: string) => void;
  onSearch: (query: string) => void;
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
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

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
    if (!query.trim()) {
      return;
    }
    addToHistory(query.trim());
    onSearch(query.trim());
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
    onSearch(h);
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
      // Electron exposes the full path via (file as any).path
      const filePath = (file as any).path;
      if (filePath) {
        onImageSearch(filePath);
      }
    }
  }

  return (
    <div
      className={`relative border-[rgba(255,255,255,0.06)] border-b px-4 py-3 transition-colors ${dragOver ? "bg-[#5e6ad2]/5" : ""}`}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-0 z-10 m-2 flex items-center justify-center rounded-[6px] border-2 border-[#5e6ad2] border-dashed bg-[#5e6ad2]/10">
          <span className="font-[510] text-[#5e6ad2] text-[13px]">
            拖放图片以搜索相似照片
          </span>
        </div>
      )}
      <form className="relative" onSubmit={handleSubmit}>
        <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-[#6b6b75]" />
        <input
          className="h-9 w-full rounded-[6px] border border-[rgba(255,255,255,0.06)] bg-[#1c1e22] pr-8 pl-9 text-[#f7f8f8] text-[14px] outline-none transition-colors placeholder:text-[#6b6b75] focus:border-[#5e6ad2] focus:ring-1 focus:ring-[#5e6ad2]"
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setShowHistory(history.length > 0)}
          placeholder={t("searchPlaceholder")}
          ref={inputRef}
          type="text"
          value={query}
        />
        {query && (
          <button
            className="absolute top-1/2 right-2 flex h-5 w-5 -translate-y-1/2 items-center justify-center text-[#6b6b75] hover:text-[#f7f8f8]"
            onClick={handleClear}
            type="button"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </form>

      {/* Search history dropdown */}
      {showHistory && history.length > 0 && (
        <div
          className="absolute top-full right-4 left-4 z-50 mt-1 overflow-hidden rounded-[8px] border border-[#2c2c30] bg-[#1c1e22] shadow-[0_8px_30px_rgba(0,0,0,0.5)]"
          ref={dropdownRef}
        >
          <div className="px-3 py-1.5 font-[510] text-[#6b6b75] text-[10px] uppercase tracking-wider">
            最近搜索
          </div>
          {history.slice(0, 8).map((h, i) => (
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[#a1a1aa] text-[13px] hover:bg-white/5 hover:text-[#f7f8f8]"
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
