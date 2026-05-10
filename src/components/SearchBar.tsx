import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { Search, X, Clock } from "lucide-react";

const HISTORY_KEY = "search_history";
const MAX_HISTORY = 20;

function loadHistory(): string[] {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

function saveHistory(items: string[]) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(items.slice(0, MAX_HISTORY)));
  } catch { /* ignore */ }
}

interface SearchBarProps {
  onSearch: (query: string) => void;
  onClear: () => void;
  onImageSearch?: (imagePath: string) => void;
}

export function SearchBar({ onSearch, onClear, onImageSearch }: SearchBarProps) {
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
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node) &&
          inputRef.current && !inputRef.current.contains(e.target as Node)) {
        setShowHistory(false);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  const addToHistory = useCallback((q: string) => {
    if (!q.trim()) return;
    setHistory(prev => {
      const next = [q, ...prev.filter(h => h !== q)].slice(0, MAX_HISTORY);
      saveHistory(next);
      return next;
    });
  }, []);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim()) return;
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
    if (!onImageSearch) return;
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
    if (!onImageSearch) return;
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      // Electron exposes the full path via (file as any).path
      const filePath = (file as any).path;
      if (filePath) {
        onImageSearch(filePath);
      }
    }
  }

  return (
    <div
      className={`px-4 py-3 border-b border-[rgba(255,255,255,0.06)] relative transition-colors ${dragOver ? "bg-[#5e6ad2]/5" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {dragOver && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#5e6ad2]/10 border-2 border-dashed border-[#5e6ad2] rounded-[6px] m-2 pointer-events-none">
          <span className="text-[#5e6ad2] text-[13px] font-[510]">拖放图片以搜索相似照片</span>
        </div>
      )}
      <form onSubmit={handleSubmit} className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#6b6b75]" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setShowHistory(history.length > 0)}
          placeholder={t("searchPlaceholder")}
          className="w-full h-9 pl-9 pr-8 bg-[#1c1e22] border border-[rgba(255,255,255,0.06)] rounded-[6px] text-[14px] text-[#f7f8f8] placeholder:text-[#6b6b75] outline-none focus:border-[#5e6ad2] focus:ring-1 focus:ring-[#5e6ad2] transition-colors"
        />
        {query && (
          <button
            type="button"
            onClick={handleClear}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center text-[#6b6b75] hover:text-[#f7f8f8]"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </form>

      {/* Search history dropdown */}
      {showHistory && history.length > 0 && (
        <div
          ref={dropdownRef}
          className="absolute left-4 right-4 top-full z-50 mt-1 bg-[#1c1e22] border border-[#2c2c30] rounded-[8px] shadow-[0_8px_30px_rgba(0,0,0,0.5)] overflow-hidden"
        >
          <div className="px-3 py-1.5 text-[10px] text-[#6b6b75] font-[510] uppercase tracking-wider">
            最近搜索
          </div>
          {history.slice(0, 8).map((h, i) => (
            <button
              key={i}
              onClick={() => handleHistoryClick(h)}
              className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-[#a1a1aa] hover:bg-white/5 hover:text-[#f7f8f8] text-left"
            >
              <Clock className="w-3 h-3 flex-shrink-0 text-[#6b6b75]" />
              <span className="truncate">{h}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
