import { useCallback, useState } from "react";
import {
  clearSavedHistory,
  loadHistory,
  MAX_HISTORY,
  saveHistory,
} from "@/components/search-bar-utils";
export function useSearchHistory() {
  const [history, setHistory] = useState<string[]>(loadHistory);
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

  const clearHistory = () => {
    clearSavedHistory();
    setHistory([]);
  };
  return { history, addToHistory, clearHistory };
}
