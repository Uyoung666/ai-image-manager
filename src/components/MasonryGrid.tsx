// biome-ignore-all lint/a11y/useKeyWithClickEvents: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/complexity/noExcessiveCognitiveComplexity: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noStaticElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/a11y/noNoninteractiveElementInteractions: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/style/noExportedImports: scoped component lint cleanup preserves existing UI behavior
// biome-ignore-all lint/suspicious/noExplicitAny: scoped component lint cleanup preserves existing UI behavior
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
import { isReducedMotionEnabled } from "@/actions/ui-preferences";
import { MasonryBackToTop } from "@/components/MasonryBackToTop";
import {
  type MasonryGridHandle,
  useMasonryAnchor,
} from "@/hooks/useMasonryAnchor";
import { useMasonryEndReached } from "@/hooks/useMasonryEndReached";
import {
  type GroupHeaderInput,
  useMasonryLayout,
} from "@/hooks/useMasonryLayout";
import { useMasonryMarquee } from "@/hooks/useMasonryMarquee";
import {
  getVelocityOverscanMultiplier,
  HEADER_HEIGHT,
  useMasonryVirtualWindow,
} from "@/hooks/useMasonryVirtualWindow";
import { useRouteScrollRestoration } from "@/hooks/useRouteScrollRestoration";
import { recordGalleryPerf } from "@/utils/gallery-perf";

export type { GroupHeaderInput as GroupHeader, MasonryGridHandle };

const SCROLL_TOP_EPSILON = 0.5;
const SCROLL_RENDER_STEP_PX = 96;
const IMAGE_RENDER_OVERSCAN_VIEWPORTS_BEFORE = 1;
const IMAGE_RENDER_OVERSCAN_VIEWPORTS_AFTER = 2;
const MIN_SCROLLBAR_THUMB_HEIGHT = 24;

export function shouldRenderItemImage(
  style: React.CSSProperties,
  scrollTop: number,
  viewportHeight: number
): boolean {
  if (viewportHeight <= 0) {
    return true;
  }
  const itemTop = Number(style.top) || 0;
  const itemHeight = Number(style.height) || 0;
  const imageTop =
    scrollTop - viewportHeight * IMAGE_RENDER_OVERSCAN_VIEWPORTS_BEFORE;
  const imageBottom =
    scrollTop + viewportHeight * IMAGE_RENDER_OVERSCAN_VIEWPORTS_AFTER;
  return itemTop + itemHeight >= imageTop && itemTop <= imageBottom;
}

export function shouldUpdateScrollRenderTop(
  currentScrollTop: number,
  renderedScrollTop: number
): boolean {
  return (
    Math.abs(currentScrollTop - renderedScrollTop) >= SCROLL_RENDER_STEP_PX
  );
}

interface MasonryGridProps {
  className?: string;
  columnCount: number;
  containerWidth: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
  hasMore?: boolean;
  isLoadingMore?: boolean;
  isPlaceholderData?: boolean;
  itemStateVersion?: unknown;
  items: Array<{
    fullWidth?: boolean;
    id: number;
    width: number;
    height: number;
    [key: string]: any;
  }>;
  onEndReached?: () => void;
  onMarqueeSelect?: (ids: Set<number>) => void;
  onRestoreSettled?: (routeKey: string) => void;
  onScrollTopChange?: (scrollTop: number) => void;
  overscan?: number;
  renderItem: (
    item: any,
    index: number,
    style: React.CSSProperties,
    options: { renderImage: boolean }
  ) => ReactNode;
  restoreGateReady?: boolean;
  routeKey: string;
  scrollToAlignment?: "center" | "start";
  scrollToId?: number | null;
  selectionActive?: boolean;
  showGroupHeaders?: boolean;
  topInset?: number;
}

