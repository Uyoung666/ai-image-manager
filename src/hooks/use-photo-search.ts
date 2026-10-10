import { useCallback, useEffect, useRef } from "react";
import { cancelPhotoSearch, searchPhotos } from "@/actions/photo-search";

/** Cancellation belongs to this renderer; shared inference keeps its other subscribers. */
export function usePhotoSearch() {
  const pending = useRef(new Set<string>());
  const mounted = useRef(false);
  const cancelPending = useCallback(() => {
    for (const requestId of pending.current) {
      cancelPhotoSearch(requestId).catch(() => undefined);
    }
    pending.current.clear();
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      // StrictMode immediately replays setup. Cancel only if this renderer
      // really unmounted, so a one-time drill-down request stays subscribed.
      queueMicrotask(() => {
        if (!mounted.current) {
          cancelPending();
        }
      });
    };
  }, [cancelPending]);
  const runSearch = useCallback(
    async (params: Parameters<typeof searchPhotos>[0]) => {
      cancelPending();
      const requestId = crypto.randomUUID();
      pending.current.add(requestId);
      try {
        return await searchPhotos({ ...params, requestId });
      } finally {
        pending.current.delete(requestId);
      }
    },
    [cancelPending]
  );
  return { runSearch, cancelPending };
}
