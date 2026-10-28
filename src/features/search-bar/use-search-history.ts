import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  clearSearchHistory,
  initializeSearchHistory,
  readSearchHistory,
  readSearchHistoryPreferences,
  recordTextSearchHistory,
  removeSearchHistoryEntry,
  SEARCH_HISTORY_CHANGED,
  SEARCH_HISTORY_SAVE_FAILED,
} from "@/actions/search-history";
export function useSearchHistory() {
  const { t } = useTranslation();
  const translate = useRef(t);
  translate.current = t;
  const [history, setHistory] = useState(readSearchHistory);
  const [preferences, setPreferences] = useState(readSearchHistoryPreferences);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let active = true;
    function refresh() {
      setHistory(readSearchHistory());
      setPreferences(readSearchHistoryPreferences());
    }
    const onError = () =>
      toast.error(translate.current("searchHistoryUi.saveFailed"));
    window.addEventListener(SEARCH_HISTORY_CHANGED, refresh);
    window.addEventListener("storage", refresh);
    window.addEventListener(SEARCH_HISTORY_SAVE_FAILED, onError);
    initializeSearchHistory().then(() => {
      if (active) {
        refresh();
        setReady(true);
      }
    });
    return () => {
      active = false;
      window.removeEventListener(SEARCH_HISTORY_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
      window.removeEventListener(SEARCH_HISTORY_SAVE_FAILED, onError);
    };
  }, []);
  return {
    history:
      ready && preferences.enabled ? history.slice(0, preferences.limit) : [],
    historyCount: history.length,
    preferences,
    ready,
    addToHistory: recordTextSearchHistory,
    clearHistory: clearSearchHistory,
    removeHistory: removeSearchHistoryEntry,
  };
}