export const MasonryGrid = memo(
  forwardRef<MasonryGridHandle, MasonryGridProps>(function MasonryGrid(
    {
      items,
      containerWidth,
      columnCount,
      gap,
      groupHeaders,
      overscan = 5,
      renderItem,
      onEndReached,
      hasMore = false,
      isLoadingMore = false,
      onMarqueeSelect,
      onRestoreSettled,
      onScrollTopChange,
      scrollToAlignment = "center",
      scrollToId,
      className,
      selectionActive = false,
      showGroupHeaders = true,
      routeKey,
      restoreGateReady = true,
      isPlaceholderData = false,
      topInset = 0,
    }: MasonryGridProps,
    ref
  ) {
    const { t } = useTranslation();
    const scrollRef = useRef<HTMLDivElement>(null);
    const sentinelRef = useRef<HTMLDivElement>(null);
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportHeight, setViewportHeight] = useState(0);
    const [scrollHeight, setScrollHeight] = useState(0);
    const [showScrollTop, setShowScrollTop] = useState(false);
    const [isScrolling, setIsScrolling] = useState(false);
    const [currentTimeLabel, setCurrentTimeLabel] = useState("");
    const [scrollVelocity, setScrollVelocity] = useState(0);
    const scrollTopStateRef = useRef(0);
    const viewportHeightStateRef = useRef(0);
    const scrollHeightStateRef = useRef(0);
    const showScrollTopStateRef = useRef(false);
    const isScrollingStateRef = useRef(false);
    const currentTimeLabelRef = useRef("");
    const scrollVelocityRef = useRef(0);
    const scrollOverscanMultiplierRef = useRef(1);
    const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const rafRef = useRef<number>(0);
    const prevScrollYRef = useRef(0);
    const routeForceUnlockRef = useRef<(() => void) | null>(null);
    const scrollbarThumbRef = useRef<HTMLDivElement>(null);
    const scrollbarDragRef = useRef<{
      pointerId: number;
      startY: number;
      startScrollTop: number;
      travel: number;
    } | null>(null);

    const { positions, totalHeight, headerPositions, visibilityIndex } =
      useMasonryLayout(
        items,
        containerWidth,
        columnCount,
        gap,
        groupHeaders,
        routeKey,
        showGroupHeaders
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
      visibilityIndex,
    });

    const restoreReady =
      positions.length > 0 && !isPlaceholderData && restoreGateReady;
    const getRouteKey = useCallback(() => routeKey, [routeKey]);
    const restoreFromAnchor = useCallback(
      (anchorItemId: number) => {
        const idx = idToIndexMap.get(anchorItemId);
        if (idx === undefined || !positions[idx]) {
          return null;
        }
        return positions[idx].top;
      },
      [idToIndexMap, positions]
    );
    const { initialScrollTop, hasInitialPositionedRef, forceUnlock } =
      useRouteScrollRestoration(scrollRef, {
        getRouteKey,
        getCurrentAnchor,
        restoreFromAnchor,
        restoreReady,
        itemCount: items.length,
        isPlaceholderData,
        onLoadMore: onEndReached,
        hasMore,
        gridRef,
        onRestoreSettled,
      });

    useEffect(() => {
      routeForceUnlockRef.current = forceUnlock;
    }, [forceUnlock]);

    const { checkNearBottom } = useMasonryEndReached({
      containerWidth,
      hasMore,
      isLoadingMore,
      onEndReached,
      scrollRef,
      sentinelRef,
      totalHeight,
    });

    const { handleMarqueeStart, marquee } = useMasonryMarquee({
      items,
      onMarqueeSelect,
      positions,
      scrollRef,
      visibilityIndex,
    });

    const headerPositionsRef = useRef(headerPositions);
    headerPositionsRef.current = headerPositions;

    const syncScrollMetrics = useCallback((el: HTMLDivElement) => {
      if (el.clientHeight !== viewportHeightStateRef.current) {
        viewportHeightStateRef.current = el.clientHeight;
        setViewportHeight(el.clientHeight);
      }
      if (el.scrollHeight !== scrollHeightStateRef.current) {
        scrollHeightStateRef.current = el.scrollHeight;
        setScrollHeight(el.scrollHeight);
      }
    }, []);

    const updateScrollbarThumbPosition = useCallback(
      (el: HTMLDivElement) => {
        const thumb = scrollbarThumbRef.current;
        if (!thumb) {
          return;
        }
        const trackHeight = Math.max(0, el.clientHeight - topInset);
        const scrollRange = Math.max(0, el.scrollHeight - el.clientHeight);
        if (trackHeight <= 0 || scrollRange <= 0) {
          thumb.style.display = "none";
          return;
        }
        const thumbHeight = Math.min(
          trackHeight,
          Math.max(
            MIN_SCROLLBAR_THUMB_HEIGHT,
            (trackHeight * el.clientHeight) / el.scrollHeight
          )
        );
        const travel = Math.max(0, trackHeight - thumbHeight);
        const offset = travel > 0 ? (el.scrollTop / scrollRange) * travel : 0;
        thumb.style.display = "block";
        thumb.style.height = `${thumbHeight}px`;
        thumb.style.transform = `translateY(${offset}px)`;
      },
      [topInset]
    );

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
        onScrollTopChange?.(el.scrollTop);
        prevScrollYRef.current = el.scrollTop;
        const nextOverscanMultiplier = getVelocityOverscanMultiplier(dy);
        if (nextOverscanMultiplier !== scrollOverscanMultiplierRef.current) {
          scrollOverscanMultiplierRef.current = nextOverscanMultiplier;
          scrollVelocityRef.current = dy;
          setScrollVelocity(dy);
        }

        if (
          shouldUpdateScrollRenderTop(el.scrollTop, scrollTopStateRef.current)
        ) {
          scrollTopStateRef.current = el.scrollTop;
          setScrollTop(el.scrollTop);
          recordGalleryPerf("masonryScrollRenderTopUpdates", 1);
        }
        syncScrollMetrics(el);
        updateScrollbarThumbPosition(el);

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
          if (scrollOverscanMultiplierRef.current !== 1) {
            scrollOverscanMultiplierRef.current = 1;
            scrollVelocityRef.current = 0;
            setScrollVelocity(0);
          }
          const latest =
            scrollRef.current?.scrollTop ?? scrollTopStateRef.current;
          if (
            Math.abs(latest - scrollTopStateRef.current) > SCROLL_TOP_EPSILON
          ) {
            scrollTopStateRef.current = latest;
            setScrollTop(latest);
            recordGalleryPerf("masonryScrollRenderTopUpdates", 1);
          }
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
    }, [
      checkNearBottom,
      onScrollTopChange,
      syncScrollMetrics,
      updateScrollbarThumbPosition,
    ]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el && el.clientHeight > 0) {
        syncScrollMetrics(el);
      }
    }, [syncScrollMetrics]);

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
        syncScrollMetrics(el);
      });
      observer.observe(el);
      return () => observer.disconnect();
    }, [syncScrollMetrics]);

    const prevPositionsRef = useRef(positions);
    const prevScrollToAlignmentRef = useRef(scrollToAlignment);
    const prevScrollToIdRef = useRef(scrollToId);
    const prevRouteKeyRef = useRef(routeKey);
    const prevContainerWidthRef = useRef(containerWidth);

    useLayoutEffect(() => {
      const prevPositions = prevPositionsRef.current;
      const prevScrollToAlignment = prevScrollToAlignmentRef.current;
      const prevScrollToId = prevScrollToIdRef.current;
      const prevRouteKey = prevRouteKeyRef.current;
      const prevWidth = prevContainerWidthRef.current;
      prevPositionsRef.current = positions;
      prevScrollToAlignmentRef.current = scrollToAlignment;
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
      const scrollToAlignmentChanged =
        scrollToAlignment !== prevScrollToAlignment;
      const widthChanged =
        containerWidth !== prevWidth && containerWidth > 0 && prevWidth > 0;

      const syncScrollTopBeforePaint = (nextScrollTop: number) => {
        const next = Math.max(0, nextScrollTop);
        el.scrollTop = next;
        prevScrollYRef.current = next;
        scrollTopStateRef.current = next;
        setScrollTop(next);
      };

      // A selection change can open the detail panel and resize the grid in
      // the same frame. Resolve the requested item against the final positions
      // before preserving the previous width anchor, otherwise the resize
      // branch consumes the one-shot scroll request.
      if (
        scrollToId != null &&
        (scrollToIdChanged || scrollToAlignmentChanged)
      ) {
        const idx = idToIndexMap.get(scrollToId);
        if (idx !== undefined && positions[idx]) {
          const pos = positions[idx];
          const itemTop = pos.top;
          const itemBottom = pos.top + pos.height;
          const viewTop = el.scrollTop;
          const viewBottom = el.scrollTop + el.clientHeight;
          if (itemTop < viewTop || itemBottom > viewBottom) {
            syncScrollTopBeforePaint(
              scrollToAlignment === "start"
                ? itemTop
                : itemTop - (el.clientHeight - pos.height) / 2
            );
          }
        }
        return;
      }

      if (widthChanged && positionsChanged && prevPositions.length > 0) {
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
          syncScrollTopBeforePaint(newTop);
        }
        return;
      }
    }, [
      positions,
      scrollToAlignment,
      scrollToId,
      routeKey,
      containerWidth,
      idToIndexMap,
    ]);

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
      visibilityIndex,
      viewportHeight,
    });

    useEffect(() => {
      let renderImageCount = 0;
      for (const { style } of visibleItems) {
        if (shouldRenderItemImage(style, scrollTop, viewportHeight)) {
          renderImageCount++;
        }
      }
      recordGalleryPerf("masonryImageItems", renderImageCount);
    }, [visibleItems, scrollTop, viewportHeight]);

    const scrollToTop = useCallback((e: React.MouseEvent) => {
      e.stopPropagation();
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      const distance = el.scrollTop;
      el.scrollTo({
        top: 0,
        behavior:
          isReducedMotionEnabled() || distance > el.clientHeight * 4
            ? "auto"
            : "smooth",
      });
    }, []);

    const layoutReady = containerWidth > 0 && columnCount > 0;
    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (!el) {
        return;
      }
      syncScrollMetrics(el);
      updateScrollbarThumbPosition(el);
    }, [syncScrollMetrics, updateScrollbarThumbPosition]);

    useLayoutEffect(() => {
      const el = scrollRef.current;
      if (el) {
        updateScrollbarThumbPosition(el);
      }
    }, [updateScrollbarThumbPosition]);

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
        const skelHeight =
          colWidth / skeletonAspects[i % skeletonAspects.length];
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

    const scrollbarTrackHeight = Math.max(0, viewportHeight - topInset);
    const scrollbarThumbHeight =
      scrollHeight > viewportHeight && scrollbarTrackHeight > 0
        ? Math.min(
            scrollbarTrackHeight,
            Math.max(
              MIN_SCROLLBAR_THUMB_HEIGHT,
              (scrollbarTrackHeight * viewportHeight) / scrollHeight
            )
          )
        : 0;
    const scrollbarTravel = Math.max(
      0,
      scrollbarTrackHeight - scrollbarThumbHeight
    );
    const showCustomScrollbar =
      scrollbarThumbHeight > 0 && scrollHeight > viewportHeight;

    const handleScrollbarThumbPointerDown = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const el = scrollRef.current;
        if (!el || scrollbarTravel <= 0) {
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        event.currentTarget.setPointerCapture(event.pointerId);
        scrollbarDragRef.current = {
          pointerId: event.pointerId,
          startScrollTop: el.scrollTop,
          startY: event.clientY,
          travel: scrollbarTravel,
        };
      },
      [scrollbarTravel]
    );

    const handleScrollbarThumbPointerMove = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        const drag = scrollbarDragRef.current;
        const el = scrollRef.current;
        if (!drag || drag.pointerId !== event.pointerId || !el) {
          return;
        }
        event.preventDefault();
        const scrollRange = Math.max(0, el.scrollHeight - el.clientHeight);
        const nextScrollTop = Math.max(
          0,
          Math.min(
            scrollRange,
            drag.startScrollTop +
              ((event.clientY - drag.startY) / drag.travel) * scrollRange
          )
        );
        el.scrollTop = nextScrollTop;
      },
      []
    );

    const finishScrollbarDrag = useCallback(
      (event: React.PointerEvent<HTMLDivElement>) => {
        if (scrollbarDragRef.current?.pointerId === event.pointerId) {
          scrollbarDragRef.current = null;
          if (event.currentTarget.hasPointerCapture(event.pointerId)) {
            event.currentTarget.releasePointerCapture(event.pointerId);
          }
        }
      },
      []
    );

    return (
      <div className="relative" style={{ height: "100%", overflow: "hidden" }}>
        <div
          className={className}
          data-masonry-scroll=""
          onMouseDown={handleMarqueeStart}
          ref={scrollRef}
          style={
            {
              height: "100%",
              overflowX: "hidden",
              overflowY: "auto",
              paddingTop: topInset > 0 ? topInset + 8 : undefined,
            } as React.CSSProperties
          }
        >
          {layoutReady && (
            <div
              style={{
                position: "relative",
                height: totalHeight,
                width: "100%",
              }}
            >
              {showGroupHeaders &&
                visibleHeaders.map((h) => (
                  <div
                    className="flex cursor-pointer items-end px-1 pb-1 font-medium text-[12px] text-muted-foreground"
                    key={h.label}
                    onClick={() => {
                      scrollRef.current?.scrollTo({
                        top: Math.max(0, h.top - 16),
                        behavior: isReducedMotionEnabled() ? "auto" : "smooth",
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
                  {renderItem(items[index], index, style, {
                    renderImage: shouldRenderItemImage(
                      style,
                      scrollTop,
                      viewportHeight
                    ),
                  })}
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
        {showCustomScrollbar && (
          <div
            aria-hidden="true"
            className="masonry-scrollbar"
            style={{ top: topInset }}
          >
            <div className="masonry-scrollbar-track" />
            <div
              className="masonry-scrollbar-thumb"
              onPointerCancel={finishScrollbarDrag}
              onPointerDown={handleScrollbarThumbPointerDown}
              onPointerMove={handleScrollbarThumbPointerMove}
              onPointerUp={finishScrollbarDrag}
              ref={scrollbarThumbRef}
            />
          </div>
        )}
        <MasonryBackToTop
          label={t("backToTop")}
          onClick={scrollToTop}
          selectionActive={selectionActive}
          show={showScrollTop}
        />
        {isScrolling && currentTimeLabel && headerPositions.length > 0 && (
          <div
            className="glass-surface pointer-events-none absolute right-4 z-20 rounded-[6px] px-3 py-1.5 font-medium text-[12px] text-foreground shadow-lg ring-1 ring-border"
            style={{ top: topInset + 8 }}
          >
            {currentTimeLabel}
          </div>
        )}
      </div>
    );
  }),
  (prevProps, nextProps) =>
    prevProps.items === nextProps.items &&
    prevProps.groupHeaders === nextProps.groupHeaders &&
    prevProps.containerWidth === nextProps.containerWidth &&
    prevProps.columnCount === nextProps.columnCount &&
    prevProps.gap === nextProps.gap &&
    prevProps.isLoadingMore === nextProps.isLoadingMore &&
    prevProps.hasMore === nextProps.hasMore &&
    prevProps.isPlaceholderData === nextProps.isPlaceholderData &&
    prevProps.itemStateVersion === nextProps.itemStateVersion &&
    prevProps.selectionActive === nextProps.selectionActive &&
    prevProps.scrollToId === nextProps.scrollToId &&
    prevProps.onScrollTopChange === nextProps.onScrollTopChange &&
    prevProps.onRestoreSettled === nextProps.onRestoreSettled &&
    prevProps.topInset === nextProps.topInset &&
    prevProps.showGroupHeaders === nextProps.showGroupHeaders &&
    prevProps.routeKey === nextProps.routeKey &&
    prevProps.restoreGateReady === nextProps.restoreGateReady
);
