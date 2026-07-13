import {
  type ForwardedRef,
  type RefObject,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
} from "react";
import type { MasonryItem } from "@/hooks/useMasonryLayout";
import { isDevRuntime } from "@/utils/gallery-perf";
import { binarySearchVisibilityStart } from "@/utils/masonry-utils";

export interface MasonryAnchor {
  itemId: number;
  offsetFromTop: number;
  offsetRatio: number;
  estimatedGlobalIndex?: number;
}

export interface MasonryGridHandle {
  cancelEnforceLock(): void;
  getCurrentAnchor(): MasonryAnchor | null;
  readonly scrollElement: HTMLDivElement | null;
  scrollToItem(itemId: number, offsetRatio: number): void;
  scrollToPixel(scrollTop: number): void;
}

interface UseMasonryAnchorOptions<T extends { id: number }> {
  containerWidth: number;
  forwardedRef: ForwardedRef<MasonryGridHandle>;
  forceUnlockRef: RefObject<(() => void) | null>;
  idToIndexMap: Map<number, number>;
  items: T[];
  positions: MasonryItem[];
  scrollRef: RefObject<HTMLDivElement | null>;
  visibilityIndex: number[];
}

const ENFORCE_LOCK_MS = 800;

export function useMasonryAnchor<T extends { id: number }>({
  containerWidth,
  forwardedRef,
  forceUnlockRef,
  idToIndexMap,
  items,
  positions,
  scrollRef,
  visibilityIndex,
}: UseMasonryAnchorOptions<T>): {
  getCurrentAnchor: () => MasonryAnchor | null;
  gridRef: RefObject<MasonryGridHandle | null>;
} {
  const latestPositionsRef = useRef(positions);
  const latestIdMapRef = useRef(idToIndexMap);
  const latestItemsRef = useRef(items);
  const latestVisibilityIndexRef = useRef(visibilityIndex);
  const gridRef = useRef<MasonryGridHandle | null>(null);
  const enforceLockRef = useRef<{
    itemId: number;
    ratio: number;
    expiresAt: number;
  } | null>(null);

  useLayoutEffect(() => {
    latestPositionsRef.current = positions;
    latestIdMapRef.current = idToIndexMap;
    latestItemsRef.current = items;
    latestVisibilityIndexRef.current = visibilityIndex;
  }, [positions, idToIndexMap, items, visibilityIndex]);

  const enforceScroll = useCallback(() => {
    const lock = enforceLockRef.current;
    const el = scrollRef.current;
    if (!(lock && el)) {
      return;
    }

    const posList = latestPositionsRef.current;
    const idx = latestIdMapRef.current.get(lock.itemId);
    if (idx === undefined || !posList[idx]) {
      return;
    }

    const pos = posList[idx];
    el.scrollTop = pos.top + pos.height * lock.ratio;
  }, [scrollRef]);

  const getCurrentAnchor = useCallback(() => {
    const el = scrollRef.current;
    const posList = latestPositionsRef.current;
    const curItems = latestItemsRef.current;
    if (!el || posList.length === 0 || curItems.length === 0) {
      return null;
    }

    const currentScrollTop = el.scrollTop;
    const firstVisibleIdx = binarySearchVisibilityStart(
      latestVisibilityIndexRef.current,
      currentScrollTop
    );
    if (firstVisibleIdx < 0 || firstVisibleIdx >= curItems.length) {
      return null;
    }

    const pos = posList[firstVisibleIdx];
    const item = curItems[firstVisibleIdx];
    const offsetFromTop = currentScrollTop - pos.top;
    const offsetRatio =
      pos.height > 0
        ? Math.max(0, Math.min(1, offsetFromTop / pos.height))
        : 0;

    const anchor = {
      itemId: item.id,
      offsetFromTop,
      offsetRatio,
      estimatedGlobalIndex: firstVisibleIdx,
    };

    if (isDevRuntime()) {
      console.log("📍 [Anchor Capture]", anchor);
    }
    return anchor;
  }, [scrollRef]);

  useImperativeHandle(
    forwardedRef,
    () => {
      const api: MasonryGridHandle = {
        scrollToItem(itemId: number, offsetRatio: number) {
          enforceLockRef.current = {
            itemId,
            ratio: offsetRatio,
            expiresAt: Date.now() + ENFORCE_LOCK_MS,
          };

          const frameLoop = () => {
            const lock = enforceLockRef.current;
            if (!lock) {
              return;
            }
            if (Date.now() > lock.expiresAt) {
              enforceLockRef.current = null;
              return;
            }
            enforceScroll();
            requestAnimationFrame(frameLoop);
          };
          requestAnimationFrame(frameLoop);
        },
        scrollToPixel(scrollTop: number) {
          const el = scrollRef.current;
          if (el) {
            el.scrollTop = Math.max(0, scrollTop);
          }
        },
        get scrollElement() {
          return scrollRef.current;
        },
        cancelEnforceLock() {
          enforceLockRef.current = null;
        },
        getCurrentAnchor,
      };
      gridRef.current = api;
      return api;
    },
    [enforceScroll, forwardedRef, getCurrentAnchor, scrollRef]
  );

  useLayoutEffect(() => {
    const lock = enforceLockRef.current;
    if (lock && Date.now() < lock.expiresAt) {
      enforceScroll();
    }
  }, [positions, containerWidth, enforceScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    const handleUserIntervention = () => {
      enforceLockRef.current = null;
      forceUnlockRef.current?.();
    };

    el.addEventListener("wheel", handleUserIntervention, { passive: true });
    el.addEventListener("touchstart", handleUserIntervention, {
      passive: true,
    });
    el.addEventListener("keydown", handleUserIntervention, { passive: true });

    return () => {
      el.removeEventListener("wheel", handleUserIntervention);
      el.removeEventListener("touchstart", handleUserIntervention);
      el.removeEventListener("keydown", handleUserIntervention);
    };
  }, [forceUnlockRef, scrollRef]);

  return { getCurrentAnchor, gridRef };
}
