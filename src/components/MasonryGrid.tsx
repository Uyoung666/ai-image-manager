import {
  forwardRef,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTranslation } from "react-i18next";

import {
  type GroupHeaderInput,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { binarySearchStart } from "@/utils/masonry-utils";

export type { GroupHeaderInput as GroupHeader };

export interface MasonryGridHandle {
  /** 立即终止蛮牛锁 rAF 循环，释放滚动控制权给用户 */
  cancelEnforceLock(): void;
  /** 同步获取当前视口锚点（绕过 RAF，直接读取 refs） */
  getCurrentAnchor(): {
    itemId: number;
    offsetFromTop: number;
    offsetRatio: number;
    estimatedGlobalIndex?: number;
  } | null;
  readonly scrollElement: HTMLDivElement | null;
  scrollToItem(itemId: number, offsetRatio: number): void;
  scrollToPixel(scrollTop: number): void;
}

interface MasonryGridProps {
  className?: string;
  columnCount: number;
  containerWidth: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
  hasMore?: boolean;
  /** 正在加载更多数据（对应 useInfiniteQuery 的 isFetchingNextPage） */
  isLoadingMore?: boolean;
  /**
   * 是否为占位数据（keepPreviousData 期间的旧缓存）。
   * 为 true 时锁死滚动恢复和锚点调整，避免基于假数据做定位。
   */
  isPlaceholderData?: boolean;
  items: Array<{
    id: number;
    width: number;
    height: number;
    [key: string]: any;
  }>;
  onEndReached?: () => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  overscan?: number;
  renderItem: (
    item: any,
    index: number,
    style: React.CSSProperties
  ) => ReactNode;
  /**
   * 路由唯一标识，用于区分不同页面的滚动位置
   * 例如: "/" | "/albums/123" | "/people/456"
   */
  routeKey: string;
  scrollToId?: number | null;
  /**
   * When true, the floating "back to top" button is pushed above the
   * SelectionActionBar (which overlays at bottom-2 with ~46px height).
   */
  selectionActive?: boolean;
}

export const MasonryGrid = forwardRef<MasonryGridHandle, MasonryGridProps>(
  function MasonryGrid(
    {
      items,
      containerWidth,
      columnCount,
      gap,
      groupHeaders,
      overscan = 10,
      renderItem,
      onEndReached,
      hasMore = false,
      isLoadingMore = false,
      onMarqueeSelect,
      scrollToId,
      className,
      selectionActive = false,
      routeKey,
      isPlaceholderData = false,
    }: MasonryGridProps,
    ref
  ) {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [isScrolling, setIsScrolling] = useState(false);
    const [currentTimeLabel, setCurrentTimeLabel] = useState("");
    const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafRef = useRef<number>(0);

    // ── 速度感知预加载 ──────────────────────────────────────────────
    const velocityRef = useRef(0);
    const prevScrollYRef = useRef(0);
    const lastEndReachedRef = useRef(0);
    const END_REACHED_DEBOUNCE_MS = 400;
    const onEndReachedRef = useRef(onEndReached);
    onEndReachedRef.current = onEndReached;
    const hasMoreRef = useRef(hasMore);
    hasMoreRef.current = hasMore;
    const isLoadingMoreRef = useRef(isLoadingMore);
    isLoadingMoreRef.current = isLoadingMore;

    const { positions, totalHeight, headerPositions } = useMasonryLayout(
      items,
      containerWidth,
      columnCount,
      gap,
      groupHeaders
    );

    const idToIndexMap = useMemo(
      () => new Map(items.map((item, i) => [item.id, i])),
      [items]
    );

    const internalGridRef = useRef<MasonryGridHandle | null>(null);

    // ── 蛮牛锁（Active Anchor Enforcer）───────────────────────────
    // 问题：单次 set scrollTop 在浏览器物理绘制 DOM 高度之前执行会被
    // 静默 Clamp；ResizeObserver 触发细微宽度调整会改变 positions，
    // 导致连续两次进出位置漂移。
    //
    // 方案：scrollToItem 被调用后，锁定 800ms，在这期间：
    //   1. rAF 循环（~60fps）持续强制设置 scrollTop
    //   2. 任何 useLayoutEffect（positions / containerWidth 变化）补刀
    // 到期后自动解锁，让用户接管滚动。

    const latestPositionsRef = useRef(positions);
    const latestIdMapRef = useRef(idToIndexMap);
    const latestItemsRef = useRef(items);
    useLayoutEffect(() => {
      latestPositionsRef.current = positions;
      latestIdMapRef.current = idToIndexMap;
      latestItemsRef.current = items;
    }, [positions, idToIndexMap, items]);

    // 蛮牛锁：scrollToItem 被调用后锁定 800ms，rAF 循环 + useLayoutEffect 补刀持续强制对齐
    // 硬上限 5s：防止目标 item 被删除/永久不可见时死锁
    const MAX_LOCK_DURATION_MS = 5000;
    const enforceLockRef = useRef<{
      itemId: number;
      ratio: number;
      expiresAt: number;
      startedAt: number;
    } | null>(null);

    const enforceScroll = useCallback(() => {
      const lock = enforceLockRef.current;
      if (!lock) {
        return;
      }
      const el = scrollRef.current;
      if (!el) {
        return;
      }

      const posList = latestPositionsRef.current;
      const idMap = latestIdMapRef.current;
      if (posList.length === 0 || !idMap.has(lock.itemId)) {
        return;
      }

      const idx = idMap.get(lock.itemId)!;
      const pos = posList[idx];
      if (!pos) {
        return;
      }

      // 直接通过计算好的 pos.top 设置 scrollTop。
      // 虚拟列表会在滚动到位后自动渲染该位置的 DOM 节点 —
      // 绝不能在此处检查 DOM 是否存在（死锁：DOM 不在视口 → 不滚动 → 永远不渲染）。
      // 空白区域闪烁由 useScrollRestorePreloader 的预加载门控解决。
      el.scrollTop = pos.top + pos.height * lock.ratio;
    }, []);

    useImperativeHandle(
      ref,
      () => {
        const api: MasonryGridHandle = {
          scrollToItem(itemId: number, offsetRatio: number) {
            enforceLockRef.current = {
              itemId,
              ratio: offsetRatio,
              expiresAt: Date.now() + 800,
              startedAt: Date.now(),
            };

            // 启动 rAF 高频侦测循环（打败 Clamp + 延迟 Paint）
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
          getCurrentAnchor() {
            const el = scrollRef.current;
            const posList = latestPositionsRef.current;
            const curItems = latestItemsRef.current;
            if (!el || posList.length === 0 || curItems.length === 0) {
              return null;
            }
            const currentScrollTop = el.scrollTop;
            const firstVisibleIdx = binarySearchStart(
              posList,
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
            return {
              itemId: item.id,
              offsetFromTop,
              offsetRatio,
              estimatedGlobalIndex: firstVisibleIdx,
            };
          },
        };
        internalGridRef.current = api;
        return api;
      },
      // eslint-disable-next-line react-hooks/exhaustive-deps
      [enforceScroll]
    );

    // ── 被动防御：布局重算时补刀（ResizeObserver / 图片加载等）───
    useLayoutEffect(() => {
      const lock = enforceLockRef.current;
      if (lock && Date.now() < lock.expiresAt) {
        enforceScroll();
      }
    }, [positions, containerWidth, enforceScroll]);

    // ── 闭包免疫的锚点抓取（零依赖，全靠 refs 读取最新数据）──────
    // 关键：useCallback([]) 空依赖，函数引用永远稳定。
    // 所有数据从 latestPositionsRef / latestItemsRef / scrollRef 实时读取，
    // 彻底切断 React render 周期对锚点捕获的绑架——
    // 用户向下滑动加载了 500 张照片后，这里读到的一定是 500 条的长数组。
    const getCurrentAnchor = useCallback(() => {
      const el = scrollRef.current;
      const posList = latestPositionsRef.current;
      const curItems = latestItemsRef.current;
      if (!el || posList.length === 0 || curItems.length === 0) {
        return null;
      }

      const currentScrollTop = el.scrollTop;
      const firstVisibleIdx = binarySearchStart(posList, currentScrollTop);
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

      if (import.meta.env.DEV) {
        console.log("📍 [Anchor Capture]", anchor);
      }
      return anchor;
    }, []); // ← 空依赖！全靠 refs 读最新数据

    // ── 集成路由滚动位置管理 ──────────────────────────────────────
    const restoreReady = positions.length > 0 && !isPlaceholderData;

    const { initialScrollTop, hasInitialPositionedRef, forceUnlock } =
      useRouteScrollRestoration(scrollRef, {
        getRouteKey: () => routeKey,
        getCurrentAnchor,
        restoreFromAnchor: (anchorItemId: number) => {
          const idx = idToIndexMap.get(anchorItemId);
          if (idx === undefined || !positions[idx]) {
            return null;
          }
          return positions[idx].top;
        },
        restoreReady,
        // 数据增长时触发重试恢复，解决 infinite scroll 内容高度不足的截断
        itemCount: items.length,
        // 占位数据期间锁死恢复
        isPlaceholderData,
        // 长效 Pending：编程式加载更多数据（替代 DOM 操控）
        onLoadMore: onEndReached,
        hasMore,
        // 原子定位：通过 gridRef.scrollToItem 一次性恢复位置
        gridRef: internalGridRef,
      });

    // ── Marquee selection state ────────────────────────────────────
    const [marquee, setMarquee] = useState<{
      startX: number;
      startY: number;
      x: number;
      y: number;
    } | null>(null);
    const marqueeStartScroll = useRef(0);

    const headerPositionsRef = useRef(headerPositions);
    headerPositionsRef.current = headerPositions;

    const HEADER_HEIGHT = 36;

    const handleScroll = useCallback(() => {
      if (rafRef.current) {
        return;
      }
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = 0;
        const el = scrollRef.current;
        if (el) {
          // Velocity tracking (px per animation frame)
          const dy = Math.abs(el.scrollTop - prevScrollYRef.current);
          velocityRef.current = dy;
          prevScrollYRef.current = el.scrollTop;

          setScrollTop(el.scrollTop);
          setViewportHeight(el.clientHeight);
          setShowScrollTop(el.scrollTop > el.clientHeight * 2);
          setIsScrolling(true);
          if (scrollTimerRef.current) {
            clearTimeout(scrollTimerRef.current);
          }
          scrollTimerRef.current = setTimeout(() => setIsScrolling(false), 600);
          const headers = headerPositionsRef.current;
          let nextLabel = "";
          if (headers.length > 0) {
            for (let i = headers.length - 1; i >= 0; i--) {
              if (headers[i].top <= el.scrollTop + 100) {
                nextLabel = headers[i].label;
                break;
              }
            }
            if (!nextLabel) {
              nextLabel = headers[0]?.label || "";
            }
          }
          setCurrentTimeLabel((prev) =>
            prev === nextLabel ? prev : nextLabel
          );

          // ── 速度感知预加载 ─────────────────────────────────────
          // Sentinel 穿透兜底：距底部 2000px 以内且未在加载中时主动触发
          const PRELOAD_MARGIN = 2000;
          const FAST_SCROLL_THRESHOLD = 60;
          const nearBottom =
            el.scrollTop + el.clientHeight + PRELOAD_MARGIN >= el.scrollHeight;
          if (
            nearBottom &&
            onEndReachedRef.current &&
            hasMoreRef.current &&
            !isLoadingMoreRef.current
          ) {
            const now = Date.now();
            const effectiveDebounce =
              dy > FAST_SCROLL_THRESHOLD
                ? END_REACHED_DEBOUNCE_MS / 4
                : END_REACHED_DEBOUNCE_MS;
            if (now - lastEndReachedRef.current > effectiveDebounce) {
              lastEndReachedRef.current = now;
              onEndReachedRef.current();
            }
          }
        }
      });
    }, []);

    // Sync viewportHeight before paint to avoid blank waterfall on cold start
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el && el.clientHeight > 0) {
        setViewportHeight(el.clientHeight);
      }
    }, []);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      el.addEventListener("scroll", handleScroll, { passive: true });
      return () => el.removeEventListener("scroll", handleScroll);
    }, [handleScroll]);

    useEffect(() => {
      return () => {
        if (rafRef.current) {
          cancelAnimationFrame(rafRef.current);
          rafRef.current = 0;
        }
        if (scrollTimerRef.current) {
          clearTimeout(scrollTimerRef.current);
          scrollTimerRef.current = null;
        }
      };
    }, []);

    // ── 用户绝对主权熔断 ─────────────────────────────────────────
    // 任何用户手动操作（滚轮/触摸/键盘）立刻砸碎所有锁。
    // 废弃 { once: true }：持久监听，每次交互均触发 forceUnlock。
    // 锁已清除后 forceUnlock 本质是 no-op，开销可忽略。
    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }

      const handleUserIntervention = () => {
        if (enforceLockRef.current) {
          enforceLockRef.current = null;
        }
        forceUnlock();
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
    }, [forceUnlock, scrollRef]);

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const observer = new ResizeObserver(() => {
        setViewportHeight(el.clientHeight);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

    // ── Sentinel Observer ────────────────────────────────────────────
    // rootMargin: 1000px 让预加载在距视口还很远时就开始；
    // 配合 scroll handler 中的速度感知兜底，高速滚动时也能提前触发
    const sentinelActive = !!onEndReached && totalHeight > 0;

    useEffect(() => {
      const sentinel = sentinelRef.current;
      if (!sentinel) {
        return;
      }

      const observer = new IntersectionObserver(
        ([entry]) => {
          if (entry.isIntersecting) {
            const now = Date.now();
            if (now - lastEndReachedRef.current > END_REACHED_DEBOUNCE_MS) {
              lastEndReachedRef.current = now;
              onEndReached!();
            }
          }
        },
        { root: scrollRef.current, rootMargin: "1000px" }
      );
      observer.observe(sentinel);
      return () => observer.disconnect();
    }, [sentinelActive]);

    // ── 锚点调整：仅处理同路由内容器宽度变化（窗口 resize 等） ──
    // 路由切换时的恢复由 useRouteScrollRestoration + 蛮牛锁全权管理。
    // 此 effect 的唯一合法触发条件：containerWidth 实质性变化。
    // 无限滚动（items 增长 / positions 重算）绝不触发——彻底消灭
    // "fetchNextPage 导致 scrollTop 被拽回旧锚点" 的渲染震荡回归 Bug。
    const prevPositionsRef = useRef(positions);
    const prevScrollToIdRef = useRef(scrollToId);
    const prevRouteKeyRef = useRef(routeKey);
    const prevContainerWidthRef = useRef(containerWidth);

    useLayoutEffect(() => {
      const prevPositions = prevPositionsRef.current;
      const prevScrollToId = prevScrollToIdRef.current;
      const prevRouteKey = prevRouteKeyRef.current;
      const prevWidth = prevContainerWidthRef.current;
      prevPositionsRef.current = positions;
      prevScrollToIdRef.current = scrollToId;
      prevRouteKeyRef.current = routeKey;
      prevContainerWidthRef.current = containerWidth;

      if (positions.length === 0) {
        return;
      }
      const el = scrollRef.current;
      if (!el) {
        return;
      }

      // 路由切换 → 由 useRouteScrollRestoration 管理，此处跳过
      if (prevRouteKey !== routeKey) {
        return;
      }

      const positionsChanged = positions !== prevPositions;
      const scrollToIdChanged = scrollToId !== prevScrollToId;
      const widthChanged =
        containerWidth !== prevWidth && containerWidth > 0 && prevWidth > 0;

      // ── 场景 1: scrollToId 导航 ──────────────────────────────
      if (scrollToId != null) {
        const shouldScroll =
          scrollToIdChanged || (positionsChanged && widthChanged);
        if (shouldScroll) {
          const idx = idToIndexMap.get(scrollToId);
          if (idx !== undefined && positions[idx]) {
            const pos = positions[idx];
            const itemTop = pos.top;
            const itemBottom = pos.top + pos.height;
            const viewTop = el.scrollTop;
            const viewBottom = el.scrollTop + el.clientHeight;
            if (itemTop < viewTop || itemBottom > viewBottom) {
              el.scrollTop = Math.max(
                0,
                itemTop - (el.clientHeight - pos.height) / 2
              );
            }
          }
        }
        return;
      }

      // ── 场景 2: 布局稳定（仅当容器宽度实质性变化时） ────────
      // 严格门闩：非宽度变化 → 跳过（屏蔽 fetchNextPage 等引发的
      // positions 重算对 scrollTop 的任何干扰）
      if (!widthChanged) {
        return;
      }
      if (!positionsChanged || prevPositions.length === 0) {
        return;
      }

      const currentScrollTop = el.scrollTop;
      if (currentScrollTop <= 0) {
        return;
      }

      // 找到旧布局中视口顶部的元素，保持其在视口中的位置
      let anchorIdx = -1;
      let anchorOffset = 0;
      for (let i = 0; i < prevPositions.length; i++) {
        const p = prevPositions[i];
        if (p.top + p.height > currentScrollTop) {
          anchorIdx = i;
          anchorOffset = p.top - currentScrollTop;
          break;
        }
      }
      if (anchorIdx < 0 || !positions[anchorIdx]) {
        return;
      }

      const newTop = positions[anchorIdx].top - anchorOffset;
      if (Math.abs(newTop - currentScrollTop) > 1) {
        el.scrollTop = Math.max(0, newTop);
      }
    }, [positions, scrollToId, routeKey, containerWidth, idToIndexMap]);

    // ── Overscan 计算 ──────────────────────────────────────────────
    const overscanPx = useMemo(() => {
      if (positions.length === 0) {
        return 400;
      }
      if (positions.length <= columnCount * 10) {
        const avgHeight =
          positions.reduce((sum, p) => sum + p.height, 0) / positions.length;
        return avgHeight * overscan;
      }
      const sampleSize = columnCount * 6;
      const step = Math.floor(positions.length / sampleSize);
      let sum = 0;
      let count = 0;
      for (let i = 0; i < positions.length; i += step) {
        sum += positions[i].height;
        count++;
      }
      return (sum / count) * overscan;
    }, [positions, overscan, columnCount]);

    // ── 速度感知 Overscan 倍增 ────────────────────────────────────
    // 问题：快速滚动时 overscan(3×平均高度 ≈ 600px) 不足以覆盖单帧
    // 跨度（可达 2000+ px），导致可视区边缘出现空白。
    // 方案：读取 velocityRef（与 scrollTop 在同一 RAF 回调中更新），
    // 高速时动态扩大缓冲区。velocityRef 是 ref 而非 state，
    // 不触发额外渲染——visibleItems 依赖 scrollTop (state)，
    // RAF 中 setScrollTop 保证 useMemo 拿到最新 velocity。
    const FAST_SCROLL_VELOCITY = 60;
    const VELOCITY_OVERSCAN_MULTIPLIER = 3;
    const velocityOverscanPx =
      velocityRef.current > FAST_SCROLL_VELOCITY
        ? overscanPx * VELOCITY_OVERSCAN_MULTIPLIER
        : overscanPx;

    // ── 可见元素计算 ──────────────────────────────────────────────
    // 关键：hasInitialPositionedRef 控制 initialScrollTop 的使用时机。
    // - 首次定位（刚挂载或 routeKey 切换）：使用 initialScrollTop（包含
    //   render 阶段预读的保存位置或显式 0）。
    // - 定位完成后：使用 DOM scrollTop（用户实时滚动位置）。
    const visibleItems = useMemo(() => {
      if (positions.length === 0) {
        return [];
      }

      const effectiveScrollTop = hasInitialPositionedRef.current
        ? (scrollRef.current?.scrollTop ?? scrollTop)
        : initialScrollTop;

      const effectiveHeight =
        viewportHeight > 0
          ? viewportHeight
          : (scrollRef.current?.clientHeight ?? 0);
      const top = effectiveScrollTop - velocityOverscanPx;
      const bottom = effectiveScrollTop + effectiveHeight + velocityOverscanPx;

      const startIdx = Math.max(
        0,
        binarySearchStart(positions, top) - columnCount
      );
      const result: Array<{ index: number; style: React.CSSProperties }> = [];

      for (let i = startIdx; i < positions.length; i++) {
        const pos = positions[i];
        if (pos.top > bottom) {
          break;
        }
        if (pos.top + pos.height >= top) {
          result.push({
            index: i,
            style: {
              position: "absolute",
              top: pos.top,
              left: pos.left,
              width: pos.width,
              height: pos.height,
            },
          });
        }
      }

      return result;
    }, [
      positions,
      scrollTop,
      viewportHeight,
      overscanPx,
      columnCount,
      initialScrollTop,
      hasInitialPositionedRef,
    ]);

    const visibleHeaders = useMemo(() => {
      if (headerPositions.length === 0) {
        return [];
      }
      const effectiveHeight =
        viewportHeight > 0
          ? viewportHeight
          : (scrollRef.current?.clientHeight ?? 0);
      const top = scrollTop - overscanPx;
      const bottom = scrollTop + effectiveHeight + overscanPx;
      return headerPositions.filter(
        (h) => h.top + HEADER_HEIGHT >= top && h.top <= bottom
      );
    }, [headerPositions, scrollTop, viewportHeight, overscanPx]);

    // ── Marquee selection handlers ─────────────────────────────────
    const handleMarqueeStart = useCallback(
      (e: React.MouseEvent) => {
        if (!onMarqueeSelect) {
          return;
        }
        if (e.button !== 0) {
          return;
        }
        // Only start marquee on empty space (not on a photo card)
        const target = e.target as HTMLElement;
        if (target.closest("[data-photo-id]")) {
          return;
        }

        const scrollEl = scrollRef.current;
        if (!scrollEl) {
          return;
        }
        const rect = scrollEl.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top + scrollEl.scrollTop;
        marqueeStartScroll.current = scrollEl.scrollTop;
        setMarquee({ startX: x, startY: y, x, y });
      },
      [onMarqueeSelect]
    );

    useEffect(() => {
      if (!(marquee && onMarqueeSelect)) {
        return;
      }
      const scrollEl = scrollRef.current;
      if (!scrollEl) {
        return;
      }

      function handleMouseMove(e: MouseEvent) {
        const rect = scrollEl!.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top + scrollEl!.scrollTop;
        setMarquee((prev) => (prev ? { ...prev, x, y } : null));
      }

      function handleMouseUp() {
        if (!marquee) {
          return;
        }
        const minX = Math.min(marquee.startX, marquee.x);
        const maxX = Math.max(marquee.startX, marquee.x);
        const minY = Math.min(marquee.startY, marquee.y);
        const maxY = Math.max(marquee.startY, marquee.y);

        // Only select if drag was meaningful (> 5px)
        if (maxX - minX > 5 && maxY - minY > 5) {
          const selected = new Set<number>();
          for (let i = 0; i < positions.length; i++) {
            const pos = positions[i];
            const itemRight = pos.left + pos.width;
            const itemBottom = pos.top + pos.height;
            if (
              pos.left < maxX &&
              itemRight > minX &&
              pos.top < maxY &&
              itemBottom > minY
            ) {
              selected.add(items[i].id);
            }
          }
          onMarqueeSelect!(selected);
        }
        setMarquee(null);
      }

      window.addEventListener("mousemove", handleMouseMove);
      window.addEventListener("mouseup", handleMouseUp);
      return () => {
        window.removeEventListener("mousemove", handleMouseMove);
        window.removeEventListener("mouseup", handleMouseUp);
      };
    }, [marquee, positions, items, onMarqueeSelect]);

    const scrollToTop = () => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const distance = el.scrollTop;
      el.scrollTo({
        top: 0,
        behavior: distance > el.clientHeight * 4 ? "auto" : "smooth",
      });
    };

    const layoutReady = containerWidth > 0 && columnCount > 0;

    // ── 底部骨架屏：isFetchingNextPage 时在列表底部显示占位卡片 ──
    const SKELETON_ASPECTS = [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3];
    const bottomSkeletons = useMemo(() => {
      if (!(isLoadingMore && layoutReady) || positions.length === 0) {
        return [];
      }
      const colBottoms = new Array(columnCount).fill(0);
      for (
        let i = Math.max(0, positions.length - columnCount * 3);
        i < positions.length;
        i++
      ) {
        const pos = positions[i];
        const colIdx = Math.round(
          pos.left / ((containerWidth - (columnCount - 1) * gap) / columnCount)
        );
        const c = Math.max(0, Math.min(columnCount - 1, colIdx));
        if (pos.top + pos.height > colBottoms[c]) {
          colBottoms[c] = pos.top + pos.height;
        }
      }
      const baseTop = Math.max(...colBottoms) + gap;
      const colWidth = (containerWidth - (columnCount - 1) * gap) / columnCount;
      return Array.from({ length: columnCount }, (_, i) => {
        const skelHeight =
          colWidth / SKELETON_ASPECTS[i % SKELETON_ASPECTS.length];
        return {
          index: i,
          style: {
            position: "absolute" as const,
            top: baseTop,
            left: i * (colWidth + gap),
            width: colWidth,
            height: skelHeight,
          },
        };
      });
    }, [
      isLoadingMore,
      layoutReady,
      positions,
      columnCount,
      containerWidth,
      gap,
    ]);

    return (
      <div className="relative" style={{ height: "100%", overflow: "hidden" }}>
        <div
          className={className}
          data-masonry-scroll=""
          onMouseDown={handleMarqueeStart}
          ref={scrollRef}
          style={{ height: "100%", overflowY: "auto" }}
        >
          {layoutReady && (
            <div
              style={{
                position: "relative",
                height: totalHeight,
                width: "100%",
              }}
            >
              {visibleHeaders.map((h) => (
                <div
                  className="flex cursor-pointer items-end px-1 pb-1 font-[510] text-[12px] text-muted-foreground"
                  key={h.label}
                  onClick={() => {
                    scrollRef.current?.scrollTo({
                      top: Math.max(0, h.top - 16),
                      behavior: "smooth",
                    });
                  }}
                  onMouseDown={(e) => e.stopPropagation()}
                  style={{
                    position: "absolute",
                    top: h.top,
                    left: 0,
                    width: "100%",
                    height: HEADER_HEIGHT,
                  }}
                >
                  {h.label}
                </div>
              ))}
              {visibleItems.map(({ index, style }) => (
                <div key={items[index].id} style={style}>
                  {renderItem(items[index], index, style)}
                </div>
              ))}
              {/* 底部加载骨架屏 — 仅在 isFetchingNextPage 时渲染 */}
              {bottomSkeletons.map((sk) => (
                <div key={`skel-${sk.index}`} style={sk.style}>
                  <div
                    className="w-full animate-shimmer rounded-[8px] bg-muted"
                    style={{ height: sk.style.height }}
                  />
                </div>
              ))}
              {onEndReached && totalHeight > 0 && (
                <div
                  ref={sentinelRef}
                  style={{
                    position: "absolute",
                    top: Math.max(0, totalHeight - 200),
                    left: 0,
                    width: 1,
                    height: 1,
                    pointerEvents: "none",
                  }}
                />
              )}
              {marquee && (
                <div
                  className="pointer-events-none absolute z-30 rounded-[2px] border border-primary/60 bg-primary/10"
                  style={{
                    left: Math.min(marquee.startX, marquee.x),
                    top: Math.min(marquee.startY, marquee.y),
                    width: Math.abs(marquee.x - marquee.startX),
                    height: Math.abs(marquee.y - marquee.startY),
                  }}
                />
              )}
            </div>
          )}
        </div>
        <button
          aria-hidden={!showScrollTop}
          aria-label={t("backToTop")}
          className={`absolute right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full bg-popover/90 text-muted-foreground shadow-lg ring-1 ring-border backdrop-blur-sm transition-all duration-200 hover:bg-popover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 ${
            selectionActive ? "bottom-16" : "bottom-4"
          } ${
            showScrollTop
              ? "scale-100 opacity-100"
              : "pointer-events-none scale-75 opacity-0"
          }`}
          onClick={scrollToTop}
          tabIndex={showScrollTop ? 0 : -1}
        >
          <svg
            fill="none"
            height="16"
            stroke="currentColor"
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth="2"
            viewBox="0 0 16 16"
            width="16"
          >
            <path d="M8 12V4M4 7l4-4 4 4" />
          </svg>
        </button>
        {isScrolling && currentTimeLabel && headerPositions.length > 1 && (
          <div className="pointer-events-none absolute top-3 right-4 z-40 rounded-[6px] bg-popover/90 px-3 py-1.5 font-[510] text-[12px] text-foreground shadow-lg ring-1 ring-border backdrop-blur-sm">
            {currentTimeLabel}
          </div>
        )}
      </div>
    );
  }
);
