import { useEffect, useRef, useState } from "react";
import { useScrollPosition } from "@/contexts/ScrollPositionContext";

/** 预加载超时（毫秒），超时后强制 ready，走降级像素恢复路径 */
const PRELOAD_TIMEOUT_MS = 1500;

/** 额外预加载的页数余量，防止 estimatedGlobalIndex 微小偏差 */
const PRELOAD_PAGE_MARGIN = 2;

export type PreloadState = "idle" | "preloading" | "ready";

interface UseScrollRestorePreloaderParams {
  /** 当前已加载 item 总数（用于判断是否已有足够数据） */
  currentItemCount: number;
  /** 是否还有更多数据可加载 */
  hasMore: boolean;
  /** 是否正在加载下一页 */
  isFetchingNextPage: boolean;
  /** 超时降级回调：预加载超时后触发，用于通知用户位置已重置 */
  onTimeout?: () => void;
  /** 每页数据量（须与 usePhotos 中的 PAGE_SIZE 一致） */
  pageSize: number;
  /** 当前路由 routeKey */
  routeKey: string;
}

interface UseScrollRestorePreloaderResult {
  fallbackScrollTop: number;
  preloadedAnchor: {
    itemId: number;
    offsetRatio: number;
    offsetFromTop: number;
  } | null;
  preloadState: PreloadState;
}

/**
 * 信号驱动预加载：检查锚点 → 计算所需页数 → 父组件顺序 fetchNextPage。
 * 3 秒超时逃生舱，避免 TanStack Query 内部并发竞态。
 */
export function useScrollRestorePreloader({
  routeKey,
  pageSize,
  currentItemCount,
  hasMore,
  isFetchingNextPage,
  onTimeout,
}: UseScrollRestorePreloaderParams): UseScrollRestorePreloaderResult {
  const scrollPosition = useScrollPosition();
  const [preloadState, setPreloadState] = useState<PreloadState>("idle");
  const preloadedAnchorRef = useRef<{
    itemId: number;
    offsetRatio: number;
    offsetFromTop: number;
  } | null>(null);
  const fallbackScrollTopRef = useRef(0);
  const pagesNeededRef = useRef(0);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeKeyAtStartRef = useRef(routeKey);

  // 清理超时
  const clearPreloadTimeout = () => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  };

  useEffect(() => {
    clearPreloadTimeout();
    routeKeyAtStartRef.current = routeKey;

    const saved = scrollPosition.getScrollPosition(routeKey);
    if (!saved || saved.scrollTop <= 0) {
      fallbackScrollTopRef.current = 0;
      setPreloadState("ready");
      return;
    }

    const hasAnchor = saved.anchor && saved.anchor.itemId;
    const estimatedIndex = saved.anchor?.estimatedGlobalIndex;

    if (!hasAnchor || estimatedIndex === undefined) {
      // 无锚点 → 降级像素恢复，直接 ready
      preloadedAnchorRef.current = null;
      fallbackScrollTopRef.current = saved.scrollTop;
      setPreloadState("ready");
      return;
    }

    // 计算需要的页数
    const anchor = saved.anchor!;
    const targetPage = Math.floor(estimatedIndex / pageSize);
    const needed = Math.max(1, targetPage + 1 + PRELOAD_PAGE_MARGIN);
    pagesNeededRef.current = needed;

    const currentPages = Math.ceil(currentItemCount / pageSize) || 1;

    if (currentPages >= needed) {
      // 已有足够数据 → 直接 ready
      preloadedAnchorRef.current = {
        itemId: anchor.itemId,
        offsetRatio: anchor.offsetRatio,
        offsetFromTop: anchor.offsetFromTop,
      };
      fallbackScrollTopRef.current = saved.scrollTop;
      setPreloadState("ready");
      return;
    }

    preloadedAnchorRef.current = {
      itemId: anchor.itemId,
      offsetRatio: anchor.offsetRatio,
      offsetFromTop: anchor.offsetFromTop,
    };
    fallbackScrollTopRef.current = saved.scrollTop;

    if (hasMore) {
      setPreloadState("preloading");

      // 超时逃生舱：强制 ready，降级像素恢复
      timeoutRef.current = setTimeout(() => {
        preloadedAnchorRef.current = null;
        onTimeout?.();
        setPreloadState("ready");
      }, PRELOAD_TIMEOUT_MS);
    } else {
      // 没有更多数据可加载 → 直接 ready（能恢复多少算多少）
      setPreloadState("ready");
    }

    return clearPreloadTimeout;
  }, [routeKey]); // 仅 routeKey 变化时重新评估

  // Step 2: 当 currentItemCount 增长时，检查是否已加载足够
  useEffect(() => {
    if (preloadState !== "preloading") {
      return;
    }

    const currentPages = Math.ceil(currentItemCount / pageSize) || 1;
    if (currentPages >= pagesNeededRef.current) {
      // 已加载足够页数 → ready
      clearPreloadTimeout();
      setPreloadState("ready");
    }
  }, [currentItemCount, preloadState, pageSize]);

  return {
    preloadState,
    preloadedAnchor: preloadedAnchorRef.current,
    fallbackScrollTop: fallbackScrollTopRef.current,
  };
}
