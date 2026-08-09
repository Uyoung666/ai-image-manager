import { useCallback, useSyncExternalStore } from "react";

/** Keeps component behavior in sync with the same media queries used by CSS. */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (typeof window.matchMedia !== "function") {
        return () => undefined;
      }
      const mediaQuery = window.matchMedia(query);
      mediaQuery.addEventListener("change", onStoreChange);
      return () => mediaQuery.removeEventListener("change", onStoreChange);
    },
    [query]
  );
  const getSnapshot = useCallback(
    () =>
      typeof window.matchMedia === "function"
        ? window.matchMedia(query).matches
        : false,
    [query]
  );

  return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
