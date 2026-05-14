import {
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { type GroupHeaderInput, useMasonryLayout } from "@/hooks/useMasonryLayout";

export type { GroupHeaderInput as GroupHeader };

interface MasonryGridProps {
  items: Array<{ id: number; width: number; height: number; [key: string]: any }>;
  containerWidth: number;
  columnCount: number;
  gap: number;
  groupHeaders?: GroupHeaderInput[];
  overscan?: number;
  renderItem: (item: any, index: number, style: React.CSSProperties) => ReactNode;
  onEndReached?: () => void;
  scrollToId?: number | null;
  className?: string;
}

function binarySearchStart(
  positions: Array<{ top: number; height: number }>,
  threshold: number,
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
  scrollToId,
  className,
}: MasonryGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const { positions, totalHeight, headerPositions } = useMasonryLayout(
    items,
    containerWidth,
    columnCount,
    gap,
    groupHeaders,
  );

  const HEADER_HEIGHT = 36;

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (el) {
      setScrollTop(el.scrollTop);
      setViewportHeight(el.clientHeight);
    }
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportHeight(el.clientHeight);
    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => el.removeEventListener("scroll", handleScroll);
  }, [handleScroll]);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !onEndReached) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          onEndReached();
        }
      },
      { root: scrollRef.current, rootMargin: "200px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [onEndReached, totalHeight]);

  // Anchor-based scroll preservation: when layout changes, keep the same
  // item at the same visual position in the viewport.
  const prevPositionsRef = useRef(positions);
  const prevScrollToIdRef = useRef(scrollToId);

  useLayoutEffect(() => {
    const prevPositions = prevPositionsRef.current;
    const prevScrollToId = prevScrollToIdRef.current;
    prevPositionsRef.current = positions;
    prevScrollToIdRef.current = scrollToId;

    if (positions.length === 0) return;
    const el = scrollRef.current;
    if (!el) return;

    const positionsChanged = positions !== prevPositions;
    const scrollToIdChanged = scrollToId !== prevScrollToId;

    // Case 1: scrollToId is set and either it changed or layout changed
    if (scrollToId != null && (scrollToIdChanged || positionsChanged)) {
      const idx = items.findIndex((item) => item.id === scrollToId);
      if (idx >= 0 && positions[idx]) {
        const pos = positions[idx];
        const itemTop = pos.top;
        const itemBottom = pos.top + pos.height;
        const viewTop = el.scrollTop;
        const viewBottom = el.scrollTop + el.clientHeight;
        if (itemTop < viewTop || itemBottom > viewBottom) {
          el.scrollTop = Math.max(0, itemTop - (el.clientHeight - pos.height) / 2);
        }
      }
      return;
    }

    // Case 2: layout changed without a scroll target — anchor-based preservation
    if (!positionsChanged || prevPositions.length === 0) return;
    const currentScrollTop = el.scrollTop;
    if (currentScrollTop <= 0) return;

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
    if (anchorIdx < 0 || !positions[anchorIdx]) return;

    const newTop = positions[anchorIdx].top - anchorOffset;
    if (Math.abs(newTop - currentScrollTop) > 1) {
      el.scrollTop = Math.max(0, newTop);
    }
  }, [positions, scrollToId, items]);

  const overscanPx = useMemo(() => {
    if (positions.length === 0) return 400;
    const avgHeight =
      positions.reduce((sum, p) => sum + p.height, 0) / positions.length;
    return avgHeight * overscan;
  }, [positions, overscan]);

  const visibleItems = useMemo(() => {
    if (positions.length === 0) return [];

    const top = scrollTop - overscanPx;
    const bottom = scrollTop + viewportHeight + overscanPx;

    const startIdx = Math.max(0, binarySearchStart(positions, top) - columnCount);
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
    if (headerPositions.length === 0) return [];
    const top = scrollTop - overscanPx;
    const bottom = scrollTop + viewportHeight + overscanPx;
    return headerPositions.filter(
      (h) => h.top + HEADER_HEIGHT >= top && h.top <= bottom,
    );
  }, [headerPositions, scrollTop, viewportHeight, overscanPx]);

  if (containerWidth <= 0) {
    return <div className={className} data-masonry-scroll="" ref={scrollRef} style={{ height: "100%", overflowY: "auto" }} />;
  }

  return (
    <div
      className={className}
      data-masonry-scroll=""
      ref={scrollRef}
      style={{ height: "100%", overflowY: "auto" }}
    >
      <div style={{ position: "relative", height: totalHeight, width: "100%" }}>
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
        {visibleItems.map(({ index, style }) => (
          <div key={items[index].id} style={style}>
            {renderItem(items[index], index, style)}
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
      </div>
    </div>
  );
}
