import {
  forwardRef,
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import {
  type GroupHeaderInput,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";
import {
  type MasonryGridHandle,
  useMasonryAnchor,
} from "@/hooks/useMasonryAnchor";
import { useMasonryEndReached } from "@/hooks/useMasonryEndReached";
import { useMasonryMarquee } from "@/hooks/useMasonryMarquee";
import {
  HEADER_HEIGHT,
  useMasonryVirtualWindow,
} from "@/hooks/useMasonryVirtualWindow";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { recordGalleryPerf } from "@/utils/gallery-perf";
import { binarySearchStart } from "@/utils/masonry-utils";

export type { GroupHeaderInput as GroupHeader };
export type { MasonryGridHandle };

const SCROLL_TOP_EPSILON = 0.5;

interface MasonryGridProps {
  className?: string;
  columnCount: number;
  containerWidth: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
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
  routeKey: string;
  scrollToId?: number | null;
  selectionActive?: boolean;
}

export const MasonryGrid = memo(
  forwardRef<MasonryGridHandle, MasonryGridProps>(function MasonryGrid(
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
    const [scrollVelocity, setScrollVelocity] = useState(0);
    const scrollTopStateRef = useRef(0);
    const viewportHeightStateRef = useRef(0);
    const showScrollTopStateRef = useRef(false);
    const isScrollingStateRef = useRef(false);
    const currentTimeLabelRef = useRef("");
    const scrollVelocityRef = useRef(0);
    const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafRef = useRef<number>(0);
    const prevScrollYRef = useRef(0);
    const routeForceUnlockRef = useRef<(() => void) | null>(null);

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

    const { getCurrentAnchor, gridRef } = useMasonryAnchor({
      containerWidth,
      forwardedRef: ref,
      forceUnlockRef: routeForceUnlockRef,
      idToIndexMap,
      items,
      positions,
      scrollRef,
    });

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
        itemCount: items.length,
        isPlaceholderData,
        onLoadMore: onEndReached,
        hasMore,
        gridRef,
      });

    useEffect(() => {
      routeForceUnlockRef.current = forceUnlock;
    }, [forceUnlock]);

    const { checkNearBottom } = useMasonryEndReached({
      hasMore,
      isLoadingMore,
      onEndReached,
      scrollRef,
      sentinelRef,
      totalHeight,
    });

    const { handleMarqueeStart, marquee } = useMasonryMarquee({
      columnCount,
      items,
      onMarqueeSelect,
      positions,
      scrollRef,
    });

    const headerPositionsRef = useRef(headerPositions);
    headerPositionsRef.current = headerPositions;

    const handleScroll = useCallback(() => {
      if (rafRef.current) {
        return;
      }
      rafRef.current = requestAnimationFrame(() => {
        const frameStart = performance.now();
        rafRef.current = 0;
        const el = scrollRef.current;
        if (!el) {
          return;
        }

        const dy = Math.abs(el.scrollTop - prevScrollYRef.current);
        prevScrollYRef.current = el.scrollTop;
        if (Math.abs(dy - scrollVelocityRef.current) > SCROLL_TOP_EPSILON) {
          scrollVelocityRef.current = dy;
          setScrollVelocity(dy);
        }

        if (
          Math.abs(el.scrollTop - scrollTopStateRef.current) >
          SCROLL_TOP_EPSILON
        ) {
          scrollTopStateRef.current = el.scrollTop;
          setScrollTop(el.scrollTop);
        }
        if (el.clientHeight !== viewportHeightStateRef.current) {
          viewportHeightStateRef.current = el.clientHeight;
          setViewportHeight(el.clientHeight);
        }

        const nextShowScrollTop = el.scrollTop > el.clientHeight * 2;
        if (nextShowScrollTop !== showScrollTopStateRef.current) {
          showScrollTopStateRef.current = nextShowScrollTop;
          setShowScrollTop(nextShowScrollTop);
        }
        if (!isScrollingStateRef.current) {
          isScrollingStateRef.current = true;
          setIsScrolling(true);
        }
        if (scrollTimerRef.current) {
          clearTimeout(scrollTimerRef.current);
        }
        scrollTimerRef.current = setTimeout(() => {
          isScrollingStateRef.current = false;
          setIsScrolling(false);
        }, 600);

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
        if (currentTimeLabelRef.current !== nextLabel) {
          currentTimeLabelRef.current = nextLabel;
          setCurrentTimeLabel(nextLabel);
        }

        checkNearBottom(dy);
        recordGalleryPerf(
          "masonryScrollFrameMs",
          performance.now() - frameStart
        );
      });
    }, [checkNearBottom]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el && el.clientHeight > 0) {
        viewportHeightStateRef.current = el.clientHeight;
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

    useEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const observer = new ResizeObserver(() => {
        if (el.clientHeight !== viewportHeightStateRef.current) {
          viewportHeightStateRef.current = el.clientHeight;
          setViewportHeight(el.clientHeight);
        }
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, []);

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
      if (!el || prevRouteKey !== routeKey) {
        return;
      }

      const positionsChanged = positions !== prevPositions;
      const scrollToIdChanged = scrollToId !== prevScrollToId;
      const widthChanged =
        containerWidth !== prevWidth && containerWidth > 0 && prevWidth > 0;

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

      if (!(widthChanged && positionsChanged && prevPositions.length > 0)) {
        return;
      }

      const currentScrollTop = el.scrollTop;
      if (currentScrollTop <= 0) {
        return;
      }

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

    const { visibleHeaders, visibleItems } = useMasonryVirtualWindow({
      columnCount,
      hasInitialPositionedRef,
      headerPositions,
      initialScrollTop,
      overscan,
      positions,
      scrollRef,
      scrollTop,
      velocity: scrollVelocity,
      viewportHeight,
    });

    const scrollToTop = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const distance = el.scrollTop;
      el.scrollTo({
        top: 0,
        behavior: distance > el.clientHeight * 4 ? "auto" : "smooth",
      });
    }, []);

    const layoutReady = containerWidth > 0 && columnCount > 0;
    const bottomSkeletons = useMemo(() => {
      const skeletonAspects = [3 / 4, 4 / 3, 1 / 1, 3 / 2, 2 / 3];
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
        const skelHeight = colWidth / skeletonAspects[i % skeletonAspects.length];
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
          style={{ height: "100%", overflowY: "auto", overflowX: "hidden" }}
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
                  className="flex cursor-pointer items-end px-1 pb-1 font-medium text-[12px] text-muted-foreground"
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
        <MasonryBackToTop
          label={t("backToTop")}
          onClick={scrollToTop}
          selectionActive={selectionActive}
          show={showScrollTop}
        />
        {isScrolling && currentTimeLabel && headerPositions.length > 1 && (
          <div className="glass-surface pointer-events-none absolute top-10 right-4 z-40 rounded-[6px] px-3 py-1.5 font-medium text-[12px] text-foreground shadow-lg ring-1 ring-border">
            {currentTimeLabel}
          </div>
        )}
      </div>
    );
  }),
  (prevProps, nextProps) => {
  if (prevProps.items !== nextProps.items) return false;
  if (prevProps.groupHeaders !== nextProps.groupHeaders) return false;
  if (prevProps.containerWidth !== nextProps.containerWidth) return false;
  if (prevProps.columnCount !== nextProps.columnCount) return false;
  if (prevProps.gap !== nextProps.gap) return false;
  if (prevProps.isLoadingMore !== nextProps.isLoadingMore) return false;
  if (prevProps.hasMore !== nextProps.hasMore) return false;
  if (prevProps.isPlaceholderData !== nextProps.isPlaceholderData) return false;
  if (prevProps.selectionActive !== nextProps.selectionActive) return false;
  if (prevProps.scrollToId !== nextProps.scrollToId) return false;
  if (prevProps.routeKey !== nextProps.routeKey) return false;
    return true;
  }
);
