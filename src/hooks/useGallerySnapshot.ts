import { useLayoutEffect, useRef } from "react";

/** Keep the committed gallery until photos and sequence ownership agree. */
export function useGallerySnapshot<T>({
  enabled,
  contextKey,
  ready,
  value,
}: {
  enabled: boolean;
  contextKey?: string;
  ready: boolean;
  value: T;
}) {
  const committed = useRef<{ value: T; contextKey?: string } | null>(null);
  // Only store values from committed renders; abandoned concurrent renders
  // must not become the fallback for a later folder switch.
  useLayoutEffect(() => {
    if (!enabled) {
      committed.current = null;
    } else if (ready) {
      committed.current = { value, contextKey };
    }
  }, [enabled, ready, value, contextKey]);

  const retaining = enabled && !ready && committed.current !== null;
  return {
    retaining,
    // Deferred page appends keep valid cards from the same query. Applying
    // inert to that snapshot makes Chromium blur a just-restored card.
    blocksInput:
      retaining &&
      (contextKey === undefined ||
        committed.current?.contextKey !== contextKey),
    value: retaining && committed.current ? committed.current.value : value,
  };
}
