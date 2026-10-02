import { useLayoutEffect, useRef } from "react";

/** Keep the committed gallery until photos and sequence ownership agree. */
export function useGallerySnapshot<T>({
  enabled,
  ready,
  value,
}: {
  enabled: boolean;
  ready: boolean;
  value: T;
}) {
  const committed = useRef<{ value: T } | null>(null);
  // Only store values from committed renders; abandoned concurrent renders
  // must not become the fallback for a later folder switch.
  useLayoutEffect(() => {
    if (!enabled) {
      committed.current = null;
    } else if (ready) {
      committed.current = { value };
    }
  }, [enabled, ready, value]);

  const retaining = enabled && !ready && committed.current !== null;
  return {
    retaining,
    value: retaining && committed.current ? committed.current.value : value,
  };
}
