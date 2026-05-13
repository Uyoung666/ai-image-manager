import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useMasonryLayout } from "@/hooks/useMasonryLayout";

export interface GroupHeader {
  beforeIndex: number;
  label: string;
}

interface MasonryGridProps {
  items: Array<{ id: number; width: number; height: number; [key: string]: any }>;
  containerWidth: number;
  columnCount: number;
  gap: number;
  groupHeaders?: GroupHeader[];
  overscan?: number;
  renderItem: (item: any, index: number, style: React.CSSProperties) => ReactNode;
  onEndReached?: () => void;
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
  className,
}: MasonryGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const { positions: rawPositions, totalHeight: rawTotalHeight } = useMasonryLayout(
    items,
    containerWidth,
    columnCount,
    gap,
  );

  const HEADER_HEIGHT = 36;

  const { positions, totalHeight, headerPositions } = useMemo(() => {
    if (!groupHeaders || groupHeaders.length === 0) {
      return { positions: rawPositions, totalHeight: rawTotalHeight, headerPositions: [] };
    }

    const sortedHeaders = [...groupHeaders].sort((a, b) => a.beforeIndex - b.beforeIndex);
    const headerSpace = HEADER_HEIGHT + gap;
    const adjusted = rawPositions.map((p) => ({ ...p }));
    const hdrPos: Array<{ top: number; label: string }> = [];

    for (const header of sortedHeaders) {
      const idx = header.beforeIndex;
      if (idx >= adjusted.length) continue;

      const headerTop = adjusted[idx].top;
      hdrPos.push({ top: headerTop, label: header.label });

      for (let i = idx; i < adjusted.length; i++) {
        adjusted[i].top += headerSpace;
      }
    }

    const newTotalHeight = rawTotalHeight + sortedHeaders.length * headerSpace;
    return { positions: adjusted, totalHeight: newTotalHeight, headerPositions: hdrPos };
  }, [rawPositions, rawTotalHeight, groupHeaders, gap]);

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
    return <div className={className} ref={scrollRef} style={{ height: "100%", overflowY: "auto" }} />;
  }

  return (
    <div
      className={className}
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
