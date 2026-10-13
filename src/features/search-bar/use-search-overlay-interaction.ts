import { useEffect, useRef, useState } from "react";

const MODAL_SURFACE_SELECTOR =
  '[aria-modal="true"], [role="alertdialog"], [data-slot="dialog-content"], [data-slot="alert-dialog-content"]';

export function useSearchOverlayInteraction({
  query,
  imageSearchActive,
  hasSuggestions,
}: {
  query: string;
  imageSearchActive?: boolean;
  hasSuggestions: boolean;
}) {
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const toolbarRef = useRef<HTMLElement>(null);
  const suggestionListRef = useRef<HTMLDivElement>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [floatingPanelMaxHeight, setFloatingPanelMaxHeight] = useState(440);
  const showSuggestionPanel =
    showSuggestions &&
    !imageSearchActive &&
    !showFilters &&
    (!query.trim() || hasSuggestions);

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
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve existing editing and modal shortcut exclusions
    function handleFocusShortcut(event: KeyboardEvent) {
      if (event.defaultPrevented) {
        return;
      }
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.shiftKey ||
        event.altKey ||
        event.key.toLowerCase() !== "f"
      ) {
        return;
      }

      const target = event.target;
      const targetElement = target instanceof HTMLElement ? target : undefined;
      const searchInput = inputRef.current;

      // Keep native editing controls and content-editable regions in charge
      // of their own shortcuts. The gallery search input is the one
      // editing control intentionally handled here.
      if (
        targetElement &&
        targetElement !== searchInput &&
        (targetElement.tagName === "INPUT" ||
          targetElement.tagName === "TEXTAREA" ||
          targetElement.tagName === "SELECT" ||
          targetElement.isContentEditable)
      ) {
        return;
      }

      // SearchBar lives in the page shell, so do not pull focus through an
      // open modal surface. The desktop sidebar also uses role="dialog",
      // but is non-modal until aria-modal is true.
      if (
        targetElement?.closest(MODAL_SURFACE_SELECTOR) ||
        document.querySelector(MODAL_SURFACE_SELECTOR)
      ) {
        return;
      }

      if (!searchInput) {
        return;
      }

      event.preventDefault();
      searchInput.focus();
      searchInput.select();
    }

    document.addEventListener("keydown", handleFocusShortcut);
    return () => {
      document.removeEventListener("keydown", handleFocusShortcut);
    };
  }, []);

  useEffect(() => {
    function closeMenus(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Element &&
        target.closest('[data-overlay-kind="filter-presets"]')
      ) {
        return;
      }
      if (!toolbarRef.current?.contains(target as Node)) {
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

  return {
    inputRef,
    dropdownRef,
    toolbarRef,
    suggestionListRef,
    showSuggestions,
    setShowSuggestions,
    inputFocused,
    setInputFocused,
    showFilters,
    setShowFilters,
    suggestionIndex,
    setSuggestionIndex,
    floatingPanelMaxHeight,
    showSuggestionPanel,
    handleInputBlur,
  };
}
