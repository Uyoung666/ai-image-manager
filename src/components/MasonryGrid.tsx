import {
  type ReactNode,
  useCallback,
  useEffect,
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

export type { GroupHeaderInput as GroupHeader };

interface MasonryGridProps {
  className?: string;
  columnCount: number;
  containerWidth: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
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
  scrollToId?: number | null;
  /**
   * When true, the floating "back to top" button is pushed above the
   * SelectionActionBar (which overlays at bottom-2 with ~46px height).
   */
  selectionActive?: boolean;
}

function binarySearchStart(
  positions: Array<{ top: number; height: number }>,
  threshold: number
): number {
  let lo = 0;
  let hi = positions.length - 1;
  let result = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (positions[mid].top + positions[mid].height < threshold) {
      lo = mid + 1;
      result = lo;
    } else {
      hi = mid - 1;
    }
  }
  return result;
}

export function MasonryGrid({
  items,
  containerWidth,
  columnCount,
  gap,
  groupHeaders,
  overscan = 5,
  renderItem,
  onEndReached,
  onMarqueeSelect,
  scrollToId,
  className,
  selectionActive = false,
}: MasonryGridProps) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  const [showScrollTop, setShowScrollTop] = useState(false);
  const [isScrolling, setIsScrolling] = useState(false);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Marquee selection state
  const [marquee, setMarquee] = useState<{
    startX: number;
    startY: number;
    x: number;
    y: number;
  } | null>(null);
  const marqueeStartScroll = useRef(0);
  const hasRenderedRef = useRef(false);

  const { positions, totalHeight, headerPositions } = useMasonryLayout(
    items,
    containerWidth,
    columnCount,
    gap,
    groupHeaders
  );

  const HEADER_HEIGHT = 36;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
      setShowScrollTop(el.scrollTop > el.clientHeight * 2);
      setIsScrolling(true);
      if (scrollTimerRef.current) {
        clearTimeout(scrollTimerRef.current);
      }
      scrollTimerRef.current = setTimeout(() => setIsScrolling(false), 1200);
    }
  }, []);

  // Sync viewportHeight before paint to avoid blank waterfall on cold start
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && el.clientHeight > 0 && viewportHeight !== el.clientHeight) {
      setViewportHeight(el.clientHeight);
    }
  });

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) {
      return;
    }
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

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

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!(sentinel && onEndReached)) {
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onEndReached();
        }
      },
      { root: scrollRef.current, rootMargin: "200px" }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onEndReached, totalHeight]);

  // Anchor-based scroll preservation: when layout changes, keep the same
  // item at the same visual position in the viewport.
  const prevPositionsRef = useRef(positions);
  const prevScrollToIdRef = useRef(scrollToId);
  const prevItemCountRef = useRef(items.length);

  useLayoutEffect(() => {
    const prevPositions = prevPositionsRef.current;
    const prevScrollToId = prevScrollToIdRef.current;
    const prevItemCount = prevItemCountRef.current;
    prevPositionsRef.current = positions;
    prevScrollToIdRef.current = scrollToId;
    prevItemCountRef.current = items.length;

    if (positions.length === 0) {
      return;
    }
    const el = scrollRef.current;
    if (!el) {
      return;
    }

    const positionsChanged = positions !== prevPositions;
    const scrollToIdChanged = scrollToId !== prevScrollToId;

    if (scrollToId != null) {
      // Scroll to selected photo when:
      //   1) user just selected it (scrollToIdChanged), or
      //   2) layout recalculated from container resize (positionsChanged
      //      without new items — detail panel, window resize).
      // Skip when items grew (infinite scroll) so we don't yank the user
      // back to the selected photo while they're browsing.
      const shouldScroll =
        scrollToIdChanged ||
        (positionsChanged && items.length <= prevItemCount);
      if (shouldScroll) {
        const idx = items.findIndex((item) => item.id === scrollToId);
        if (idx >= 0 && positions[idx]) {
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

    if (!positionsChanged || prevPositions.length === 0) {
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
  }, [positions, scrollToId, items]);

  const overscanPx = useMemo(() => {
    if (positions.length === 0) {
      return 400;
    }
    const avgHeight =
      positions.reduce((sum, p) => sum + p.height, 0) / positions.length;
    return avgHeight * overscan;
  }, [positions, overscan]);

  const visibleItems = useMemo(() => {
    if (positions.length === 0) {
      return [];
    }

    const effectiveHeight =
      viewportHeight > 0
        ? viewportHeight
        : (scrollRef.current?.clientHeight ?? 0);
    const top = scrollTop - overscanPx;
    const bottom = scrollTop + effectiveHeight + overscanPx;

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
  }, [positions, scrollTop, viewportHeight, overscanPx, columnCount]);

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

  useEffect(() => {
    if (visibleItems.length > 0 && !hasRenderedRef.current) {
      const timer = setTimeout(() => {
        hasRenderedRef.current = true;
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [visibleItems.length]);

  const currentTimeLabel = useMemo(() => {
    if (headerPositions.length === 0) {
      return "";
    }
    let label = "";
    for (let i = headerPositions.length - 1; i >= 0; i--) {
      if (headerPositions[i].top <= scrollTop + 100) {
        label = headerPositions[i].label;
        break;
      }
    }
    return label || headerPositions[0]?.label || "";
  }, [headerPositions, scrollTop]);

  // Marquee selection handlers
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
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  };

  const layoutReady = containerWidth > 0 && columnCount > 0;

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
            style={{ position: "relative", height: totalHeight, width: "100%" }}
          >
            {visibleHeaders.map((h) => (
              <div
                className="flex items-end px-1 pb-1 font-[510] text-[12px] text-muted-foreground"
                key={h.label}
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
            {visibleItems.map(({ index, style }, vi) => {
              const shouldAnimate =
                !hasRenderedRef.current && vi < columnCount * 4;
              return (
                <div
                  className={shouldAnimate ? "animate-card-enter" : undefined}
                  key={items[index].id}
                  style={
                    shouldAnimate
                      ? { ...style, animationDelay: `${vi * 30}ms` }
                      : style
                  }
                >
                  {renderItem(items[index], index, style)}
                </div>
              );
            })}
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
      {showScrollTop && (
        <button
          aria-label={t("backToTop")}
          className={`absolute right-4 z-40 flex h-9 w-9 items-center justify-center rounded-full bg-popover/90 text-muted-foreground shadow-lg ring-1 ring-border backdrop-blur-sm transition-all hover:bg-popover hover:text-foreground ${
            selectionActive ? "bottom-16" : "bottom-4"
          }`}
          onClick={scrollToTop}
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
      )}
      {isScrolling && currentTimeLabel && headerPositions.length > 1 && (
        <div className="pointer-events-none absolute top-3 right-4 z-40 rounded-[6px] bg-popover/90 px-3 py-1.5 font-[510] text-[12px] text-foreground shadow-lg ring-1 ring-border backdrop-blur-sm">
          {currentTimeLabel}
        </div>
      )}
    </div>
  );
}
