import {
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from "react";
import { recordGalleryPerf } from "@/utils/gallery-perf";

export const END_REACHED_PRELOAD_MARGIN = 2000;
export const FAST_SCROLL_VELOCITY = 60;
const VERY_FAST_SCROLL_VELOCITY = 180;
const END_REACHED_DEBOUNCE_MS = 400;

export function getEndReachedDebounceMs(velocity: number): number {
  if (velocity >= VERY_FAST_SCROLL_VELOCITY) {
    return END_REACHED_DEBOUNCE_MS / 4;
  }
  if (velocity >= FAST_SCROLL_VELOCITY) {
    return END_REACHED_DEBOUNCE_MS / 2;
  }
  return END_REACHED_DEBOUNCE_MS;
}

interface UseMasonryEndReachedOptions {
  containerWidth?: number;
  hasMore: boolean;
  isLoadingMore: boolean;
  onEndReached?: () => void;
  scrollRef: RefObject<HTMLDivElement | null>;
  sentinelRef: RefObject<HTMLDivElement | null>;
  totalHeight: number;
}

export function useMasonryEndReached({
  containerWidth = 0,
  hasMore,
  isLoadingMore,
  onEndReached,
  scrollRef,
  sentinelRef,
  totalHeight,
}: UseMasonryEndReachedOptions): {
  checkNearBottom: (velocity?: number) => void;
  triggerEndReached: (velocity?: number) => void;
} {
  const lastEndReachedRef = useRef(0);
  const endReachedLockedRef = useRef(false);
  const endReachedUnlockTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null
  );
  const onEndReachedRef = useRef(onEndReached);
  onEndReachedRef.current = onEndReached;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const isLoadingMoreRef = useRef(isLoadingMore);
  isLoadingMoreRef.current = isLoadingMore;
  const previousContainerWidthRef = useRef(containerWidth);
  const suspendUntilRef = useRef(0);

  useLayoutEffect(() => {
    const previousWidth = previousContainerWidthRef.current;
    if (
      previousWidth > 0 &&
      containerWidth > 0 &&
      previousWidth !== containerWidth
    ) {
      // Opening or closing the detail panel changes the grid width. Its
      // sentinel can briefly intersect during relayout, which is not a user
      // scroll and should not start a new paged request or show skeletons.
      suspendUntilRef.current = Date.now() + 500;
    }
    previousContainerWidthRef.current = containerWidth;
  }, [containerWidth]);

  const triggerEndReached = useCallback((velocity = 0) => {
    if (
      !(onEndReachedRef.current && hasMoreRef.current) ||
      isLoadingMoreRef.current ||
      endReachedLockedRef.current ||
      Date.now() < suspendUntilRef.current
    ) {
      return;
    }

    const now = Date.now();
    if (now - lastEndReachedRef.current <= getEndReachedDebounceMs(velocity)) {
      return;
    }

    lastEndReachedRef.current = now;
    endReachedLockedRef.current = true;
    recordGalleryPerf("masonryEndReached", 1);
    if (endReachedUnlockTimerRef.current) {
      clearTimeout(endReachedUnlockTimerRef.current);
    }
    endReachedUnlockTimerRef.current = setTimeout(() => {
      if (!isLoadingMoreRef.current) {
        endReachedLockedRef.current = false;
      }
    }, END_REACHED_DEBOUNCE_MS);
    onEndReachedRef.current();
  }, []);

  const checkNearBottom = useCallback(
    (velocity = 0) => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const nearBottom =
        el.scrollTop + el.clientHeight + END_REACHED_PRELOAD_MARGIN >=
        el.scrollHeight;
      if (nearBottom) {
        triggerEndReached(velocity);
      }
    },
    [scrollRef, triggerEndReached]
  );

  useEffect(() => {
    if (!isLoadingMore) {
      endReachedLockedRef.current = false;
    }
  }, [isLoadingMore]);

  useEffect(() => {
    return () => {
      if (endReachedUnlockTimerRef.current) {
        clearTimeout(endReachedUnlockTimerRef.current);
        endReachedUnlockTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!(sentinel && onEndReached && totalHeight > 0)) {
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          triggerEndReached();
        }
      },
      { root: scrollRef.current, rootMargin: "1000px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onEndReached, scrollRef, sentinelRef, totalHeight, triggerEndReached]);

  return { checkNearBottom, triggerEndReached };
}
