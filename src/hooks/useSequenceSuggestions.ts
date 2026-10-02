import { useCallback, useEffect, useRef, useState } from "react";
import { photoSequenceActions } from "@/actions/photo-sequences";
import type { SequenceSuggestion } from "@/types/photo-sequence";

export function useSequenceSuggestions(folderId?: number) {
  const [suggestions, setSuggestions] = useState<SequenceSuggestion[]>([]);
  const [scope, setScope] = useState<number | undefined>(folderId);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busyIds, setBusyIds] = useState<number[]>([]);
  const requestRef = useRef(0);
  const revisionRef = useRef(0);
  const scopeRef = useRef(folderId);
  scopeRef.current = folderId;
  const busyRef = useRef(new Set<number>());

  const refresh = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    setError(false);
    try {
      const result = await photoSequenceActions.listSuggestions(folderId);
      if (request !== requestRef.current || scopeRef.current !== folderId) {
        return false;
      }
      setScope(folderId);
      setSuggestions(result);
      return true;
    } catch {
      if (request === requestRef.current) {
        setError(true);
      }
      return false;
    } finally {
      if (request === requestRef.current) {
        setLoading(false);
      }
    }
  }, [folderId]);

  useEffect(() => {
    setSuggestions([]);
    refresh();
    const onMessage = (event: MessageEvent) => {
      if (event.data?.channel !== "sequences-changed") {
        return;
      }
      const revision = event.data.revision;
      if (typeof revision === "number" && revision <= revisionRef.current) {
        return;
      }
      if (typeof revision === "number") {
        revisionRef.current = revision;
      }
      if (busyRef.current.size) {
        return;
      }
      refresh();
    };
    const onFocus = () => refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        refresh();
      }
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      requestRef.current += 1;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  const accept = useCallback(
    async (suggestion: SequenceSuggestion) => {
      const ids = [suggestion.firstSequenceId, suggestion.secondSequenceId];
      if (ids.some((id) => busyRef.current.has(id))) {
        return null;
      }
      for (const id of ids) {
        busyRef.current.add(id);
      }
      setBusyIds([...busyRef.current]);
      try {
        const result = await photoSequenceActions.acceptSuggestion(
          suggestion.id
        );
        requestRef.current += 1;
        if (scopeRef.current === folderId) {
          setSuggestions((current) =>
            current.filter(
              (entry) =>
                !(
                  ids.includes(entry.firstSequenceId) ||
                  ids.includes(entry.secondSequenceId)
                )
            )
          );
          revisionRef.current = Math.max(revisionRef.current, result.revision);
          await refresh();
        }
        return result;
      } finally {
        for (const id of ids) {
          busyRef.current.delete(id);
        }
        setBusyIds([...busyRef.current]);
      }
    },
    [folderId, refresh]
  );

  return {
    suggestions: scope === folderId ? suggestions : [],
    loading,
    error,
    busyIds,
    refresh,
    accept,
  };
}
